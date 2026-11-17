// The Gemini proxy's request handling, kept apart from Deno.serve so tests can run it with a fake
// fetch. See index.ts.

export const GEMINI_BASE = "https://api.gemini.com/v1/prediction-markets";

/** The public, read-only prediction-markets paths this proxy serves, and how long each is cached. */
const ROUTES: { path: RegExp; ttlMs: number }[] = [
  { path: /^categories$/, ttlMs: 10 * 60_000 },
  { path: /^events$/, ttlMs: 30_000 },
  { path: /^events\/[A-Za-z0-9._-]{1,128}$/, ttlMs: 30_000 },
];
const MAX_QUERY_LENGTH = 512;
const MAX_CACHED = 500;

export type ProxyDeps = {
  /** GEMINI_PROXY_TOKEN: callers send it as `x-gemini-proxy-token`. */
  token: string | undefined;
  fetch: typeof fetch;
  now?: () => number;
};

type Cached = { at: number; ttlMs: number; status: number; body: string };

// Gemini's events carry far more than Thesis reads: nested sub-events, descriptions, image and
// terms links. A full sweep of every active event was 64 MB, all of it Supabase
// egress, so the proxy passes on only the fields Thesis uses (about 1/15 of the bytes). Keep these
// in step with packages/venues/gemini (parseEvent) and packages/venues/registry (sources/gemini.ts).
// deno-lint-ignore no-explicit-any
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const EVENT_KEYS = ["ticker", "title", "category", "status", "expiryDate", "volume", "volume24h"];
const CONTRACT_KEYS = ["instrumentSymbol", "label", "status", "expiryDate", "resolutionSide", "resolvedAt"];
const PRICE_KEYS = ["buy", "sell", "bestBid", "bestAsk", "lastTradePrice"];
// deno-lint-ignore no-explicit-any
export function slimEvent(e: any) {
  if (!e || typeof e !== "object") return e;
  const sub = e.subcategory;
  return {
    ...pick(e, EVENT_KEYS),
    ...(sub ? { subcategory: typeof sub === "string" ? sub : sub.name ?? null } : {}),
    // deno-lint-ignore no-explicit-any
    contracts: Array.isArray(e.contracts) ? e.contracts.map((c: any) => ({ ...pick(c, CONTRACT_KEYS), ...(c?.prices ? { prices: pick(c.prices, PRICE_KEYS) } : {}) })) : [],
  };
}

/** The response body as Thesis needs it: `events` lists and single events slimmed, the rest as is. */
export function slimBody(path: string, body: string): string {
  if (!path.startsWith("events")) return body;
  try {
    const raw = JSON.parse(body);
    if (path === "events") return JSON.stringify({ ...raw, data: Array.isArray(raw?.data) ? raw.data.map(slimEvent) : raw?.data });
    // A single event comes as the event itself or wrapped in `data`.
    return JSON.stringify(raw?.data && !Array.isArray(raw.data) ? { ...raw, data: slimEvent(raw.data) } : slimEvent(raw));
  } catch {
    return body;
  }
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Builds the handler. Requests are `GET <function>/<path>?<query>`, where `<path>` is one of
 * ROUTES, forwarded to `GEMINI_BASE/<path>?<query>`. Nothing from the incoming request but the
 * path and query reaches Gemini: no headers, no client address.
 */
export function geminiProxy(deps: ProxyDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const inFlight = new Map<string, Promise<Cached>>();

  const load = (url: string, path: string, ttlMs: number): Promise<Cached> => {
    const pending = inFlight.get(url);
    if (pending) return pending;
    const request = (async () => {
      const res = await deps.fetch(url, { method: "GET", headers: { accept: "application/json" } });
      const text = await res.text();
      const entry = { at: now(), ttlMs, status: res.status, body: res.ok ? slimBody(path, text) : text };
      if (res.ok) {
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
        cache.set(url, entry);
      }
      return entry;
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, request);
    return request;
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
    if (!deps.token) return json(503, { error: "not_configured" });
    if (!sameSecret(req.headers.get("x-gemini-proxy-token") ?? "", deps.token)) return json(401, { error: "unauthorized" });

    const url = new URL(req.url);
    // The function is served at /gemini (hosted: /functions/v1/gemini); the rest is Gemini's path.
    const path = url.pathname.replace(/^.*?\/gemini\/?/, "");
    const route = ROUTES.find((r) => r.path.test(path));
    if (!route) return json(404, { error: "not_found" });
    if (url.search.length > MAX_QUERY_LENGTH) return json(400, { error: "query_too_long" });

    const target = `${GEMINI_BASE}/${path}${url.search}`;
    const hit = cache.get(target);
    if (hit && now() - hit.at < hit.ttlMs) return json(hit.status, hit.body, { "x-cache": "hit" });
    try {
      const entry = await load(target, path, route.ttlMs);
      return json(entry.status, entry.body, { "x-cache": "miss" });
    } catch {
      return json(502, { error: "upstream_unavailable" });
    }
  };
}
