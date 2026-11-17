// BlueBubbles adapter: iMessage through a BlueBubbles server (https://bluebubbles.app), free and
// open source, running on a Mac signed into Messages with the bot's Apple ID. Unlike Sendblue's
// free plan it works in group chats.
//
// Inbound: polls POST /api/v1/message/query for messages after a cursor (the server is on this Mac
// or the LAN, so polling is cheap and needs no public URL). Outbound: POST /api/v1/message/text to
// the chat's guid, with the server's default send method (AppleScript), which needs no Private API
// and sends to existing group chats. Chat guids look like "iMessage;-;+15555550123" for a DM and
// "iMessage;+;chat123…" for a group.
import type { Handler, Inbound, Provider } from "../types.ts";
import { log, mask } from "../log.ts";

const POLL_MS = 1_500;

export type BlueBubblesEnv = {
  /** The server's URL, e.g. http://localhost:1234. */
  url: string;
  /** The server password (Settings → Server password). */
  password: string;
};

/** The fields we use from a BlueBubbles message. */
type BbMessage = {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  dateCreated: number;
  handle?: { address?: string | null } | null;
  chats?: Array<{ guid: string }>;
  associatedMessageGuid?: string | null;
};

export function bluebubbles(env: BlueBubblesEnv): Provider {
  const base = env.url.replace(/\/$/, "");
  let running = false;
  const seen = new Set<string>();
  const queues = new Map<string, Promise<void>>();

  async function api<T>(path: string, body?: unknown): Promise<T> {
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}password=${encodeURIComponent(env.password)}`;
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`bluebubbles ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function send(chatGuid: string, message: string) {
    return api<{ data?: { guid?: string } }>("/api/v1/message/text", { chatGuid, tempGuid: `temp-${crypto.randomUUID()}`, message });
  }

  async function handle(handler: Handler, m: BbMessage, chatGuid: string) {
    const text = m.text?.trim();
    // Tapbacks and other reactions carry an associated message; skip them like non-text.
    if (!text || m.associatedMessageGuid) {
      log("skip non-text", { chat: mask(chatGuid) });
      return;
    }
    const msg: Inbound = {
      provider: "bluebubbles",
      chatId: chatGuid,
      chatType: chatGuid.includes(";+;") ? "group" : "dm",
      senderId: m.handle?.address ?? undefined,
      text,
    };
    log("inbound", { chat: mask(msg.chatId), type: msg.chatType, from: mask(msg.senderId), chars: text.length });
    const reply = await handler(msg);
    if (reply === null) {
      log("quiet", { chat: mask(msg.chatId) });
      return;
    }
    const sent = await send(chatGuid, reply);
    log("replied", { chat: mask(msg.chatId), id: sent?.data?.guid ?? null, chars: reply.length });
  }

  function dispatch(handler: Handler, m: BbMessage, chatGuid: string) {
    const next = (queues.get(chatGuid) ?? Promise.resolve())
      .then(() => handle(handler, m, chatGuid))
      .catch((err) => log("message failed", { chat: mask(chatGuid), error: err instanceof Error ? err.message : String(err) }));
    queues.set(chatGuid, next);
    void next.finally(() => queues.get(chatGuid) === next && queues.delete(chatGuid));
  }

  return {
    name: "bluebubbles",

    async run(handler: Handler) {
      // Fail fast on a wrong URL or password.
      await api("/api/v1/ping");
      log("bluebubbles connected", { server: base.replace(/\/\/.*@/, "//") });
      // Only messages from now on; never replay history on restart.
      let since = Date.now();
      running = true;
      while (running) {
        try {
          const { data } = await api<{ data: BbMessage[] }>("/api/v1/message/query", {
            after: since,
            sort: "ASC",
            limit: 100,
            with: ["chat", "handle"],
          });
          for (const m of data ?? []) {
            if (m.dateCreated > since) since = m.dateCreated;
            // The bot's own replies come back as isFromMe: never answer them.
            if (m.isFromMe || seen.has(m.guid)) continue;
            seen.add(m.guid);
            const chatGuid = m.chats?.[0]?.guid;
            if (!chatGuid) continue;
            dispatch(handler, m, chatGuid);
          }
          if (seen.size > 5_000) for (const g of [...seen].slice(0, 2_500)) seen.delete(g);
        } catch (err) {
          log("poll failed", { error: err instanceof Error ? err.message : String(err) });
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },

    async stop() {
      running = false;
    },
  };
}
