// @yourthesisxyz: answers everyone who mentions it on X. Polls the bot's mentions, vets each one
// (vet.ts), builds the take's basket as a draft (the same take builder and drafts as iMessage),
// and replies with the draft's link, where whoever taps posts it as their take.
import { basketConfigFromEnv } from "@thesis/agent";
import { plan } from "./bot.ts";
import { loadState, rollDay, saveState } from "./state.ts";
import { vetter } from "./vet.ts";
import { fullText, xClient, XError, type Mentions, type XPost } from "./x.ts";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

function need(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. Copy apps/x/.env.example to apps/x/.env and fill it in (apps/x/README.md).`);
    process.exit(1);
  }
  return v;
}
const num = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

const DRY_RUN = process.env.X_DRY_RUN === "1";
const POLL_MS = num("X_POLL_SECONDS", 30) * 1000;
const MAX_PER_DAY = num("X_MAX_REPLIES_PER_DAY", 100);
const MAX_PER_AUTHOR = num("X_MAX_PER_AUTHOR", 10);
const MAX_PER_THREAD = num("X_MAX_PER_THREAD", 3);
const STATE_FILE = process.env.X_STATE_FILE || new URL("../.data/state.json", import.meta.url).pathname;

const x = xClient({
  consumerKey: need("X_CONSUMER_KEY"),
  consumerSecret: need("X_CONSUMER_SECRET"),
  accessToken: need("X_ACCESS_TOKEN"),
  accessSecret: need("X_ACCESS_SECRET"),
});
const vet = vetter({ openaiApiKey: need("OPENAI_API_KEY"), model: process.env.OPENAI_AGENT_MODEL || undefined });
let basket: ReturnType<typeof basketConfigFromEnv>;
try {
  basket = basketConfigFromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

/** "@yourthesisxyz @jake make this a take" → "make this a take": X prepends the handles of a reply. */
const stripHandles = (s: string) => s.replace(/^(\s*@\w+)+\s*/, "").trim();

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const me = await x.me().catch((e) => {
  console.error("Couldn't reach X as the bot:", (e as Error).message);
  console.error("Check X_CONSUMER_KEY / SECRET and X_ACCESS_TOKEN / SECRET (apps/x/README.md).");
  process.exit(1);
});
const state = loadState(STATE_FILE);
saveState(STATE_FILE, state);
log("starting", { as: `@${me.username}`, dryRun: DRY_RUN, pollSec: POLL_MS / 1000, maxPerDay: MAX_PER_DAY, sinceId: state.sinceId });

/** Handles one mention. Returns false to stop the batch and retry it next poll (X or the model is down). */
async function handle(p: XPost, batch: Mentions): Promise<boolean> {
  const author = batch.users.get(p.author_id);
  const ref = p.referenced_tweets?.find((r) => r.type === "replied_to") ?? p.referenced_tweets?.find((r) => r.type === "quoted");
  const parentPost = ref ? batch.refs.get(ref.id) ?? null : null;
  const parentAuthor = parentPost ? batch.users.get(parentPost.author_id) : undefined;
  const base = { id: p.id, from: author ? `@${author.username}` : p.author_id, followers: author?.public_metrics?.followers_count };

  if (p.author_id === me.id || p.referenced_tweets?.some((r) => r.type === "retweeted")) return true;
  const thread = p.conversation_id ?? p.id;
  if (state.replies >= MAX_PER_DAY) { log("skip", { ...base, reason: "daily reply cap" }); return true; }
  if ((state.byAuthor[p.author_id] ?? 0) >= MAX_PER_AUTHOR) { log("skip", { ...base, reason: "author cap" }); return true; }
  if ((state.byConversation[thread] ?? 0) >= MAX_PER_THREAD) { log("skip", { ...base, reason: "thread cap" }); return true; }

  const text = stripHandles(fullText(p));
  if (!text && !parentPost) { log("skip", { ...base, reason: "empty" }); return true; }

  let out;
  try {
    out = await plan({
      id: p.id,
      text,
      author: { username: author?.username ?? "someone", followers: author?.public_metrics?.followers_count ?? null },
      parent: parentPost && parentAuthor ? { text: fullText(parentPost), username: parentAuthor.username } : null,
      parentUrl: parentPost && parentAuthor ? `https://x.com/${parentAuthor.username}/status/${parentPost.id}` : null,
      toBot: parentPost?.author_id === me.id,
    }, { vet, basket });
  } catch (e) {
    log("plan failed, retrying next poll", { ...base, error: (e as Error).message });
    return false;
  }
  if (out.kind === "skip") { log("skip", { ...base, reason: out.reason }); return true; }

  if (DRY_RUN) {
    log("would reply", { ...base, what: out.what, text: out.text });
  } else {
    try {
      const replyId = await x.reply(p.id, out.text);
      log("replied", { ...base, what: out.what, replyId, link: out.link });
    } catch (e) {
      if (e instanceof XError && e.status < 500 && e.status !== 429) {
        log("reply refused", { ...base, status: e.status, error: e.body.slice(0, 200) });
        return true;
      }
      log("reply failed, retrying next poll", { ...base, error: (e as Error).message });
      return false;
    }
  }
  state.replies++;
  state.byAuthor[p.author_id] = (state.byAuthor[p.author_id] ?? 0) + 1;
  state.byConversation[thread] = (state.byConversation[thread] ?? 0) + 1;
  return true;
}

while (!stopping) {
  rollDay(state);
  try {
    // Before the first mention: everything since the bot first ran, so an old backlog is never answered.
    const batch = await x.mentions(me.id, state.sinceId ? { sinceId: state.sinceId } : { startTime: state.startedAt });
    for (const p of batch.posts) {
      if (stopping) break;
      if (!(await handle(p, batch))) break;
      state.sinceId = p.id;
      saveState(STATE_FILE, state);
    }
  } catch (e) {
    log("poll failed", { error: (e as Error).message });
  }
  // Sleep in short steps so Ctrl-C stops promptly.
  for (let waited = 0; waited < POLL_MS && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
}
log("stopped", { sinceId: state.sinceId });
