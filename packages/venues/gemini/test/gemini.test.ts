import assert from "node:assert/strict";
import { test } from "node:test";
import { geminiProxy, geminiRequest } from "../src/index.ts";

const env = (vars: Record<string, string>) => (k: string) => vars[k] ?? null;

test("defaults to the project's gemini function and sends the token", () => {
  const proxy = geminiProxy(env({ SUPABASE_URL: "https://abc.supabase.co/", GEMINI_PROXY_TOKEN: "t" }));
  assert.deepEqual(proxy, { base: "https://abc.supabase.co/functions/v1/gemini", token: "t" });
  const r = geminiRequest(proxy, "events", { status: "active", category: "Fun/Culture", limit: 100 });
  assert.equal(r.url, "https://abc.supabase.co/functions/v1/gemini/events?status=active&category=Fun%2FCulture&limit=100");
  assert.deepEqual(r.headers, { "x-gemini-proxy-token": "t" });
  assert.equal(geminiRequest(proxy, "categories").url, "https://abc.supabase.co/functions/v1/gemini/categories");
});

test("GEMINI_PROXY_URL overrides the default", () => {
  const proxy = geminiProxy(env({ GEMINI_PROXY_URL: "http://127.0.0.1:54321/functions/v1/gemini/", GEMINI_PROXY_TOKEN: "t" }));
  assert.equal(proxy.base, "http://127.0.0.1:54321/functions/v1/gemini");
});

test("never falls back to calling Gemini directly", () => {
  assert.throws(() => geminiProxy(env({ SUPABASE_URL: "https://abc.supabase.co" })), /GEMINI_PROXY_TOKEN/);
  assert.throws(() => geminiProxy(env({ GEMINI_PROXY_TOKEN: "t" })), /SUPABASE_URL/);
});
