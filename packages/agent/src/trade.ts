// Trading for someone by text: the `agent` function's bot routes (supabase/functions/agent). It
// holds every trade to the limits the person approved on the web app (/limits) and signs with
// Thesis's Privy session signer; the bots only say who's asking and what to do.

export type Who = { x: string } | { imessage: string };

export type AgentApiConfig = {
  /** https://<ref>.supabase.co/functions/v1/agent */
  agentUrl: string;
  /** The Vault's bot_secret (the same key as drafts). */
  botSecret: string;
};

/** signed_up: a Thesis account links this X account (null: unknown). */
export type WhoIs =
  | { linked: false; signed_up?: boolean | null }
  | { linked: true; signed_up?: boolean; active: boolean; handle: string | null; per_trade_usd: number; daily_usd: number; left_usd: number };

export type TradeAsk =
  | { action: "post"; draftId: string; usd: number }
  | { action: "back" | "fade"; takeId: string; usd: number }
  | { action: "sell"; takeId: string; side?: "back" | "fade"; bps?: number; usd?: number };

export type TradeResult =
  | { ok: true; status: "landed" | "pending" | "failed"; takeId: string; url: string; usd: number | null; closesTake: boolean; existing: boolean; error?: string }
  | { ok: false; error: string; message?: string; perTradeUsd?: number; leftUsd?: number; confirmUrl?: string; takeId?: string };

export type Score =
  | { found: false }
  | { found: true; handle: string; display_name: string | null; made: number; return_pct: number; backers_made: number; backers_pct: number; takes: number };

export type Position = {
  take_id: string; claim: string; side: "back" | "fade"; stake_usd: number; value_usd: number | null;
  return_bps: number | null; can_exit: boolean | null; closes_take_if_sold_all: boolean;
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const DRAFT = /\/d\/([A-Za-z0-9]{8})\b/;

/** A take's id from a take link (…/t/<uuid>) or a bare id; null otherwise. */
export function takeIdFrom(s: string | null | undefined): string | null {
  const m = s?.match(UUID);
  return m ? m[0].toLowerCase() : null;
}

/** A draft's id from a draft link (…/d/<id>) or a bare 8-character id. */
export function draftIdFrom(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(DRAFT);
  if (m) return m[1];
  return /^[A-Za-z0-9]{8}$/.test(s.trim()) ? s.trim() : null;
}

export function agentApi(cfg: AgentApiConfig, f: typeof fetch = fetch) {
  const base = cfg.agentUrl.replace(/\/$/, "");
  async function post<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<{ status: number; body: T }> {
    const res = await f(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bot-secret": cfg.botSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  }

  return {
    async whois(who: Who): Promise<WhoIs> {
      const r = await post<WhoIs & { error?: string }>("whois", { who });
      if (r.status !== 200) throw new Error(`agent whois ${r.status}: ${r.body.error ?? ""}`);
      return r.body;
    },

    /** A one-time link that connects this iMessage handle to whoever opens it and approves limits. */
    async connectLink(imessage: string): Promise<string> {
      const r = await post<{ url?: string; error?: string }>("links", { imessage });
      if (r.status !== 200 || !r.body.url) throw new Error(`agent links ${r.status}: ${r.body.error ?? ""}`);
      return r.body.url;
    },

    /** The Thesis account that links this X username, and its two scores (the X bot's "score"). */
    async score(xUsername: string): Promise<Score> {
      const r = await post<Score & { error?: string }>("score", { x_username: xUsername });
      if (r.status !== 200) throw new Error(`agent score ${r.status}: ${r.body.error ?? ""}`);
      return r.body;
    },

    /** A take's claim and its author's handle (null when there's no such take). */
    async takeInfo(takeId: string): Promise<{ claim: string; author: string | null } | null> {
      const r = await post<{ claim?: string; author?: string | null; error?: string }>("takes", { take_id: takeId });
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body.claim) throw new Error(`agent takes ${r.status}: ${r.body.error ?? ""}`);
      return { claim: r.body.claim, author: r.body.author ?? null };
    },

    /** `wait: false` answers once the fork accepted the trade (status pending), not once it landed. */
    async trade(who: Who, surface: "x" | "imessage" | "copy" | "mcp", ref: string | null, ask: TradeAsk, opts: { wait?: boolean } = {}): Promise<TradeResult> {
      const body = {
        who, surface, ref, action: ask.action, ...(opts.wait === false ? { wait: false } : {}),
        ...(ask.action === "post" ? { draft_id: ask.draftId, usd: ask.usd } : { take_id: ask.takeId }),
        ...(ask.action === "back" || ask.action === "fade" ? { usd: ask.usd } : {}),
        ...(ask.action === "sell" ? { side: ask.side ?? "back", ...(ask.bps ? { bps: ask.bps } : ask.usd ? { usd: ask.usd } : {}) } : {}),
      };
      // A trade builds, signs and waits for the fork (up to ~25 s), sometimes twice.
      const r = await post<Record<string, unknown>>("trades", body, 90_000);
      const b = r.body;
      if (r.status === 200 && typeof b.status === "string") {
        const err = b.error as { code?: string } | string | undefined;
        return {
          ok: true, status: b.status as "landed" | "pending" | "failed", takeId: String(b.take_id), url: String(b.url),
          usd: typeof b.usd === "number" ? b.usd : null, closesTake: b.closes_take === true, existing: b.existing === true,
          ...(err ? { error: typeof err === "string" ? err : err.code } : {}),
        };
      }
      return {
        ok: false, error: typeof b.error === "string" ? b.error : `agent_${r.status}`,
        ...(typeof b.message === "string" ? { message: b.message } : {}),
        ...(typeof b.per_trade_usd === "number" ? { perTradeUsd: b.per_trade_usd } : {}),
        ...(typeof b.left_usd === "number" ? { leftUsd: b.left_usd } : {}),
        ...(typeof b.confirm_url === "string" ? { confirmUrl: b.confirm_url } : {}),
        ...(typeof b.take_id === "string" ? { takeId: b.take_id } : {}),
      };
    },

    async positions(who: Who): Promise<Position[]> {
      const r = await post<{ positions?: Position[]; error?: string }>("positions", { who });
      if (r.status !== 200) throw new Error(`agent positions ${r.status}: ${r.body.error ?? ""}`);
      return r.body.positions ?? [];
    },
  };
}

export type AgentApi = ReturnType<typeof agentApi>;

/** The agent function's config from the bots' shared env. */
export function agentApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentApiConfig | null {
  const url = env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = env.THESIS_BOT_SECRET;
  return url && secret ? { agentUrl: `${url}/functions/v1/agent`, botSecret: secret } : null;
}
