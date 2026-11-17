// Underlying identity: what a basket leg tracks, independent of which issuer's
// token a backer ends up holding.
//
// A spot leg's identity is its UNDERLYING (NVDA the stock, gold the metal), not a
// mint. NVDAx (xStocks), NVDAon (Ondo) and Backpack's NVDA all belong to
// `equity:US:NVDA`, so two backers of the same leg may hold different tokens.
//
// Key grammar (ASCII, case-sensitive, no spaces):
//
//   equity:<CC>:<TICKER>   a listed company share. CC = ISO 3166-1 alpha-2 of the listing
//                          market (US for everything we see today). TICKER = upper-case
//                          A-Z0-9 with punctuation removed (BRK.B -> BRKB).
//   etf:<CC>:<TICKER>      an exchange-traded fund, trust or ETN share (SPY, GLD, IBIT).
//                          GLD is etf:US:GLD, not commodity:XAU: a GLD share is not an ounce.
//   commodity:<CODE>       a physical commodity. Unit: one troy ounce for metals (XAU, XAG,
//                          XPT, XPD), one barrel for oil (WTI, BRENT), one pound for copper (CU).
//   private:<NAME>         a private company (pre-IPO exposure: PreStocks, Tessera, Phoenix
//                          pre-IPO perps). NAME = upper-case A-Z0-9.
//   crypto:<SYMBOL>        a crypto asset (Phoenix perps only; spot crypto is out of scope).
//   token:<MINT>           a product that is its own underlying: yield tokens (USDY,
//                          syrupUSDC), leveraged tokens (SHIFT) and other RWAs. One issuer
//                          by definition, keyed by its base58 mint so names cannot collide.
//
// On-chain id (the program's LegSpec.asset for spot legs):
//
//   underlyingId(key) = sha256(utf8("thesis:underlying:v1:" + key))   // 32 bytes
//
// Keys are permanent once a take records them. Never rename a key; if a rule here
// changes, pin the old key for the affected underlying in KEY_OVERRIDES.
import { createHash } from "node:crypto";
import { b58encode } from "../../registry/src/lib/solana.ts";

export const UNDERLYING_ID_PREFIX = "thesis:underlying:v1:";

export type UnderlyingClass = "equity" | "etf" | "commodity" | "private" | "crypto" | "token";

const KEY_RE = /^(?:(?:equity|etf):[A-Z]{2}:[A-Z0-9]{1,16}|(?:commodity|private|crypto):[A-Z0-9]{1,24}|token:[1-9A-HJ-NP-Za-km-z]{32,44})$/; // ggignore (a regex, not a secret)

export function isUnderlyingKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** 32-byte id for LegSpec.asset: sha256 of the fixed prefix plus the key. Throws on a malformed key. */
export function underlyingId(key: string): Uint8Array {
  if (!isUnderlyingKey(key)) throw new Error(`not an underlying key: ${JSON.stringify(key)}`);
  return new Uint8Array(createHash("sha256").update(UNDERLYING_ID_PREFIX + key, "utf8").digest());
}

export const underlyingIdHex = (key: string) => Buffer.from(underlyingId(key)).toString("hex");
/** The same 32 bytes as a base58 string, i.e. how a Pubkey field shows it. */
export const underlyingIdBase58 = (key: string) => b58encode(underlyingId(key));

export function parseUnderlyingKey(key: string): { cls: UnderlyingClass; market: string | null; code: string } {
  if (!isUnderlyingKey(key)) throw new Error(`not an underlying key: ${JSON.stringify(key)}`);
  const parts = key.split(":");
  if (parts.length === 3) return { cls: parts[0] as UnderlyingClass, market: parts[1], code: parts[2] };
  return { cls: parts[0] as UnderlyingClass, market: null, code: parts[1] };
}

