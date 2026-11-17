// Token facts shared by the registry builder and the asset bank: which issuer a
// Jupiter token belongs to, what it tracks, its category, and its mint account
// (Token-2022 extensions, including the ScaledUiAmount multiplier).
import type { JupToken } from "./sources/jupiter.ts";
import { ISSUERS, MINT_INFO, type IssuerInfo } from "./curated.ts";

// Public Token-2022 program address (not a secret).
const T22_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // ggignore

export type TokenFacts = {
  program: "spl-token" | "token-2022" | "unknown";
  decimals: number | null;
  extensions: string[];
  permanentDelegate: string | null;
  pausable: boolean;
  paused: boolean;
  transferFeeBps: number | null;
  transferHookProgram: string | null;
  defaultAccountState: string | null;
  scaledUiMultiplier: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
};

export function issuerTagOf(t: JupToken): string | null {
  const tags = t.tags ?? [];
  for (const k of ["xstocks", "ondo", "backpack", "prestocks", "tessera", "shift"]) if (tags.includes(k)) return k;
  if (/rStock$/.test(t.name ?? "")) return "remora";
  return null;
}

export function underlyingOf(t: JupToken, tag: string | null): string | null {
  const s = t.symbol;
  if (MINT_INFO[t.id]?.underlying) return MINT_INFO[t.id].underlying!;
  switch (tag) {
    case "xstocks":
      return s.replace(/x$/, "");
    case "ondo":
      return s.replace(/on$/, "");
    case "remora":
      return s.replace(/r$/, "");
    case "backpack":
    case "prestocks":
      return s.toUpperCase();
    case "tessera":
      return s.replace(/^t/, "").toUpperCase();
    case "shift":
      return s; // themes keyed by product symbol, e.g. SOX3L
    default:
      return null;
  }
}

export function categoryOf(t: JupToken, tag: string | null): IssuerInfo["category"] | null {
  if (tag) return ISSUERS[tag].category;
  if (MINT_INFO[t.id]?.category) return MINT_INFO[t.id].category!;
  const tags = t.tags ?? [];
  if (tags.includes("jup-lend-earn")) return null; // lending receipts, covered under USDC yield
  if (tags.includes("commodities")) return "commodity";
  if (tags.includes("yb")) return "yield-token";
  if (tags.includes("rwa") || tags.includes("stocks")) return "other-rwa";
  return null;
}

export function parseMint(acc: any, epoch: number, nowSec: number): TokenFacts {
  const blank: TokenFacts = { program: "unknown", decimals: null, extensions: [], permanentDelegate: null, pausable: false, paused: false, transferFeeBps: null, transferHookProgram: null, defaultAccountState: null, scaledUiMultiplier: null, mintAuthority: null, freezeAuthority: null };
  if (!acc) return blank;
  const info = acc.data?.parsed?.info ?? {};
  const out: TokenFacts = { ...blank, program: acc.owner === T22_PROGRAM_ID ? "token-2022" : "spl-token", decimals: info.decimals ?? null, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null };
  for (const e of info.extensions ?? []) {
    out.extensions.push(e.extension);
    const st = e.state ?? {};
    if (e.extension === "permanentDelegate") out.permanentDelegate = st.delegate ?? null;
    if (e.extension === "pausableConfig") {
      out.pausable = true;
      out.paused = Boolean(st.paused);
    }
    if (e.extension === "transferFeeConfig") {
      const f = epoch >= Number(st.newerTransferFee?.epoch ?? 0) ? st.newerTransferFee : st.olderTransferFee;
      out.transferFeeBps = Number(f?.transferFeeBasisPoints ?? 0);
    }
    if (e.extension === "transferHook") out.transferHookProgram = st.programId ?? null;
    if (e.extension === "defaultAccountState") out.defaultAccountState = st.accountState ?? null;
    if (e.extension === "scaledUiAmountConfig") {
      const eff = Number(st.newMultiplierEffectiveTimestamp ?? 0);
      out.scaledUiMultiplier = Number(nowSec >= eff && eff > 0 ? st.newMultiplier : st.multiplier);
    }
  }
  return out;
}
