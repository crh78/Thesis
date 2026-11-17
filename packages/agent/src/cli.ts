// Talk to the agent from a terminal, no iMessage needed:
//   pnpm --filter @thesis/agent chat "nuclear is the only way to power AI"
//   pnpm --filter @thesis/agent chat --group "lol jake thinks gold is going to 5k"
// Reads the same env as apps/imessage (.env there).
import { basketConfigFromEnv, createAgent } from "./index.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const args = process.argv.slice(2);
const group = args[0] === "--group";
const text = (group ? args.slice(1) : args).join(" ");
if (!text) throw new Error("usage: chat [--group] <message>");

const agent = createAgent({
  openaiApiKey: env("OPENAI_API_KEY"),
  model: process.env.OPENAI_AGENT_MODEL || undefined,
  basket: basketConfigFromEnv(),
  log: (e, f) => console.error(`· ${e}`, f ?? ""),
});

const t0 = Date.now();
const reply = await agent.respond({ chatId: "cli", chatType: group ? "group" : "dm", sender: "…cli", text });
console.log(reply ?? "(stays quiet)");
console.error(`· ${Date.now() - t0} ms`);