export function normalizeTicker(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * ETFs, trusts and ETNs among the tickers the registry has seen (names checked by hand;
 * company names that merely contain "Trust" or "Schwab" were removed). Frozen so a key never
 * flips between equity: and etf: when a new issuer lists the same ticker with a different name.
 * Tickers not listed here count as ETFs only if a token name says "ETF" or "ETN".
 */
export const ETF_TICKERS = new Set(
  (
    "SQQQ DRAM COPX SCHH EWZ SPY GLD XLE USO URA SLV EWY UVXY VTI QQQ IVV VT XOP SGOV TLT SYSB VUG LIT VGK SMH SOXL VCX IJH " +
    "TQQQ SOXX BNO FXI INDA IAU CIBR USFR SHLD YEAR BIL IYW EFV AIQ SIL QYLD REMX DBC CLOA BOTZ SECU ARGT PSQ BINC BWET TIP " +
    "IGV FTGC SOXQ QTUM CPER URNM VDE DGRW BAI DYNF IGEB IWM IWF IEMG HYG NEAR SKDD SKUU SPCH NVDL MUU VOO EWJ RAM ITA TSLL " +
    "SCHF GDX MVLL NLR TMF XBI EWT EWG VXUS SOXS INTW LYTE SNXX KORU PALL PDBC ETHA VTV JAAA VNQ UNG SHY PPLT PAVE OIH IWN " +
    "KWEB IEF GLTR FLQL ITOT IEFA EFA EEM IBIT AGG DIA SPX"
  ).split(/\s+/),
);

/** Pinned keys that the rules would derive differently. Empty today. Keyed by the derived key. */
const KEY_OVERRIDES: Record<string, string> = {};

const COMMODITY_CODES: Record<string, string> = { XAU: "XAU", XAG: "XAG", XPT: "XPT", XPD: "XPD", GOLD: "XAU", SILVER: "XAG", COPPER: "CU", WTIOIL: "WTI" };

function finalize(key: string): string {
  return KEY_OVERRIDES[key] ?? key;
}

export type SpotKeyInput = {
  mint: string;
  name: string;
  /** Registry category (curated.ts IssuerInfo["category"]). */
  category: "stock" | "pre-ipo" | "leveraged" | "commodity" | "yield-token" | "other-rwa";
  /** What the registry says the token tracks (a ticker, XAU, a private company name), if anything. */
  underlying: string | null;
};

/** The underlying key for a spot token, or null if we cannot say what it tracks. */
export function spotUnderlyingKey(t: SpotKeyInput): string | null {
  switch (t.category) {
    case "stock": {
      if (!t.underlying) return null;
      const tk = normalizeTicker(t.underlying);
      if (!tk) return null;
      const etf = ETF_TICKERS.has(tk) || /\bET[FN]\b/.test(t.name);
      return finalize(`${etf ? "etf" : "equity"}:US:${tk}`);
    }
    case "commodity": {
      const code = t.underlying ? COMMODITY_CODES[normalizeTicker(t.underlying)] : undefined;
      return code ? finalize(`commodity:${code}`) : null;
    }
    case "pre-ipo":
      return t.underlying ? finalize(`private:${normalizeTicker(t.underlying)}`) : null;
    case "leveraged":
    case "yield-token":
    case "other-rwa":
      return finalize(`token:${t.mint}`);
  }
}

export type PhoenixKeyInput = { symbol: string; assetClass: string };

/**
 * Pre-IPO names Phoenix lists among "equities". SPCX is not here: SpaceX is listed, and
 * Phoenix's SPCX mid matched the SPCX share price that xStocks, Backpack and Ondo track.
 */
const PHOENIX_PRIVATE: Record<string, string> = { ANTHROPIC: "ANTHROPIC" };

/** Underlying key for a Phoenix perp, plus how many underlying units one contract unit is (kPEPE = 1,000 PEPE). */
export function phoenixUnderlyingKey(m: PhoenixKeyInput): { key: string; unitsPerContract: number } {
  const sym = m.symbol;
  if (m.assetClass === "commodities") {
    const code = COMMODITY_CODES[normalizeTicker(sym)];
    if (code) return { key: finalize(`commodity:${code}`), unitsPerContract: 1 };
  }
  if (m.assetClass === "equities") {
    const priv = PHOENIX_PRIVATE[normalizeTicker(sym)];
    if (priv) return { key: finalize(`private:${priv}`), unitsPerContract: 1 };
    const tk = normalizeTicker(sym);
    return { key: finalize(`${ETF_TICKERS.has(tk) ? "etf" : "equity"}:US:${tk}`), unitsPerContract: 1 };
  }
  const k = /^k[A-Z0-9]+$/.exec(sym) ? { code: sym.slice(1), units: 1000 } : { code: sym, units: 1 };
  return { key: finalize(`crypto:${normalizeTicker(k.code)}`), unitsPerContract: k.units };
}

/** Short display name for an underlying, from its issuers' token names ("NVIDIA xStock" -> "NVIDIA"). */
export function displayName(names: string[], key: string): string {
  const cleaned = names
    .map((n) => n.replace(/\s*(xStock|rStock|\(Ondo Tokenized\)|- Backpack Securities|Tokenized Stock)\s*$/i, "").trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  return cleaned[0] ?? parseUnderlyingKey(key).code;
}
