// The executor's HTTP helper and the settler's batched Jupiter reads, on fake fetches. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CoolDown, HttpError, getJson, sleepUnless, timedFetch } from "../src/http.ts";
import { JUPITER_PRICE_BATCH, JupiterPrices } from "../src/settler/sources.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

test("getJson retries 429 and 5xx, then gives up with the status", async () => {
  let calls = 0;
  const flaky = (async () => (++calls < 3 ? json({}, 503) : json({ ok: 1 }))) as unknown as typeof fetch;
  assert.deepEqual(await getJson("https://x.test/a", { fetchFn: flaky, baseDelayMs: 1 }), { ok: 1 });
  assert.equal(calls, 3);

  calls = 0;
  const down = (async () => (calls++, json({}, 500))) as unknown as typeof fetch;
  await assert.rejects(getJson("https://x.test/b", { fetchFn: down, tries: 2, baseDelayMs: 1 }), (e: unknown) => e instanceof HttpError && e.status === 500 && /x\.test\/b: HTTP 500/.test(e.message));
  assert.equal(calls, 3, "the first try plus two retries");
});

test("getJson doesn't retry a 4xx, and says what the server said", async () => {
  let calls = 0;
  const bad = (async () => (calls++, new Response("no such symbol", { status: 404 }))) as unknown as typeof fetch;
  await assert.rejects(getJson("https://x.test/c", { fetchFn: bad, baseDelayMs: 1 }), /HTTP 404 no such symbol/);
  assert.equal(calls, 1);
});

test("getJson passes a timeout signal, and retries an unreachable host only when asked", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  let calls = 0;
  const unreachable = (async (_url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    calls++;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(getJson("https://x.test/d", { fetchFn: unreachable, baseDelayMs: 1 }), /x\.test\/d: fetch failed/);
  assert.equal(calls, 1, "no retry by default");
  assert.ok(signals[0] instanceof AbortSignal);
  calls = 0;
  await assert.rejects(getJson("https://x.test/d", { fetchFn: unreachable, baseDelayMs: 1, tries: 2, retryNetwork: true }));
  assert.equal(calls, 3);
});

test("getJson gives up on a server that never answers", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(getJson("https://x.test/e", { fetchFn: hang, timeoutMs: 50 }), /x\.test\/e/);
  assert.ok(Date.now() - t0 < 2_000);
});

test("timedFetch adds a signal unless the caller has one", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  const f = timedFetch(1_000, (async (_u: string, init?: RequestInit) => (seen.push(init?.signal), json({}))) as unknown as typeof fetch);
  await f("https://x.test/f", { headers: { a: "b" } });
  const own = new AbortController().signal;
  await f("https://x.test/f", { signal: own });
  assert.ok(seen[0] instanceof AbortSignal);
  assert.equal(seen[1], own);
});

test("a 429 rests the source, longer each time, until a success", async () => {
  let now = 0;
  const cool = new CoolDown("src", { minMs: 1_000, maxMs: 3_000, now: () => now });
  const limited = () => Promise.reject(new HttpError("src: HTTP 429", 429));
  await assert.rejects(cool.run(limited), /HTTP 429/);
  let called = false;
  await assert.rejects(cool.run(async () => (called = true)), /rate limited, resting 1s/);
  assert.equal(called, false, "no request while resting");
  now = 1_000;
  await assert.rejects(cool.run(limited));
  now = 2_999;
  assert.equal(cool.resting, true, "the second 429 in a row rests 2 s");
  now = 3_000;
  await assert.rejects(cool.run(limited));
  now = 5_999;
  assert.equal(cool.resting, true, "capped at 3 s");
  now = 6_000;
  assert.equal(await cool.run(async () => "ok"), "ok");
  await assert.rejects(cool.run(limited));
  now = 7_000;
  assert.equal(cool.resting, false, "a success resets the streak");
  // Other errors don't rest it.
  await assert.rejects(cool.run(() => Promise.reject(new HttpError("src: HTTP 500", 500))));
  assert.equal(cool.resting, false);
});

