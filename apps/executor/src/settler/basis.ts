// A leg's price basis: which source priced its entry. Exit prices and live marks use the same
// basis, so a return compares like with like. Mixing them (entry from the issuer token, exit or
// mark from the stock) would turn the token's premium or discount to the stock, often 1-2%, into
// a gain or loss nobody made.
import { existsSync, readFileSync, statSync } from "node:fs";

export type EntryBasis =
  /**
   * Priced from the issuer token the owner bought. `premium` = token-implied price / stock price at
   * entry (stocks only). `multiplier` = the token's ScaledUiAmount multiplier at entry (1 when it has
   * none): later prices are scaled by (multiplier then / multiplier at entry), so a split or a
   * reinvested dividend, which raises it, isn't read as a loss. Absent on older entries.
   */
  | { source: "token"; mint: string; underlyingPerUiToken: number; premium: number | null; multiplier?: number; at?: number }
  /**
   * Priced from the stock's own trades. `mint` / `multiplier`: the token the owner holds and its
   * multiplier at entry, so the exit is scaled the same way (absent when unknown or older).
   * `at` (both): the entry moment, so an exit can find the stock splits since (for tokens with no
   * multiplier, e.g. Backpack). Absent on older entries: no split adjustment.
   */
  | { source: "stock"; mint?: string; multiplier?: number; at?: number }
  /** A prediction leg: the Gemini contract and the leg's side (a fade holds the other side). */
  | { source: "gemini"; eventTicker: string; instrument: string; side: "yes" | "no" }
  /** A leg held on Phoenix: its market's mark, per unit of the underlying (kPEPE is 1,000 PEPE). */
  | { source: "phoenix"; symbol: string; unitsPerContract: number }
  /** A yield leg: one share of this Jupiter Lend vault, valued in USDC. */
  | { source: "lend"; shareMint: string }
  /** A card leg: this Collector Crypt card, at its insured value in USD. */
  | { source: "card"; cardId: string };

export const basisKey = (position: string, leg: number) => `${position}:${leg}`;

type AuditLeg = { leg: number; rule?: string; price?: number; basis?: EntryBasis; inputs?: Record<string, any> };

/** The basis of one leg of an entry document in the audit log (older documents have no `basis` field). */
export function basisFromAuditLeg(l: AuditLeg): EntryBasis | null {
  if (l.basis) return l.basis;
  if (l.rule === "stock-first-trade") return { source: "stock" };
  if (l.rule === "issuer-token") {
    const mint = l.inputs?.token?.mint;
    const perUi = l.inputs?.underlyingPerUiToken;
    const ref = l.inputs?.bandRef?.trade?.p;
    if (typeof mint !== "string" || typeof perUi !== "number") return null;
    return { source: "token", mint, underlyingPerUiToken: perUi, premium: typeof ref === "number" && ref > 0 && l.price ? l.price / ref : null };
  }
  return null;
}

/** Entry bases from audit documents, keyed `position:leg`. Later documents win (a re-sent entry). */
export function entryBases(docs: Iterable<unknown>): Map<string, EntryBasis> {
  const out = new Map<string, EntryBasis>();
  for (const raw of docs) {
    const doc = raw as { moment?: string; position?: string; legs?: AuditLeg[] };
    if (doc?.moment !== "entry" || typeof doc.position !== "string" || !Array.isArray(doc.legs)) continue;
    for (const l of doc.legs) {
      const b = basisFromAuditLeg(l);
      if (b) out.set(basisKey(doc.position, l.leg), b);
    }
  }
  return out;
}

/** Reads an audit JSON-lines file's documents. Unreadable lines are skipped. */
export function readAuditDocs(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const docs: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      docs.push(JSON.parse(line).doc);
    } catch {
      // a partly written last line
    }
  }
  return docs;
}

/** Entry bases from an audit file, re-read only when the file changes. */
export class AuditBases {
  path: string;
  #mtime = -1;
  #size = -1;
  #bases = new Map<string, EntryBasis>();
  constructor(path: string) {
    this.path = path;
  }
  get(position: string, leg: number): EntryBasis | null {
    this.#refresh();
    return this.#bases.get(basisKey(position, leg)) ?? null;
  }
  #refresh() {
    if (!existsSync(this.path)) return;
    const st = statSync(this.path);
    if (st.mtimeMs === this.#mtime && st.size === this.#size) return;
    this.#bases = entryBases(readAuditDocs(this.path));
    this.#mtime = st.mtimeMs;
    this.#size = st.size;
  }
}
