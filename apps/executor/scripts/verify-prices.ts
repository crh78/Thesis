// verify-prices: checks every price the settler signed for a position against the market data
// it says it priced from. Anyone can run it: everything it reads is public.
//
//   node apps/executor/scripts/verify-prices.ts <position | on-chain take | take id> [--rpc <url>] [--raw]
//
// For each record_entry/exit/sale_prices of the position:
//   1. the on-chain source_hash, from the transaction itself (RPC: its event, and the prices in
//      the instruction), or from the stream's copy (public.price_events()) when no RPC is reachable;
//   2. the published document with that hash (public.price_audit);
//   3. sha256(document) == the on-chain hash, the document is about this position and moment,
//      and every leg's priceUnits / publishedAt in it equals what went on chain;
//   4. what each leg was priced from (the raw Jupiter / Alpaca / Gemini / Phoenix / Jupiter Lend
//      response), so it can be checked against the source's own history. --raw prints it whole.
// Exits non-zero if any check fails. Read-only.
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { thesisProgram, thesisTransactionEvents } from "@thesis/chain";
import { envVar } from "../../../packages/venues/registry/src/lib/env.ts";
import { canonicalJson } from "../src/settler/audit.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : null;
};
const target = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--rpc"));
if (!target) {
  console.log("usage: verify-prices.ts <position | on-chain take | take id> [--rpc <url>] [--raw]");
  process.exit(2);
}
const RAW = args.includes("--raw");
const SUPABASE_URL = (envVar("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const KEY = envVar("SUPABASE_PUBLISHABLE_KEY") ?? "";
const H = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function rest<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path.split("?")[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}
async function rpcFn<T>(fn: string, body: unknown): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hexOf = (bytes: ArrayLike<number>) => Buffer.from(Array.from(bytes)).toString("hex");
const MOMENT: Record<string, string> = { entryPricesRecorded: "entry", exitPricesRecorded: "exit", salePricesRecorded: "sale" };
const IX_MOMENT: Record<string, string> = { recordEntryPrices: "entry", recordExitPrices: "exit", recordSalePrices: "sale" };

type OnChainPrice = { leg: number; price: string; publishedAt: number };
type PriceEvent = { signature: string; slot: number | null; moment: string; hash: string; prices: OnChainPrice[] | null };

// --- Which positions -------------------------------------------------------------------------------
async function positionsFor(t: string): Promise<{ positions: string[]; network: string | null }> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    const takes = await rest<{ address: string; network: string }[]>(`chain_takes?select=address,network&take_id=eq.${t}`);
    if (!takes.length) throw new Error(`take ${t} isn't on chain`);
    const ps = await rest<{ address: string }[]>(`chain_positions?select=address&take=in.(${takes.map((x) => `"${x.address}"`).join(",")})&order=opened_at`);
    return { positions: ps.map((p) => p.address), network: takes[0].network };
  }
  const asPosition = await rest<{ address: string; network: string }[]>(`chain_positions?select=address,network&address=eq.${t}`);
  if (asPosition.length) return { positions: [t], network: asPosition[0].network };
  const asTake = await rest<{ address: string; network: string }[]>(`chain_positions?select=address,network&take=eq.${t}&order=opened_at`);
  if (asTake.length) return { positions: asTake.map((p) => p.address), network: asTake[0].network };
  return { positions: [t], network: null }; // not in the database yet: try the chain directly
}

// --- On-chain hashes and prices --------------------------------------------------------------------
async function fromChain(conn: Connection, position: string): Promise<PriceEvent[]> {
  const program = thesisProgram(conn);
  const pid = program.programId.toBase58();
  const out: PriceEvent[] = [];
  const sigs = await conn.getSignaturesForAddress(new PublicKey(position), { limit: 1000 }, "confirmed");
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    // The prices, from the record instruction itself.
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
    const ixPrices = new Map<string, OnChainPrice[]>();
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== pid) continue;
      // BorshInstructionCoder decodes; the InstructionCoder interface only types encode.
      const dec = (program.coder.instruction as unknown as { decode(b: Buffer): { name: string; data: any } | null }).decode(Buffer.from(ix.data));
      const moment = dec && IX_MOMENT[dec.name];
      if (!moment) continue;
      const a = dec.data.args;
      ixPrices.set(`${moment}:${hexOf(a.sourceHash)}`, a.prices.map((p: any) => ({ leg: Number(p.leg), price: p.price.toString(), publishedAt: Number(p.publishedAt.toString()) })));
    }
    // The hashes, from the program's events.
    for (const e of thesisTransactionEvents(program, tx as any)) {
      const moment = MOMENT[e.name];
      if (!moment) continue;
      const d = e.data as { position: PublicKey; sourceHash: number[] };
      if (d.position.toBase58() !== position) continue;
      const hash = hexOf(d.sourceHash);
      out.push({ signature: s.signature, slot: s.slot, moment, hash, prices: ixPrices.get(`${moment}:${hash}`) ?? null });
    }
  }
  return out;
}

async function fromStream(position: string, network: string | null): Promise<PriceEvent[]> {
  const rows = await rpcFn<{ signature: string; slot: number | null; name: string; source_hash: string }[]>("price_events", { p_position: position, p_network: network });
  return rows.map((r) => ({ signature: r.signature, slot: r.slot, moment: MOMENT[r.name], hash: r.source_hash, prices: null }));
}

