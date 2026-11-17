// gemini: a read-only proxy for Gemini's public prediction-market data, so the backend's calls
// reach Gemini from Supabase's shared egress instead of a developer's or a server's own address.
//
//   GET /gemini/categories                       → api.gemini.com/v1/prediction-markets/categories
//   GET /gemini/events?status=active&category=…  → …/events
//   GET /gemini/events/<ticker>                  → …/events/<ticker>
//   header x-gemini-proxy-token: <GEMINI_PROXY_TOKEN>
//
// Public data only: no Gemini key, no account, and nothing from the caller's request but the path
// and query is sent on. Responses are cached briefly in the function (categories 10 min, events
// 30 s) to keep the request volume low. Anything else is 404.
//
// Secret: GEMINI_PROXY_TOKEN (openssl rand -hex 32), the same value as in the repo-root .env.

import { geminiProxy } from "./proxy.ts";

Deno.serve(geminiProxy({ token: Deno.env.get("GEMINI_PROXY_TOKEN"), fetch }));
