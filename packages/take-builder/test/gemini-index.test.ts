import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeminiContract } from "../../venues/gemini/src/markets.ts";
import { UNINDEX_AFTER_MS, indexGeminiContracts, type IndexEnv } from "../src/gemini-index.ts";

const NOW = Date.parse("2026-12-12T12:00:00Z");
const contract = (sym: string): GeminiContract => ({
  instrumentSymbol: sym, eventTicker: "UNEMP2026", eventTitle: "Unemployment rate in 2026", label: sym,
  category: "Economics", status: "active", expiry: "2027-01-08T13:30:00Z", resolutionSide: null, resolvedAt: null,
  ask: { yes: 0.1, no: 0.97 }, bid: { yes: 0.03, no: 0.9 },
});
const env: IndexEnv = { supabaseUrl: "https://p.example", secret: "s", publishableKey: "k", batch: 2, parallel: 1 };

function fakeSupabase(indexed: string[], expired: string[], thin: string[] = []) {
  const posts: any[] = [];
  const reads: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/rest/v1/securities")) {
      reads.push(url);
      const ids = url.includes("expires_at=lt.") ? expired : indexed;
      return new Response(JSON.stringify(ids.map((id) => ({ id, liquidity: thin.includes(id) ? "thin" : "tradeable" }))));
    }
    const body = JSON.parse(String(init!.body));
    posts.push(body);
    return new Response(JSON.stringify(body.unindex ? { unindexed: body.unindex.length } : { indexed: body.rows.length }));
  }) as typeof fetch;
  return { fetchFn, posts, reads };
}

test("sends only new contracts, in batches, and takes contracts expired a day ago out of search", async () => {
  const s = fakeSupabase(["gemini:A"], ["gemini:OLD1", "gemini:OLD2"]);
  const out = await indexGeminiContracts([contract("A"), contract("B"), contract("C"), contract("D")], env, { fetch: s.fetchFn, nowMs: NOW, log: () => {} });
  assert.deepEqual(s.posts.filter((p) => p.rows).map((p) => p.rows.map((r: any) => r.id)), [["gemini:B", "gemini:C"], ["gemini:D"]]);
  assert.deepEqual(s.posts.find((p) => p.unindex)?.unindex, ["gemini:OLD1", "gemini:OLD2"]);
  assert.deepEqual(out, { contracts: 4, eligible: 4, fresh: 3, indexed: 3, unindexed: 2 });
  const expiredQuery = s.reads.find((u) => u.includes("expires_at=lt."))!;
  assert.ok(expiredQuery.includes(`expires_at=lt.${new Date(NOW - UNINDEX_AFTER_MS).toISOString()}`));
  assert.ok(expiredQuery.includes("liquidity=eq.tradeable"), "only rows still in search");
});

test("a dry run reads but sends nothing, and needs no secret", async () => {
  const s = fakeSupabase([], ["gemini:OLD"]);
  const out = await indexGeminiContracts([contract("A")], { ...env, secret: null }, { dryRun: true, fetch: s.fetchFn, nowMs: NOW, log: () => {} });
  assert.equal(s.posts.length, 0);
  assert.equal(out.fresh, 1);
});