// --- What a leg was priced from --------------------------------------------------------------------
function sourceSummary(l: any): string {
  const i = l.inputs ?? {};
  const parts: string[] = [];
  const tok = i.token?.response;
  if (tok) parts.push(`Jupiter ${i.token.mint?.slice(0, 6) ?? ""}… usdPrice ${tok.usdPrice} liquidity $${Math.round(tok.liquidity ?? 0).toLocaleString()}${tok.scaledUiConfig ? ` multiplier ${tok.scaledUiConfig.multiplier}` : ""}`);
  if (i.multiplier != null) parts.push(`multiplier now ${i.multiplier}${i.entryMultiplier ? ` / at entry ${i.entryMultiplier}` : ""}`);
  const tr = i.trade?.trade;
  if (tr) parts.push(`Alpaca ${i.trade.symbol} trade $${tr.p} at ${tr.t} (${i.trade.feed})`);
  const ref = i.stockRef?.trade;
  if (ref) parts.push(`stock ref $${ref.p} at ${ref.t}`);
  if (i.premium) parts.push(`premium ${i.premium}`);
  if (i.tokenOutOfBand) parts.push(`token out of band (${i.tokenOutOfBand.tokenImplied} vs stock, band ${i.tokenOutOfBand.bandPct}%)`);
  if (i.instrument) parts.push(`Gemini ${i.instrument} ${i.side} held ${i.held}: ask ${JSON.stringify(i.ask)} bid ${JSON.stringify(i.bid)}${i.resolutionSide ? ` resolved ${i.resolutionSide}` : ""}`);
  if (i.shareMint) parts.push(`Jupiter Lend ${i.shareMint.slice(0, 6)}… ${JSON.stringify(i.value)}`);
  if (i.bar || i.mark) parts.push(`Phoenix ${JSON.stringify(i.bar ?? i.mark)}`);
  return parts.join("; ") || JSON.stringify(i).slice(0, 160);
}

// --- Main ------------------------------------------------------------------------------------------
const { positions, network } = await positionsFor(target);
const rpcUrl = opt("rpc") ?? envVar("SOLANA_RPC_URL") ?? (network === "solana-mainnet" ? envVar("QUICKNODE_RPC_URL") : null) ?? "http://127.0.0.1:18899";
const conn = new Connection(rpcUrl, "confirmed");
const chainUp = await conn.getSlot().then(() => true).catch(() => false);
console.log(`${positions.length} position(s)${network ? ` on ${network}` : ""}; hashes and prices from ${chainUp ? `the chain (${new URL(rpcUrl).host})` : "the stream's copy (no RPC reachable: prices can't be compared)"}\n`);

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`    ✖ ${m}`);
};
for (const position of positions) {
  console.log(`position ${position}`);
  const events = chainUp ? await fromChain(conn, position) : await fromStream(position, network).catch((e) => {
    fail(`can't read the on-chain hashes: no RPC, and price_events() failed (${e instanceof Error ? e.message.slice(0, 120) : e})`);
    return null;
  });
  if (!events) continue;
  if (!events.length) {
    console.log("    no signed prices yet\n");
    continue;
  }
  const docs = new Map(
    (await rest<{ hash: string; canonical: string }[]>(`price_audit?select=hash,canonical&hash=in.(${events.map((e) => e.hash).join(",")})`)).map((r) => [r.hash, r.canonical]),
  );
  for (const e of events) {
    console.log(`  ${e.moment.padEnd(5)} ${e.signature.slice(0, 16)}…  slot ${e.slot ?? "?"}  hash ${e.hash.slice(0, 16)}…`);
    const before = failures;
    const canonical = docs.get(e.hash);
    if (!canonical) {
      fail("no document published for this hash (price_audit): these prices can't be checked");
      continue;
    }
    if (sha256(canonical) !== e.hash) fail("sha256(document) isn't the on-chain hash");
    let doc: any;
    try {
      doc = JSON.parse(canonical);
    } catch {
      fail("the document isn't JSON");
      continue;
    }
    if (canonicalJson(doc) !== canonical) fail("the document isn't in canonical form");
    if (doc.position !== position) fail(`the document is about position ${doc.position}`);
    if (doc.moment !== e.moment) fail(`the document is a ${doc.moment}, the chain says ${e.moment}`);
    const legs: any[] = doc.legs ?? [];
    if (e.prices) {
      const byLeg = new Map(legs.map((l) => [Number(l.leg), l]));
      if (e.prices.length !== legs.length) fail(`${e.prices.length} legs on chain, ${legs.length} in the document`);
      for (const p of e.prices) {
        const l = byLeg.get(p.leg);
        if (!l) fail(`leg ${p.leg} is on chain but not in the document`);
        else if (String(l.priceUnits) !== p.price) fail(`leg ${p.leg}: on chain ${p.price}, document ${l.priceUnits}`);
        else if (Number(l.publishedAt) !== p.publishedAt) fail(`leg ${p.leg}: published at ${p.publishedAt} on chain, ${l.publishedAt} in the document`);
      }
    }
    for (const l of legs) {
      console.log(`    leg ${l.leg}  $${l.price}  (${l.priceUnits} units)  ${l.rule}  at ${new Date(Number(l.publishedAt) * 1000).toISOString()}  basis ${l.basis?.source ?? "?"}`);
      console.log(`           ${sourceSummary(l)}`);
      if (RAW) console.log(JSON.stringify(l.inputs, null, 2).replace(/^/gm, "           "));
    }
    if (failures === before) console.log(`    ✔ hash, position, moment${e.prices ? ", prices" : ""} match`);
  }
  console.log("");
}
console.log(failures ? `${failures} check(s) failed` : "every published document matches the chain");
process.exit(failures ? 1 : 0);
