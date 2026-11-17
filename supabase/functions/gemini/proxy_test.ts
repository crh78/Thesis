// deno test supabase/functions/gemini: the proxy against a fake Gemini (no network).
import { assertEquals } from "jsr:@std/assert@1";
import { GEMINI_BASE, geminiProxy, slimBody } from "./proxy.ts";

const TOKEN = "test-token";
const FN = "https://project.supabase.co/functions/v1/gemini";

function fakeGemini(status = 200, body = '{"data":[]}') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

const get = (path: string, headers: Record<string, string> = { "x-gemini-proxy-token": TOKEN }) =>
  new Request(`${FN}${path}`, { headers });

Deno.test("forwards an allowed path and query to Gemini, and nothing from the caller", async () => {
  const g = fakeGemini();
  const proxy = geminiProxy({ token: TOKEN, fetch: g.fetchFn });
  const res = await proxy(get("/events?status=active&category=Crypto&limit=100", {
    "x-gemini-proxy-token": TOKEN,
    "x-forwarded-for": "203.0.113.7",
    "user-agent": "thesis-dev",
    authorization: "Bearer something",
  }));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '{"data":[]}');
  assertEquals(g.calls.length, 1);
  assertEquals(g.calls[0].url, `${GEMINI_BASE}/events?status=active&category=Crypto&limit=100`);
  // Only `accept` goes out: no client address, user agent, token or authorization.
  assertEquals(g.calls[0].init?.headers, { accept: "application/json" });
});

Deno.test("serves categories, events and one event; refuses anything else", async () => {
  const g = fakeGemini();
  const proxy = geminiProxy({ token: TOKEN, fetch: g.fetchFn });
  for (const ok of ["/categories", "/events", "/events/BTC-100K-DEC"]) assertEquals((await proxy(get(ok))).status, 200, ok);
  for (const bad of ["/orders", "/events/BTC/../../v1/order/new", "/", "/terms/accept", "/events/a b"]) {
    assertEquals((await proxy(get(bad))).status, 404, bad);
  }
  assertEquals((await proxy(new Request(`${FN}/events`, { method: "POST", headers: { "x-gemini-proxy-token": TOKEN } }))).status, 405);
  assertEquals((await proxy(get(`/events?q=${"x".repeat(600)}`))).status, 400);
  assertEquals(g.calls.length, 3);
});

Deno.test("needs the token, and is off without one configured", async () => {
  const g = fakeGemini();
  assertEquals((await geminiProxy({ token: TOKEN, fetch: g.fetchFn })(get("/events", {}))).status, 401);
  assertEquals((await geminiProxy({ token: TOKEN, fetch: g.fetchFn })(get("/events", { "x-gemini-proxy-token": "wrong-token" }))).status, 401);
  assertEquals((await geminiProxy({ token: undefined, fetch: g.fetchFn })(get("/events"))).status, 503);
  assertEquals(g.calls.length, 0);
});

Deno.test("caches successful reads for their TTL, and not errors", async () => {
  let t = 0;
  const g = fakeGemini();
  const proxy = geminiProxy({ token: TOKEN, fetch: g.fetchFn, now: () => t });
  assertEquals((await proxy(get("/events?status=active"))).headers.get("x-cache"), "miss");
  t = 29_000;
  assertEquals((await proxy(get("/events?status=active"))).headers.get("x-cache"), "hit");
  t = 31_000;
  assertEquals((await proxy(get("/events?status=active"))).headers.get("x-cache"), "miss");
  assertEquals(g.calls.length, 2);

  const down = fakeGemini(503, '{"error":"busy"}');
  const proxy2 = geminiProxy({ token: TOKEN, fetch: down.fetchFn });
  assertEquals((await proxy2(get("/categories"))).status, 503);
  assertEquals((await proxy2(get("/categories"))).status, 503);
  assertEquals(down.calls.length, 2);
});

Deno.test("an unreachable Gemini is a 502", async () => {
  const proxy = geminiProxy({ token: TOKEN, fetch: (() => Promise.reject(new Error("down"))) as typeof fetch });
  assertEquals((await proxy(get("/categories"))).status, 502);
});

const FULL_EVENT = {
  id: "1", ticker: "FED261211", title: "Fed decision in December?", category: "Economics", status: "active",
  expiryDate: "2026-12-11T19:00:00Z", volume: "1200", volume24h: "80", subcategory: { id: 9, name: "Fed" },
  description: "x".repeat(900), imageUrl: "https://img", events: [{ ticker: "nested", contracts: [] }], termsLink: "https://terms",
  contracts: [{
    instrumentSymbol: "GEMI-FED261211-CUT25", label: "Cut 25bps", status: "active", expiryDate: "2026-12-11T19:00:00Z",
    description: "y".repeat(900), imageUrl: "https://img", termsAndConditionsUrl: "https://terms", teamId: "t",
    prices: { buy: { yes: "0.41", no: "0.60" }, sell: { yes: "0.40", no: "0.59" }, bestBid: "0.40", bestAsk: "0.41", lastTradePrice: "0.40", extra: 1 },
  }],
};
const SLIM_EVENT = {
  ticker: "FED261211", title: "Fed decision in December?", category: "Economics", status: "active",
  expiryDate: "2026-12-11T19:00:00Z", volume: "1200", volume24h: "80", subcategory: "Fed",
  contracts: [{
    instrumentSymbol: "GEMI-FED261211-CUT25", label: "Cut 25bps", status: "active", expiryDate: "2026-12-11T19:00:00Z",
    prices: { buy: { yes: "0.41", no: "0.60" }, sell: { yes: "0.40", no: "0.59" }, bestBid: "0.40", bestAsk: "0.41", lastTradePrice: "0.40" },
  }],
};

Deno.test("slims events to the fields Thesis reads (lists, single events, wrapped or not)", async () => {
  assertEquals(JSON.parse(slimBody("events", JSON.stringify({ data: [FULL_EVENT], pagination: { total: 1 } }))), { data: [SLIM_EVENT], pagination: { total: 1 } });
  assertEquals(JSON.parse(slimBody("events/FED261211", JSON.stringify(FULL_EVENT))), SLIM_EVENT);
  assertEquals(JSON.parse(slimBody("events/FED261211", JSON.stringify({ data: FULL_EVENT }))), { data: SLIM_EVENT });
  // Resolution fields pass when Gemini sends them.
  const resolved = { ...FULL_EVENT, contracts: [{ ...FULL_EVENT.contracts[0], status: "settled", resolutionSide: "yes", resolvedAt: "2026-12-11T20:00:00Z" }] };
  assertEquals(JSON.parse(slimBody("events/FED261211", JSON.stringify(resolved))).contracts[0].resolutionSide, "yes");
  // Categories and bodies that aren't JSON pass through untouched.
  assertEquals(slimBody("categories", '{"categories":["Crypto"]}'), '{"categories":["Crypto"]}');
  assertEquals(slimBody("events", "not json"), "not json");
  // Through the proxy: what's cached and served is the slim body.
  const g = fakeGemini(200, JSON.stringify({ data: [FULL_EVENT] }));
  const res = await geminiProxy({ token: TOKEN, fetch: g.fetchFn })(get("/events?status=active"));
  assertEquals(JSON.parse(await res.text()), { data: [SLIM_EVENT] });
});
