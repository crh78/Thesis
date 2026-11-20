// Thesis chat agent, independent of transport. One OpenAI Responses call per
// inbound message (Luna, low reasoning effort), with tools for the actions a
// chat can take: build_basket, and trades (post, back, fade, sell) that wait for a yes (./confirm.ts).
import OpenAI from "openai";
import { basketTool, buildBasket, warmBasket, RISKS, type BasketArgs, type BasketConfig } from "./basket.ts";
import { cleanReply } from "./style.ts";
import { askText, prepareTrade, runConfirmed, yesNo, type Pending } from "./confirm.ts";
import { TRADE_TOOL_NAMES, tradeTools } from "./tools.ts";
import { takeIdFrom, type AgentApi } from "./trade.ts";

export type { BasketConfig, BasketResult, BuildTrace, DraftMeta } from "./basket.ts";
export { basketConfigFromEnv, buildBasket, plainName, warmBasket } from "./basket.ts";
export { cleanReply } from "./style.ts";
export { botEvents, type Recorder } from "./telemetry.ts";
export { yesNo } from "./confirm.ts";
export { agentApi, agentApiConfigFromEnv, draftIdFrom, takeIdFrom, type AgentApi, type Score, type TradeAsk, type TradeResult, type Who, type WhoIs } from "./trade.ts";

export type Turn = {
  chatId: string;
  chatType: "dm" | "group";
  /** Short stable alias for who sent it, e.g. "…1919". */
  sender: string | null;
  /** The sender's full handle (E.164 or email): whose account a trade uses. Never logged or shown to the model. */
  senderId?: string;
  /** The provider's message id: trades are keyed on it, so a redelivered message never trades twice. */
  messageId?: string;
  /** A tapback rather than text ("like", "love", ...): a like or love confirms a trade waiting for a yes. */
  reaction?: string;
  text: string;
};

