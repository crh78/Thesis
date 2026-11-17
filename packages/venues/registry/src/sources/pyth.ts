// Pyth: feed IDs from the Hermes catalog (no key needed), then a chain check of
// the sponsored push accounts to see which feeds are free to read on-chain.
// Prices themselves need a Pyth API key (Hermes returns 401 without one).
import { getJson } from "../lib/http.ts";
import { Rpc, findProgramAddress } from "../lib/solana.ts";
import { COMMON_SOURCES, PYTH_PUSH_PROGRAMS } from "../curated.ts";

export type PythFeed = {
  id: string; // hex, no 0x
  symbol: string;
  access: "free-onchain" | "stale-onchain" | "needs-api-key";
  pushAccount: string | null;
  pushProgram: "core" | "compatible" | null;
  ageSeconds: number | null;
  schedule: string | null;
};

export async function loadPythCatalog(): Promise<Map<string, { id: string; schedule: string | null }>> {
  const list = await getJson<any[]>(COMMON_SOURCES.pythCatalog);
  const m = new Map<string, { id: string; schedule: string | null }>();
  for (const f of list) m.set(f.attributes.symbol, { id: f.id, schedule: f.attributes.schedule ?? null });
  return m;
}

/** Reads publish_time out of a PriceUpdateV2 account (pyth-solana-receiver-sdk layout). */
function parsePriceUpdate(dataB64: string): { feedId: string; publishTime: number } | null {
  const b = Buffer.from(dataB64, "base64");
  if (b.length < 100) return null;
  let off = 8 + 32; // discriminator + write_authority
  const variant = b[off];
  off += variant === 0 ? 2 : 1; // Partial { num_signatures: u8 } | Full
  const feedId = b.subarray(off, off + 32).toString("hex");
  const publishTime = Number(b.readBigInt64LE(off + 32 + 8 + 8 + 4));
  return { feedId, publishTime };
}

/** For each wanted symbol, derive the shard-0 push account on both Pyth push programs and check freshness. */
export async function checkPushFeeds(rpc: Rpc, catalog: Map<string, { id: string; schedule: string | null }>, symbols: string[], nowSec: number, freshSeconds = 3600): Promise<Map<string, PythFeed>> {
  const wanted = [...new Set(symbols)].filter((s) => catalog.has(s));
  const derived: { symbol: string; program: "core" | "compatible"; address: string }[] = [];
  for (const symbol of wanted) {
    const id = Buffer.from(catalog.get(symbol)!.id, "hex");
    for (const program of ["core", "compatible"] as const) {
      derived.push({ symbol, program, address: findProgramAddress([Uint8Array.of(0, 0), id], PYTH_PUSH_PROGRAMS[program]) });
    }
  }
  const accounts = await rpc.getAccounts(derived.map((d) => d.address), "base64");
  const out = new Map<string, PythFeed>();
  for (const symbol of wanted) {
    const { id, schedule } = catalog.get(symbol)!;
    let best: PythFeed = { id, symbol, access: "needs-api-key", pushAccount: null, pushProgram: null, ageSeconds: null, schedule };
    for (const d of derived.filter((x) => x.symbol === symbol)) {
      const acc = accounts.get(d.address);
      if (!acc) continue;
      const parsed = parsePriceUpdate(acc.data[0]);
      if (!parsed || parsed.feedId !== id) continue;
      const age = nowSec - parsed.publishTime;
      if (best.ageSeconds === null || age < best.ageSeconds) {
        best = { ...best, pushAccount: d.address, pushProgram: d.program, ageSeconds: age, access: age <= freshSeconds ? "free-onchain" : "stale-onchain" };
      }
    }
    out.set(symbol, best);
  }
  return out;
}
