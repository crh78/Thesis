// Talk to the agent from a terminal, no iMessage needed:
//   pnpm --filter @thesis/agent chat "nuclear is the only way to power AI"
//   pnpm --filter @thesis/agent chat --group "lol jake thinks gold is going to 5k"
//   pnpm --filter @thesis/agent chat --as +15555550100 "make this a take for $20: nuclear wins"
// --as trades from the account that iMessage number is connected to (real trades on the fork).
// Reads the same env as apps/imessage (.env there).
import { agentApi, agentApiConfigFromEnv, basketConfigFromEnv, createAgent } from "./index.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const args = process.argv.slice(2);
const asAt = args.indexOf("--as");
const as = asAt >= 0 ? args.splice(asAt, 2)[1] : undefined;
const group = args[0] === "--group";
const text = (group ? args.slice(1) : args).join(" ");
if (!text) throw new Error("usage: chat [--group] [--as <imessage handle>] <message>");
const tradeCfg = as ? agentApiConfigFromEnv() : null;

const agent = createAgent({
  openaiApiKey: env("OPENAI_API_KEY"),
  model: process.env.OPENAI_AGENT_MODEL || undefined,
  basket: basketConfigFromEnv(),
  trading: tradeCfg ? agentApi(tradeCfg) : undefined,
  log: (e, f) => console.error(`· ${e}`, f ?? ""),
});

const t0 = Date.now();
const reply = await agent.respond({ chatId: "cli", chatType: group ? "group" : "dm", sender: as ? `…${as.slice(-4)}` : "…cli", senderId: as, messageId: as ? `cli-${Date.now()}` : undefined, text });
console.log(reply ?? "(stays quiet)");
console.error(`· ${Date.now() - t0} ms`);