export type AgentConfig = {
  openaiApiKey: string;
  /** Default gpt-6-luna. */
  model?: string;
  effort?: "none" | "low" | "medium" | "high";
  basket: BasketConfig;
  /** The agent function (./trade.ts): with it, the agent can trade from the sender's own account. */
  trading?: AgentApi;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** What the model says when a group message isn't for it. */
const SILENT = "NO_REPLY";
const MAX_TOOL_ROUNDS = 4;
/** Drafts and takes remembered per chat, so "Jake's take" or "that one" resolves. */
const RECENT_MAX = 6;

const INSTRUCTIONS = [
  "You are Thesis, an assistant inside iMessage DMs and group chats for Thesis, a social trading app.",
  "On Thesis a take is a plain-language opinion about the world or markets (\"AI power demand is underrated\").",
  "Thesis turns a take into a basket of 1-5 real investments; friends can back it or fade it.",
  "When someone states a take, asks what to buy for an idea, or asks you to make one into a basket, call build_basket.",
  "Only call it for an opinion about the world, a company or a market. Plans, logistics, jokes, greetings and small talk are not takes: don't call it.",
  "Use the take in their own words. Risk: what they said, else medium. Don't ask first. A take has no timeline: it runs until its author sells, so never ask for or mention one.",
  "After build_basket: one line (max 12 words) on what has to be true, then each pick on its own line as `Name 40%: why` with the why in 6 words or fewer, then the link on its own line, exactly as given.",
  "If there's no clean exposure, say so in one line with the reason. Never invent picks, prices or returns.",
  "Be brief. Most replies are one or two short sentences. Answer only what was asked, no preamble, no recap, no follow-up offers.",
  "Explain simply, like to a smart friend who doesn't invest: plain words, no jargon. If asked who you are or what you do, one sentence.",
  "Write like a friend texting: lowercase is fine, no markdown, no bullet symbols, no emoji walls.",
  "Never use em dashes or en dashes. Use commas, colons or periods instead.",
  "Never mention tokens, chains, USDC, crypto plumbing or wallets.",
  `In a group chat you see every message, prefixed with who sent it. Reply only if you're addressed (thesis, @thesis), asked something, or someone states a take worth a basket. Otherwise reply exactly ${SILENT}.`,
  "In a DM always reply.",
].join(" ");

const TRADING = [
  "You can also trade for the person who sent the message, from their own Thesis account, within limits they set: post_take, back_take, fade_take, sell_position, my_positions.",
  "Trade only when the sender clearly asks to and, for buys, says a dollar amount (at least $10). If the amount or the take is unclear, ask in one line. Never trade for anyone but the sender.",
  "\"Make this a take for $20\" or \"I'm in for $20\" on a basket that isn't posted: build_basket if needed, then post_take with its draft_id. That posts it as their take with their buy-in.",
  "\"I'm in for $50 on Jake's take\": back_take. \"Fading Jake for $25\": fade_take. Find the take in [Recent in this chat] or a link; if more than one fits, ask which.",
  "Selling: sell_position. If it's all of a position marked closes_take_if_sold_all, first say that selling all of their buy-in closes their take to new backers, and ask them to confirm.",
  "Trade tools don't trade right away: they set the trade up (status awaiting_confirmation) and the person confirms by liking the message or replying yes. The confirmation message is written for you; don't write one.",
  "error not_linked: say they need to connect once, then trades by text just work, and give the connect link. over_trade_limit or over_daily_limit: say their limit in one line and give the link to do it themselves. Any other error: one plain line, never the raw code.",
  "Never say something was bought, sold or posted. A build_basket link alone is a draft: whoever opens it can post it.",
].join(" ");


type FnCall = { type: "function_call"; call_id: string; name: string; arguments: string };

export function createAgent(cfg: AgentConfig) {
  const client = new OpenAI({ apiKey: cfg.openaiApiKey });
  const model = cfg.model ?? "gpt-6-luna";
  const effort = cfg.effort ?? "low";
  const log = cfg.log ?? (() => {});
  /** Conversation memory per chat, kept server-side by the Responses API. */
  const last = new Map<string, string>();

  const instructions = cfg.trading ? `${INSTRUCTIONS} ${TRADING}` : INSTRUCTIONS;
  const tools = cfg.trading ? [basketTool, ...tradeTools] : [basketTool];
  /** Per chat: drafts built and takes seen or traded, newest last. */
  const recent = new Map<string, { kind: "draft" | "take"; id: string; claim?: string; by?: string }[]>();
  const remember = (chatId: string, item: { kind: "draft" | "take"; id: string; claim?: string; by?: string }) => {
    const list = (recent.get(chatId) ?? []).filter((r) => r.id !== item.id);
    list.push(item);
    recent.set(chatId, list.slice(-RECENT_MAX));
  };

  /** Trades waiting for a yes, per chat and sender. */
  const pending = new Map<string, Pending>();
  /** A follow-up still sending a turn's tool outputs to the model (keeps its context whole). */
  const catchUp = new Map<string, Promise<void>>();
  const pendingKey = (turn: Turn) => `${turn.chatId}|${turn.senderId ?? ""}`;

  async function create(input: unknown, previous: string | undefined) {
    return client.responses.create({
      model,
      instructions,
      input: input as never,
      tools,
      reasoning: { effort },
      truncation: "auto",
      ...(previous ? { previous_response_id: previous } : {}),
    } as never) as Promise<OpenAI.Responses.Response>;
  }

  type TurnState = { links: string[]; proposal: Pending | null; picks: string[] };

  async function runTool(call: FnCall, st: TurnState, turn: Turn): Promise<string> {
    const links = st.links;
    if (TRADE_TOOL_NAMES.has(call.name)) {
      if (!cfg.trading || !turn.senderId) return JSON.stringify({ error: "trading_unavailable" });
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments); } catch { return JSON.stringify({ error: "bad arguments" }); }
      const t0 = Date.now();
      const claims = new Map((recent.get(turn.chatId) ?? []).filter((r) => r.claim).map((r) => [r.id, r.claim!] as [string, string]));
      const out = await prepareTrade(cfg.trading, { imessage: turn.senderId }, turn.messageId ?? null, call.name, args, claims, cfg.basket.webUrl)
        .catch((e: Error) => ({ kind: "done" as const, output: { error: "trade_unavailable", message: e.message.slice(0, 120) } as Record<string, unknown>, link: undefined }));
      log(`tool ${call.name}`, { status: out.output.status ?? null, error: out.output.error ?? null, ms: Date.now() - t0 });
      if (out.kind === "pending") st.proposal = out.pending;
      else if (out.link) links.push(out.link);
      return JSON.stringify(out.output);
    }
    if (call.name !== "build_basket") return JSON.stringify({ error: `unknown tool ${call.name}` });
    let args: BasketArgs;
    try {
      const raw = JSON.parse(call.arguments) as Partial<BasketArgs>;
      args = {
        claim: String(raw.claim ?? ""),
        risk: RISKS.includes(raw.risk as never) ? raw.risk! : "medium",
      };
    } catch {
      return JSON.stringify({ error: "bad arguments" });
    }
    const t0 = Date.now();
    const meta = { origin: "imessage" as const, context: turn.chatType === "group" ? "From a group chat" : "From iMessage" };
    const out = await buildBasket(cfg.basket, args, meta).catch((e: Error) => ({ verdict: "error" as const, reason: e.message }));
    log("tool build_basket", { verdict: out.verdict, legs: out.verdict === "basket" ? out.legs.length : 0, ms: Date.now() - t0 });
    if (out.verdict === "basket") {
      links.push(out.link);
      st.picks = out.legs.map((l) => `${l.name} ${Math.round(l.weight)}%`);
      remember(turn.chatId, { kind: "draft", id: out.draftId, claim: args.claim, by: turn.sender ?? undefined });
      return JSON.stringify({ ...out, draft_id: out.draftId });
    }
    return JSON.stringify(out);
  }

  return {
    /** Warm the take builder so the first basket isn't a cold start. */
    warm: () => warmBasket(cfg.basket),

    /** Reply text, or null to stay quiet. */
    async respond(turn: Turn): Promise<string | null> {
      await catchUp.get(turn.chatId);
      // A trade waiting for this person's yes: a like / love tapback or "yes" runs it, "no" drops it.
      const key = pendingKey(turn);
      const waiting = pending.get(key);
      if (waiting && waiting.expiresAt < Date.now()) pending.delete(key);
      const live = pending.get(key);
      const answer = turn.reaction ? (turn.reaction === "like" || turn.reaction === "love" ? "yes" : null) : yesNo(turn.text);
      if (live && cfg.trading && answer === "yes") {
        pending.delete(key);
        const t0 = Date.now();
        const r = await runConfirmed(cfg.trading, live);
        log("trade confirmed", { action: live.ask.action, ms: Date.now() - t0, by: turn.reaction ? "reaction" : "text" });
        if (r.takeId) remember(turn.chatId, { kind: "take", id: r.takeId, claim: live.claim ?? undefined, by: turn.sender ?? undefined });
        return r.text;
      }
      if (live && answer === "no") {
        pending.delete(key);
        return "ok, cancelled.";
      }
      // Other tapbacks are never something to answer.
      if (turn.reaction) return null;
      // A take link in the chat is something people may back or fade next.
      for (const m of turn.text.matchAll(/\/t\/([0-9a-f-]{36})/gi)) {
        const id = takeIdFrom(m[1]);
        if (id) remember(turn.chatId, { kind: "take", id, by: turn.sender ?? undefined });
      }
      const said = turn.chatType === "group" ? `[group] ${turn.sender ?? "someone"}: ${turn.text}` : turn.text;
      const known = cfg.trading ? recent.get(turn.chatId) ?? [] : [];
      const context = known.length
        ? `[Recent in this chat: ${known.map((r) => `${r.kind} ${r.id}${r.claim ? ` "${r.claim.slice(0, 60)}"` : ""}${r.by ? ` from ${r.by}` : ""}`).join("; ")}]\n`
        : "";
      const text = context + said;
      const st: TurnState = { links: [], proposal: null, picks: [] };
      const links = st.links;
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
          calls.map(async (c) => ({ type: "function_call_output", call_id: c.call_id, output: await runTool(c, st, turn) })),
        );
        if (st.proposal) {
          // A trade is set up: ask for the yes now, and hand the tool outputs to the model in the
          // background (its context needs them; this reply doesn't).
          const p = st.proposal;
          pending.set(key, p);
          const prev = res.id;
          catchUp.set(turn.chatId, create(outputs, prev).then((r) => { last.set(turn.chatId, r.id); }, () => { last.delete(turn.chatId); }).finally(() => catchUp.delete(turn.chatId)));
          return [askText(p), ...st.picks].join("\n");
        }
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
