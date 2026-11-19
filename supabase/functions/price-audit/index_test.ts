// checkEntry: what the price-audit function stores for each document (no database, no network).
import { assertEquals } from "jsr:@std/assert@1";

// index.ts makes its Supabase client on load; a stand-in project is enough, nothing is called.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const { canonicalJson, checkEntry } = await import("./index.ts");

async function entry(doc: Record<string, unknown>) {
  const canonical = canonicalJson(doc);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, canonical, network: "solana-mainnet-fork" };
}

Deno.test("a partial sale's document stores moment part and its seq", async () => {
  const r = await checkEntry(await entry({ moment: "part", momentAt: 1800000000, partSeq: 2, position: "P", take: "T", legs: [] }));
  if (!r.ok) throw new Error(r.reason);
  assertEquals([r.row.moment, r.row.moment_at, r.row.part_seq, r.row.position], ["part", 1800000000, 2, "P"]);
});

Deno.test("other moments carry no part_seq key", async () => {
  for (const moment of ["entry", "exit", "sale"]) {
    const r = await checkEntry(await entry({ moment, momentAt: 1, partSeq: 3, position: "P" }));
    if (!r.ok) throw new Error(r.reason);
    assertEquals(r.row.moment, moment);
    assertEquals("part_seq" in r.row, false);
  }
});

Deno.test("a bad partSeq or an unknown moment is stored without them", async () => {
  const bad = await checkEntry(await entry({ moment: "part", partSeq: -1 }));
  if (!bad.ok) throw new Error(bad.reason);
  assertEquals([bad.row.moment, "part_seq" in bad.row], ["part", false]);
  const other = await checkEntry(await entry({ moment: "later", partSeq: 1 }));
  if (!other.ok) throw new Error(other.reason);
  assertEquals([other.row.moment, "part_seq" in other.row], [null, false]);
});

Deno.test("a document whose hash doesn't match is refused", async () => {
  const e = await entry({ moment: "part", partSeq: 0 });
  const r = await checkEntry({ ...e, hash: "0".repeat(64) });
  assertEquals(r.ok, false);
});
