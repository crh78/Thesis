// Gemini prediction markets: public market data only (no key, no account, no orders), always
// read through the Thesis `gemini` edge function (supabase/functions/gemini). That keeps every
// request on Supabase's shared egress: Gemini never sees a developer's or a server's own address.
// There's deliberately no direct mode.
//
// Settings (environment or the repo-root .env):
//   GEMINI_PROXY_TOKEN   the function's secret (required)
//   GEMINI_PROXY_URL     default <SUPABASE_URL>/functions/v1/gemini

export type GeminiProxy = { base: string; token: string };

/** Paths the proxy serves (Gemini's /v1/prediction-markets/<path>). */
export type GeminiPath = "categories" | "events" | `events/${string}`;

/** The proxy settings from `get` (an env lookup). Throws, with what to set, when they're missing. */
export function geminiProxy(get: (key: string) => string | null): GeminiProxy {
  const supabase = get("SUPABASE_URL");
  const base = get("GEMINI_PROXY_URL") ?? (supabase ? `${supabase.replace(/\/+$/, "")}/functions/v1/gemini` : null);
  const token = get("GEMINI_PROXY_TOKEN");
  if (!base || !token) {
    throw new Error(
      "Gemini data goes through the Supabase `gemini` function: set GEMINI_PROXY_TOKEN (and SUPABASE_URL or GEMINI_PROXY_URL) in the repo-root .env",
    );
  }
  return { base: base.replace(/\/+$/, ""), token };
}

/** The URL and headers for one read through the proxy. */
export function geminiRequest(
  proxy: GeminiProxy,
  path: GeminiPath,
  query: Record<string, string | number> = {},
): { url: string; headers: Record<string, string> } {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return { url: `${proxy.base}/${path}${qs ? `?${qs}` : ""}`, headers: { "x-gemini-proxy-token": proxy.token } };
}

export * from "./markets.ts";