test("sleepUnless ends early when the signal aborts", async () => {
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 20);
  await sleepUnless(10_000, ctl.signal);
  assert.ok(Date.now() - t0 < 2_000);
  await sleepUnless(10_000, ctl.signal); // already aborted: returns at once
});

/** A fake Price v3 that prices every mint it's asked for at 1 USD, recording each call. */
function priceApi() {
  const calls: { url: URL; key: string | null }[] = [];
  let status = 200;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, key: new Headers(init?.headers).get("x-api-key") });
    if (status !== 200) return json({}, status);
    const ids = u.searchParams.get("ids")!.split(",");
    return json(Object.fromEntries(ids.filter((m) => !m.startsWith("gone")).map((m) => [m, { usdPrice: 1, liquidity: 100_000 }])));
  }) as unknown as typeof fetch;
  return { calls, fetchFn, setStatus: (s: number) => (status = s) };
}

test("Jupiter: a tick's mints are read in batches of 50 on api.jup.ag with the key, then answered from memory", async () => {
  const api = priceApi();
  const now = 1_000;
  const j = new JupiterPrices("the-key", api.fetchFn, () => now);
  const mints = Array.from({ length: 120 }, (_, i) => `M${i}`);
  await j.prefetch([...mints, "M0", "gone1"]);
  assert.equal(api.calls.length, 3, "121 distinct mints: 50 + 50 + 21");
  assert.deepEqual(api.calls.map((c) => c.url.searchParams.get("ids")!.split(",").length), [JUPITER_PRICE_BATCH, JUPITER_PRICE_BATCH, 21]);
  assert.ok(api.calls.every((c) => c.url.origin === "https://api.jup.ag" && c.url.pathname === "/price/v3" && c.key === "the-key"));
  const p = await j.price("M77");
  assert.deepEqual(p, { mint: "M77", usdPrice: 1, liquidityUsd: 100_000, at: 1_000, scaledUi: null, raw: { mint: "M77", response: { usdPrice: 1, liquidity: 100_000 } } });
  assert.equal(await j.price("gone1"), null, "a mint Jupiter didn't price is remembered as unpriced too");
  assert.equal(api.calls.length, 3, "no request for prefetched mints");
  // A mint nobody prefetched is read on its own.
  await j.price("other");
  assert.equal(api.calls.length, 4);
  assert.equal(api.calls[3].url.searchParams.get("ids"), "other");
});

test("Jupiter: a cached price expires before the next tick, and the next prefetch starts clean", async () => {
  const api = priceApi();
  let now = 1_000;
  const j = new JupiterPrices("k", api.fetchFn, () => now);
  await j.prefetch(["A"]);
  now += 15;
  assert.equal((await j.price("A"))?.at, 1_000, "still this tick");
  assert.equal(api.calls.length, 1);
  now += 1;
  assert.equal((await j.price("A"))?.at, 1_016, "older than cacheSecs: read again, stamped now");
  assert.equal(api.calls.length, 2);
  now += 20;
  await j.prefetch(["B"]);
  await j.price("A");
  assert.equal(api.calls.length, 4, "the prefetch cleared A");
});

test("Jupiter: a 429 isn't retried; the source rests and makes no calls until it's over", async () => {
  const api = priceApi();
  let now = 1_000;
  const j = new JupiterPrices("k", api.fetchFn, () => now);
  api.setStatus(429);
  await assert.rejects(j.prefetch(["A", "B"]), /HTTP 429/);
  assert.equal(api.calls.length, 1);
  api.setStatus(200);
  now += 10;
  await assert.rejects(j.price("A"), /rate limited, resting/);
  assert.equal(api.calls.length, 1, "resting: no request");
  now += 30;
  assert.equal((await j.price("A"))?.usdPrice, 1);
  assert.equal(api.calls.length, 2);
});

test("Jupiter needs JUPITER_API_KEY", () => {
  assert.throws(() => new JupiterPrices("", fetch), /JUPITER_API_KEY is not set/);
});
