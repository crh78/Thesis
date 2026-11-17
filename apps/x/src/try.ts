// Run one mention through the bot without X: the vetting, a real draft, and the reply it would post.
//   pnpm --filter @thesis/x try "nuclear is the only way to power AI"
//   pnpm --filter @thesis/x try "make this a take" --parent "Gold to 5k by summer" --parent-author goldbug
// Needs OPENAI_API_KEY and the basket env (apps/x/.env); no X keys.
import { basketConfigFromEnv } from "@thesis/agent";
import { plan } from "./bot.ts";
import { xLength } from "./compose.ts";
import { vetter } from "./vet.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? null;
};
const parentText = flag("--parent");
const parentAuthor = flag("--parent-author") ?? "someone";
const author = flag("--author") ?? "tester";
const text = args.join(" ");
if (!text && !parentText) throw new Error('usage: try "<mention>" [--parent "<post>" --parent-author <handle>] [--author <handle>]');
if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const t0 = Date.now();
const out = await plan(
  {
    id: `try-${Date.now()}`,
    text,
    author: { username: author, followers: null },
    parent: parentText ? { text: parentText, username: parentAuthor } : null,
    parentUrl: parentText ? `https://x.com/${parentAuthor}/status/1` : null,
    toBot: false,
  },
  { vet: vetter({ openaiApiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL || undefined }), basket: basketConfigFromEnv() },
);
if (out.kind === "skip") console.log(`(stays quiet: ${out.reason})`);
else console.log(`${out.text}\n\n· ${out.what}, ${xLength(out.text)}/280 chars`);
console.error(`· ${Date.now() - t0} ms`);
