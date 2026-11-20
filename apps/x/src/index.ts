// @yourthesisxyz: answers everyone who mentions it on X. Polls the bot's mentions, vets each one
// (vet.ts), builds the take's basket as a draft (the same take builder and drafts as iMessage),
// and replies with the draft's link, where whoever taps posts it as their take.
import { agentApi, agentApiConfigFromEnv, basketConfigFromEnv, botEvents, type Recorder } from "@thesis/agent";
import { plan, type Plan } from "./bot.ts";
import { OPTED_IN, OPTED_OUT, optCommand } from "./compose.ts";
import { loadState, memoryOf, rollDay, saveState } from "./state.ts";
import { vetter } from "./vet.ts";
import { fullText, linksIn, xClient, XError, type Mentions, type XPost } from "./x.ts";

// Every event also goes to Supabase (bot_events) so replies can be looked back on; "poll failed"
// at most every 10 minutes, since a dead key would log one every poll.
let recorder: Recorder = botEvents("x", null);
let lastPollFailRecorded = 0;
/** `recordOnly`: kept in telemetry but not printed (the models' traces are long). */
function log(event: string, fields: Record<string, unknown> = {}, recordOnly: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
  if (event === "poll failed") {
    if (Date.now() - lastPollFailRecorded < 10 * 60_000) return;
    lastPollFailRecorded = Date.now();
  }
  const { id, from, ...rest } = fields;
  recorder.record(event, { ref: id, author: from, ...rest, ...recordOnly, ...(DRY_RUN ? { dryRun: true } : {}) });
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
/** X usernames with no reply caps at all (the team's own accounts): X_UNLIMITED="chrisherzog78,other". */
const UNLIMITED = new Set((process.env.X_UNLIMITED ?? "").split(",").map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
// Trading from replies ("back $20"): only when replies really go out, unless X_DRY_RUN_TRADES=1
// (a dry run reads real mentions, and a trade is real), and X_TRADING isn't 0.
const TRADING = process.env.X_TRADING !== "0" && (!DRY_RUN || process.env.X_DRY_RUN_TRADES === "1");
// The basket picture on take replies (the web app draws it); X_IMAGES=0 turns it off.
const IMAGES = process.env.X_IMAGES !== "0";
const STATE_FILE = process.env.X_STATE_FILE || new URL("../.data/state.json", import.meta.url).pathname;

const x = xClient({
  consumerKey: need("X_CONSUMER_KEY"),
  consumerSecret: need("X_CONSUMER_SECRET"),
  accessToken: need("X_ACCESS_TOKEN"),
  accessSecret: need("X_ACCESS_SECRET"),
});
const vet = vetter({ openaiApiKey: need("OPENAI_API_KEY"), model: process.env.OPENAI_AGENT_MODEL || undefined });
const agentCfg = agentApiConfigFromEnv();
const trading = TRADING && agentCfg ? agentApi(agentCfg) : undefined;
// Who has a Thesis account (people who haven't signed up get one reply); read-only, so also in dry runs.
const lookup = agentCfg ? agentApi(agentCfg) : undefined;
let basket: ReturnType<typeof basketConfigFromEnv>;
try {
  basket = basketConfigFromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (process.env.X_TELEMETRY !== "0") {
  recorder = botEvents("x", basket, { onError: (message) => console.log(JSON.stringify({ t: new Date().toISOString(), event: "telemetry error", message })) });
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
const memory = memoryOf(state);
saveState(STATE_FILE, state);
log("starting", { as: `@${me.username}`, dryRun: DRY_RUN, trading: !!trading, pollSec: POLL_MS / 1000, maxPerDay: MAX_PER_DAY, unlimited: [...UNLIMITED], sinceId: state.sinceId });

/** Fetches the basket picture from the web app and uploads it to X: its media id. */
async function basketImage(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok || !type.startsWith("image/")) throw new Error(`image ${r.status} ${type}`);
  return x.uploadImage(new Uint8Array(await r.arrayBuffer()), type.split(";")[0]);
}

/** Handles one mention. Returns false to stop the batch and retry it next poll (X or the model is down). */
async function handle(p: XPost, batch: Mentions): Promise<boolean> {
  const author = batch.users.get(p.author_id);
  const ref = p.referenced_tweets?.find((r) => r.type === "replied_to") ?? p.referenced_tweets?.find((r) => r.type === "quoted");
  const parentPost = ref ? batch.refs.get(ref.id) ?? null : null;
  const parentAuthor = parentPost ? batch.users.get(parentPost.author_id) : undefined;
  const base = {
    id: p.id, from: author ? `@${author.username}` : p.author_id, followers: author?.public_metrics?.followers_count,
    mention: fullText(p).slice(0, 500), parent: parentPost?.id, thread: p.conversation_id,
  };

  if (p.author_id === me.id || p.referenced_tweets?.some((r) => r.type === "retweeted")) return true;
  const thread = p.conversation_id ?? p.id;
  const text = stripHandles(fullText(p));
  // Opt-out (X's automation rules): "stop" is recorded even past the caps; "start" only means
  // something to someone who stopped, and anyone else's "start" is an ordinary mention.
  const wasOut = !!state.optedOut[p.author_id];
  const cmd = optCommand(text);
  if (cmd === "stop") state.optedOut[p.author_id] = true;
  if (cmd === "start" && wasOut) delete state.optedOut[p.author_id];
  if (wasOut && cmd !== "start") { log("skip", { ...base, reason: "opted out" }); return true; }
  const capped = !UNLIMITED.has(author?.username?.toLowerCase() ?? "");
  if (capped && state.replies >= MAX_PER_DAY) { log("skip", { ...base, reason: "daily reply cap" }); return true; }
  if (capped && (state.byAuthor[p.author_id] ?? 0) >= MAX_PER_AUTHOR) { log("skip", { ...base, reason: "author cap" }); return true; }
  if (capped && (state.byConversation[thread] ?? 0) >= MAX_PER_THREAD) { log("skip", { ...base, reason: "thread cap" }); return true; }

  if (!text && !parentPost) { log("skip", { ...base, reason: "empty" }); return true; }

  // Someone without a Thesis account gets one reply (it points to the bio), then no more until they sign up.
  let firstReply = false;
  if (capped && lookup && cmd !== "stop" && !(cmd === "start" && wasOut) && !state.known[p.author_id]) {
    const w = await lookup.whois({ x: p.author_id }).catch(() => null);
    if (w && (w.linked || w.signed_up === true)) state.known[p.author_id] = true;
    else if (w?.signed_up === false) {
      if (state.onceReplied[p.author_id]) { log("skip", { ...base, reason: "not signed up, had their one reply" }); return true; }
      firstReply = true;
    }
  }

  let out: Plan;
  if (cmd === "stop") {
    out = { kind: "reply", text: OPTED_OUT, what: "opt_out" };
  } else if (cmd === "start" && wasOut) {
    out = { kind: "reply", text: OPTED_IN, what: "opt_in" };
  } else try {
    out = await plan({
      id: p.id,
      text,
      author: { username: author?.username ?? "someone", followers: author?.public_metrics?.followers_count ?? null },
      parent: parentPost && parentAuthor ? { text: fullText(parentPost), username: parentAuthor.username } : null,
      parentUrl: parentPost && parentAuthor ? `https://x.com/${parentAuthor.username}/status/${parentPost.id}` : null,
      toBot: parentPost?.author_id === me.id,
      parentId: parentPost?.id ?? null,
      conversationId: thread,
      authorId: p.author_id,
      links: [...linksIn(p), ...(parentPost ? linksIn(parentPost) : [])],
    }, { vet, basket, trading, memory, lookup });
  } catch (e) {
    log("plan failed, retrying next poll", { ...base, error: (e as Error).message });
    return false;
  }
  const traced = out.trace ? { trace: out.trace } : {};
  if (out.kind === "skip") { log("skip", { ...base, reason: out.reason }, traced); return true; }
  const reply = out;
  // What a trade or basket leaves behind is kept whether or not the reply goes out; the bot's own
  // post (for "back $20" or "sell" under it) only once it has an id.
  const keep = (replyId?: string) => {
    const r = reply.remember;
    if (!r) return;
    if (r.held) memory.rememberHeld(p.author_id, thread, r.held);
    if (r.shared) memory.rememberShared(r.shared.parentId, r.shared.side, r.shared.value);
    if (r.post && replyId) memory.rememberPost(replyId, r.post);
  };

  if (DRY_RUN) {
    log("would reply", { ...base, what: out.what, text: out.text, ...(out.image && IMAGES ? { image: out.image } : {}), ...(out.trade ? { trade: out.trade } : {}) }, traced);
  } else {
    try {
      // The picture is a bonus: any failure posts the reply without it.
      const media = out.image && IMAGES ? await basketImage(out.image).catch((e) => { log("image failed", { ...base, error: (e as Error).message.slice(0, 160) }); return null; }) : null;
      const replyId = await x.reply(p.id, out.text, media ? [media] : []);
      log("replied", { ...base, what: out.what, text: out.text, replyId, link: out.link, image: !!media, ...(out.trade ? { trade: out.trade } : {}) }, traced);
      keep(replyId);
      if (firstReply) state.onceReplied[p.author_id] = true;
    } catch (e) {
      if (e instanceof XError && e.status < 500 && e.status !== 429) {
        log("reply refused", { ...base, what: out.what, text: out.text, status: e.status, error: e.body.slice(0, 200) }, traced);
        keep();
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
  await recorder.flush();
  // Sleep in short steps so Ctrl-C stops promptly.
  for (let waited = 0; waited < POLL_MS && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
}
log("stopped", { sinceId: state.sinceId });
await recorder.flush();
