// Thesis chat agent, independent of transport. One OpenAI Responses call per
// inbound message (Luna, low reasoning effort), with tools for the actions a
// chat can take. Today: build_basket. Later: back / fade / receipts.
import OpenAI from "openai";
import { basketTool, buildBasket, warmBasket, HORIZONS, RISKS, type BasketArgs, type BasketConfig } from "./basket.ts";
import { cleanReply } from "./style.ts";

export type { BasketConfig, BasketResult, DraftMeta } from "./basket.ts";
export { basketConfigFromEnv, buildBasket, plainName, warmBasket } from "./basket.ts";
export { cleanReply } from "./style.ts";

export type Turn = {
  chatId: string;
  chatType: "dm" | "group";
  /** Short stable alias for who sent it, e.g. "…1919". */
  sender: string | null;
  text: string;
};

export type AgentConfig = {
  openaiApiKey: string;
  /** Default gpt-6-luna. */
  model?: string;
  effort?: "none" | "low" | "medium" | "high";
  basket: BasketConfig;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** What the model says when a group message isn't for it. */
const SILENT = "NO_REPLY";
const MAX_TOOL_ROUNDS = 3;

const INSTRUCTIONS = [
  "You are Thesis, an assistant inside iMessage DMs and group chats for Thesis, a social trading app.",
  "On Thesis a take is a plain-language opinion about the world or markets (\"AI power demand is underrated\").",
  "Thesis turns a take into a basket of 1-5 real investments; friends can back it or fade it.",
  "When someone states a take, asks what to buy for an idea, or asks you to make one into a basket, call build_basket.",
  "Only call it for an opinion about the world, a company or a market. Plans, logistics, jokes, greetings and small talk are not takes: don't call it.",
  "Use the take in their own words. Risk and horizon: use what they said, else medium and 3 months. Don't ask first.",
  "After build_basket: one line (max 12 words) on what has to be true, then each pick on its own line as `Name 40%: why` with the why in 6 words or fewer, then the link on its own line, exactly as given.",
  "If there's no clean exposure, say so in one line with the reason. Never invent picks, prices or returns.",
  "Be brief. Most replies are one or two short sentences. Answer only what was asked, no preamble, no recap, no follow-up offers.",
  "Explain simply, like to a smart friend who doesn't invest: plain words, no jargon. If asked who you are or what you do, one sentence.",
  "Write like a friend texting: lowercase is fine, no markdown, no bullet symbols, no emoji walls.",
  "Never use em dashes or en dashes. Use commas, colons or periods instead.",
  "Never mention tokens, chains, USDC, crypto plumbing or wallets. Don't claim anything was bought or posted: the link is a draft, and whoever opens it can post it as their take and buy in.",
  `In a group chat you see every message, prefixed with who sent it. Reply only if you're addressed (thesis, @thesis), asked something, or someone states a take worth a basket. Otherwise reply exactly ${SILENT}.`,
  "In a DM always reply.",
].join(" ");

type FnCall = { type: "function_call"; call_id: string; name: string; arguments: string };

export function createAgent(cfg: AgentConfig) {
  const client = new OpenAI({ apiKey: cfg.openaiApiKey });
  const model = cfg.model ?? "gpt-6-luna";
  const effort = cfg.effort ?? "low";
  const log = cfg.log ?? (() => {});
  /** Conversation memory per chat, kept server-side by the Responses API. */
  const last = new Map<string, string>();

  async function create(input: unknown, previous: string | undefined) {
    return client.responses.create({
      model,
      instructions: INSTRUCTIONS,
      input: input as never,
      tools: [basketTool],
      reasoning: { effort },
      truncation: "auto",
      ...(previous ? { previous_response_id: previous } : {}),
    } as never) as Promise<OpenAI.Responses.Response>;
  }

  async function runTool(call: FnCall, links: string[], turn: Turn): Promise<string> {
    if (call.name !== "build_basket") return JSON.stringify({ error: `unknown tool ${call.name}` });
    let args: BasketArgs;
    try {
      const raw = JSON.parse(call.arguments) as Partial<BasketArgs>;
      args = {
        claim: String(raw.claim ?? ""),
        risk: RISKS.includes(raw.risk as never) ? raw.risk! : "medium",
        horizon: HORIZONS.includes(raw.horizon as never) ? raw.horizon! : "3 months",
      };
    } catch {
      return JSON.stringify({ error: "bad arguments" });
    }
    const t0 = Date.now();
    const meta = { origin: "imessage" as const, context: turn.chatType === "group" ? "From a group chat" : "From iMessage" };
    const out = await buildBasket(cfg.basket, args, meta).catch((e: Error) => ({ verdict: "error" as const, reason: e.message }));
    log("tool build_basket", { verdict: out.verdict, legs: out.verdict === "basket" ? out.legs.length : 0, ms: Date.now() - t0 });
    if (out.verdict === "basket") links.push(out.link);
    return JSON.stringify(out);
  }

  return {
    /** Warm the take builder so the first basket isn't a cold start. */
    warm: () => warmBasket(cfg.basket),

    /** Reply text, or null to stay quiet. */
    async respond(turn: Turn): Promise<string | null> {
      const text = turn.chatType === "group" ? `[group] ${turn.sender ?? "someone"}: ${turn.text}` : turn.text;
      const links: string[] = [];
      let res: OpenAI.Responses.Response;
      try {
        res = await create([{ role: "user", content: text }], last.get(turn.chatId));
      } catch (e) {
        // Stored context can expire or break; start the chat over once.
        if (!last.has(turn.chatId)) throw e;
        log("agent context reset", { error: (e as Error).message });
        last.delete(turn.chatId);
        res = await create([{ role: "user", content: text }], undefined);
      }

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const calls = res.output.filter((o): o is FnCall & typeof o => o.type === "function_call") as unknown as FnCall[];
        if (calls.length === 0) break;
        const outputs = await Promise.all(
          calls.map(async (c) => ({ type: "function_call_output", call_id: c.call_id, output: await runTool(c, links, turn) })),
        );
        res = await create(outputs, res.id);
      }
      last.set(turn.chatId, res.id);

      let reply = cleanReply(res.output_text ?? "");
      if (!reply || reply.startsWith(SILENT)) return null;
      // The link is the point of a basket reply; never let the model drop it.
      for (const link of links) if (!reply.includes(link)) reply += `\n${link}`;
      return reply;
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
