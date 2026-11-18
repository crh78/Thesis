import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSink, SupabaseSink, cleanDirty, defaultSink } from "../src/sinks.ts";
import { getAssetBank } from "../src/read.ts";
import { buildsBusy, buildsBusyFileFor, markBuildsBusy, pricesFileFor, readBankPrices } from "../src/side-files.ts";
import { fixtureState } from "./helpers.ts";

test("file sink round-trips the state and getAssetBank reads through it", async () => {
  const sink = new FileSink(join(mkdtempSync(join(tmpdir(), "bank-")), "nested", "bank.json"));
  assert.equal(await sink.load(), null);
  const s = fixtureState();
  await sink.save(s);
  assert.deepEqual(await sink.load(), s);
  const view = await getAssetBank({ sink, now: Date.parse(s.updatedAt) });
  assert.equal(view.source, "file");
});

test("supabase sink upserts dirty rows with indexed columns and loads them back", async () => {
  const tables: Record<string, Map<string, any>> = { asset_bank_tokens: new Map(), asset_bank_underlyings: new Map(), asset_bank_venues: new Map() };
  const pk: Record<string, string> = { asset_bank_tokens: "mint", asset_bank_underlyings: "key", asset_bank_venues: "venue" };
  const seen: { method: string; path: string; prefer?: string; auth?: string }[] = [];
  const fakeFetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop()!;
    const h = init.headers as Record<string, string>;
    seen.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, prefer: h.prefer, auth: h.authorization });
    if (init.method === "POST") {
      assert.equal(u.searchParams.get("on_conflict"), pk[table]);
      for (const row of JSON.parse(String(init.body))) tables[table].set(row[pk[table]], row);
      return new Response(null, { status: 201 });
    }
    const offset = Number(u.searchParams.get("offset") ?? 0);
    return Response.json([...tables[table].values()].slice(offset, offset + 1000).map((r) => ({ data: r.data })));
  };
  const sink = new SupabaseSink("https://example.supabase.co/", "service-role-test", fakeFetch);
  const s = fixtureState();
  const dirty = cleanDirty();
  for (const m of Object.keys(s.tokens)) dirty.tokens.add(m);
  for (const k of Object.keys(s.underlyings)) dirty.underlyings.add(k);
  dirty.meta = true;
  await sink.save(s, dirty);
  // Underlyings are written before the tokens that reference them.
  const posts = seen.filter((x) => x.method === "POST").map((x) => x.path.split("?")[0].split("/").pop());
  assert.deepEqual(posts, ["asset_bank_underlyings", "asset_bank_tokens", "asset_bank_venues"]);
  assert.ok(seen.every((x) => x.auth === "Bearer service-role-test"));
  assert.match(seen[0].prefer!, /merge-duplicates/);
  const nvdax = [...tables.asset_bank_tokens.values()].find((r) => r.symbol === "NVDAx");
  assert.equal(nvdax.underlying_key, "equity:US:NVDA");
  assert.equal(nvdax.comparable, true);
  assert.equal(nvdax.us_persons, "no");
  const nvda = tables.asset_bank_underlyings.get("equity:US:NVDA");
  assert.equal(nvda.id_hex.length, 64);
  assert.equal(nvda.class, "equity");
  const loaded = await sink.load();
  assert.deepEqual(loaded!.tokens, s.tokens);
  assert.deepEqual(loaded!.underlyings, s.underlyings);
});

test("defaultSink picks the file unless ASSET_BANK_SINK=supabase, which needs its keys", () => {
  assert.equal(defaultSink(() => null).name, "file");
  assert.throws(() => defaultSink((k) => (k === "ASSET_BANK_SINK" ? "supabase" : null)), /SUPABASE_URL/);
  const env: Record<string, string> = { ASSET_BANK_SINK: "supabase", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
  assert.equal(defaultSink((k) => env[k] ?? null).name, "supabase");
});

test("the file sink also writes the token prices alone, for the fork API's display values", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "bank-")), "asset-bank.json");
  const s = fixtureState();
  await new FileSink(path).save(s);
  assert.equal(pricesFileFor(path), path.replace(/asset-bank\.json$/, "asset-bank.prices.json"));
  const p = await readBankPrices(pricesFileFor(path));
  assert.ok(p);
  const priced = Object.values(s.tokens).filter((t) => t.price && t.price.usd > 0);
  assert.ok(priced.length > 0);
  assert.equal(Object.keys(p.tokens).length, priced.length);
  const t = priced[0];
  assert.deepEqual(p.tokens[t.mint], { usd: t.price!.usd, at: t.price!.at, pooledUsd: t.jupiterPooledUsd ?? null });
  assert.equal(await readBankPrices(join(tmpdir(), "no-such-dir", "x.prices.json")), null);
});

test("the trade-builds busy file: fresh for 15 s after a touch, missing means not busy", async () => {
  const path = buildsBusyFileFor(join(mkdtempSync(join(tmpdir(), "bank-")), "nested", "asset-bank.json"));
  assert.equal(buildsBusy(path), false);
  const at = new Date(Date.now() - 1_000);
  await markBuildsBusy(path, at);
  assert.equal(buildsBusy(path, at.getTime() + 1_000), true);
  assert.equal(buildsBusy(path, at.getTime() + 14_990), true); // (file times are rounded to the microsecond)
  assert.equal(buildsBusy(path, at.getTime() + 15_010), false);
  await markBuildsBusy(path); // touching again keeps it busy
  assert.equal(buildsBusy(path), true);
});
