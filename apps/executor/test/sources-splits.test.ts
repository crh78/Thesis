// Alpaca's corporate actions (stock splits), on a synthetic response in Alpaca's shape. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AlpacaStocks } from "../src/settler/sources.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("Alpaca corporate actions: forward and reverse splits as ratios, ex-date from 06:00 UTC, in (from, until]", async () => {
  // A made-up 10-for-1 forward split and 1-for-4 reverse split, plus a dividend that isn't a split.
  const body = {
    corporate_actions: {
      forward_splits: [{ symbol: "NVDA", ex_date: "2026-12-07", new_rate: 10, old_rate: 1, cusip: "67066G104" }],
      reverse_splits: [{ symbol: "NVDA", ex_date: "2026-12-17", new_rate: 1, old_rate: 4 }],
      cash_dividends: [{ symbol: "NVDA", ex_date: "2026-12-08", rate: 0.01 }],
    },
    next_page_token: null,
  };
  const urls: string[] = [];
  const a = new AlpacaStocks("k", "s", (async (url: string) => (urls.push(url), json(body))) as unknown as typeof fetch);
  const from = Date.parse("2026-12-01T00:00:00Z") / 1000;
  const until = Date.parse("2026-12-31T00:00:00Z") / 1000;
  const s = await a.splits("NVDA", from, until);
  assert.deepEqual(s.map((x) => [new Date(x.exAt * 1000).toISOString(), x.ratio]), [["2026-12-07T06:00:00.000Z", 10], ["2026-12-17T06:00:00.000Z", 0.25]]);
  assert.match(urls[0], /\/v1\/corporate-actions\?symbols=NVDA&types=forward_split%2Creverse_split&start=2026-12-01&end=2026-12-31/);
  // A moment before the ex-date sees no split.
  assert.deepEqual(await a.splits("NVDA", from, Date.parse("2026-12-07T05:00:00Z") / 1000), []);
});
