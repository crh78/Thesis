// Sendblue adapter: iMessage (with SMS fallback) through Sendblue's API.
// Docs: https://docs.sendblue.com
//
// Inbound: polls GET /api/v2/messages for new received messages. The free plan
// has no webhooks, and polling needs no public URL. When we move to a paid
// line on a server, swap this for the `receive` webhook.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tapbackFromText, type Handler, type Inbound, type Provider } from "../types.ts";
import { contactCard } from "../contact-card.ts";
import { log, mask } from "../log.ts";

const API = "https://api.sendblue.com";
const POLL_MS = 2_000;
/** DMs that already got the contact card (survives restarts; gitignored). */
const CARDED = new URL("../../.data/carded.json", import.meta.url);

export type SendblueEnv = {
  apiKey: string;
  apiSecret: string;
  /** Our Sendblue line, E.164. Replies go out from the line that received. */
  fromNumber: string;
};

/** The fields we use from a Sendblue message object. */
type SbMessage = {
  message_handle: string;
  content: string | null;
  number: string;
  from_number: string;
  sendblue_number?: string | null;
  is_outbound: boolean;
  group_id?: string | null;
  date_sent?: string;
  createdAt?: string;
  message_type?: string | null;
};

export function sendblue(env: SendblueEnv): Provider {
  const headers = {
    "content-type": "application/json",
    "sb-api-key-id": env.apiKey,
    "sb-api-secret-key": env.apiSecret,
  };
  let running = false;
  const seen = new Set<string>();
  // Chats run in parallel; messages within one chat run in order.
  const queues = new Map<string, Promise<void>>();

  async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sendblue ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Upload the .vcf once per run; Sendblue sends it by media_url (must end in .vcf). */
  async function uploadCard(): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([await contactCard(env.fromNumber)], { type: "text/vcard" }), "thesis.vcf");
    const res = await fetch(`${API}/api/upload-file`, {
      method: "POST",
      headers: { "sb-api-key-id": env.apiKey, "sb-api-secret-key": env.apiSecret },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await res.json().catch(() => ({}))) as { media_url?: string };
    if (!res.ok || !out.media_url?.endsWith(".vcf")) throw new Error(`card upload ${res.status}`);
    return out.media_url;
  }

  let cardUrl: string | undefined;
  const carded = new Set<string>();

  async function sendCard(m: SbMessage) {
    if (!cardUrl || carded.has(m.number)) return;
    carded.add(m.number);
    await api("POST", "/api/send-message", { number: m.number, from_number: m.sendblue_number || env.fromNumber, media_url: cardUrl });
    await mkdir(new URL(".", CARDED), { recursive: true });
    await writeFile(CARDED, JSON.stringify([...carded]));
    log("sent contact card", { chat: mask(m.number) });
  }

  async function send(m: SbMessage, content: string) {
    const from = m.sendblue_number || env.fromNumber;
    if (m.group_id) return api("POST", "/api/send-group-message", { group_id: m.group_id, from_number: from, content });
    return api("POST", "/api/send-message", { number: m.number, from_number: from, content });
  }

  async function handle(handler: Handler, m: SbMessage) {
    const text = m.content?.trim();
    // Sendblue doesn't document inbound tapbacks: log any type that isn't a plain message, to learn.
    if (m.message_type && m.message_type !== "message") log("inbound type", { chat: mask(m.group_id || m.number), type: m.message_type });
    if (!text) {
      log("skip non-text", { chat: mask(m.group_id || m.number) });
      return;
    }
    const reaction = (m.message_type === "reaction" ? "like" : null) ?? tapbackFromText(text);
    const msg: Inbound = {
      provider: "sendblue",
      chatId: m.group_id || m.number,
      chatType: m.group_id ? "group" : "dm",
      senderId: m.from_number,
      messageId: m.message_handle,
      text,
      ...(reaction ? { reaction } : {}),
    };
    log("inbound", { chat: mask(msg.chatId), type: msg.chatType, from: mask(msg.senderId), chars: text.length, ...(reaction ? { reaction } : {}) });

    // Typing bubble: DMs only (Sendblue doesn't support it in groups), best-effort.
    if (msg.chatType === "dm") {
      void api("POST", "/api/send-typing-indicator", { number: m.number, from_number: m.sendblue_number || env.fromNumber }).catch(() => {});
    }
    const reply = await handler(msg);
    if (reply === null) {
      log("quiet", { chat: mask(msg.chatId) });
      return;
    }
    const sent = await send(m, reply) as { message_handle?: string };
    log("replied", { chat: mask(msg.chatId), id: sent?.message_handle ?? null, chars: reply.length });
    if (msg.chatType === "dm") {
      await sendCard(m).catch((err) => log("contact card failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  function dispatch(handler: Handler, m: SbMessage) {
    const chat = m.group_id || m.number;
    const next = (queues.get(chat) ?? Promise.resolve())
      .then(() => handle(handler, m))
      // One bad message must never kill the chat or the loop.
      .catch((err) => log("message failed", { chat: mask(chat), error: err instanceof Error ? err.message : String(err) }));
    queues.set(chat, next);
    void next.finally(() => queues.get(chat) === next && queues.delete(chat));
  }

  return {
    name: "sendblue",

    async run(handler: Handler) {
      // Only messages from now on; never replay history on restart.
      let since = new Date().toISOString();
      // Fail fast on bad keys before entering the loop.
      await api("GET", `/api/v2/messages?limit=1`);
      log("sendblue connected", { line: mask(env.fromNumber) });
      for (const n of await readFile(CARDED, "utf8").then((s) => JSON.parse(s) as string[]).catch(() => [])) carded.add(n);
      cardUrl = await uploadCard().catch((err) => {
        log("contact card upload failed", { error: err instanceof Error ? err.message : String(err) });
        return undefined;
      });
      running = true;

      while (running) {
        try {
          const q = new URLSearchParams({
            is_outbound: "false",
            created_at_gte: since,
            order_by: "createdAt",
            order_direction: "asc",
            limit: "100",
          });
          const { data } = await api<{ data: SbMessage[] }>("GET", `/api/v2/messages?${q}`);
          for (const m of data ?? []) {
            if (m.is_outbound || seen.has(m.message_handle)) continue;
            seen.add(m.message_handle);
            const at = m.createdAt ?? m.date_sent;
            if (at && at > since) since = at;
            dispatch(handler, m);
          }
          // Bound the dedupe set; the cursor already skips older messages.
          if (seen.size > 5_000) for (const h of [...seen].slice(0, 2_500)) seen.delete(h);
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
