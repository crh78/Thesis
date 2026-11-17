// Liquidity registry builder. Pulls live data from Jupiter, Solana mainnet,
// Pyth, Phoenix, Kamino, Jupiter Lend, Collector Crypt and Gemini, then writes
//   packages/venues/registry/assets.json   (for the AI take builder)
//   docs/liquidity.md                       (for people)
//
// Run from the repo root:  node packages/venues/registry/src/build.ts
// Flags:
//   --quote-floor=<usd>   only quote tokens whose Jupiter pooled liquidity is >= this (default 100)
//   --max-quotes=<n>      cap the number of tokens quoted (for quick test runs)
//   --skip=<a,b>          skip sections: phoenix, yield, cards, gemini, quotes
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeEnv, loadEnv } from "./lib/env.ts";
import { Rpc } from "./lib/solana.ts";
import { Jupiter, type JupToken, type Quote } from "./sources/jupiter.ts";
import { checkPushFeeds, loadPythCatalog, type PythFeed } from "./sources/pyth.ts";
import { loadPhoenix, type PhoenixSnapshot } from "./sources/phoenix.ts";
import { loadJupiterLend, loadKamino, type YieldVault } from "./sources/yield.ts";
import { loadCollectorCrypt, type CardsSummary } from "./sources/cards.ts";
import { loadGemini, type GeminiSummary } from "./sources/gemini.ts";
import { COMMON_SOURCES, ISSUERS, MINT_INFO, PERMISSIONED, PHOENIX_PYTH, themesFor, type IssuerInfo, type Source } from "./curated.ts";
import { renderMarkdown } from "./render.ts";
import { categoryOf, issuerTagOf, parseMint, underlyingOf, type TokenFacts } from "./tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(here, "..");
const REPO_ROOT = resolve(REGISTRY_DIR, "../../..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const QUOTE_FLOOR = Number(args["quote-floor"] ?? 100);
const MAX_QUOTES = args["max-quotes"] ? Number(args["max-quotes"]) : Infinity;
const SKIP = new Set(String(args.skip ?? "").split(",").filter(Boolean));
const TRADEABLE_RULE =
  "tradeable = a $100 USDC buy routes on Jupiter with maxAccounts=30 and costs < 1%, where cost = the worst of Jupiter's priceImpactPct, slippage vs the $10 quote's rate, and the shortfall vs Jupiter's USD price (UI-multiplier adjusted), plus any Token-2022 transfer fee. thin = routes but costs more, or only $10 routes. price-only = no usable route but a Jupiter or Pyth price exists. no-market = neither.";
// A sponsored push feed that updated within 4 days counts as free on-chain (covers weekends and market close).
const PYTH_FRESH_SECONDS = 4 * 86400;

export type LiquidityClass = "tradeable" | "thin" | "price-only" | "no-market" | "excluded";

export type PythRef = { symbol: string; id: string; access: PythFeed["access"]; pushAccount: string | null } | null;

export type SpotAsset = {
  id: string;
  kind: "spot-token";
  category: IssuerInfo["category"];
  symbol: string;
  name: string;
  issuer: string;
  issuerTag: string | null;
  venue: "Jupiter";
  mint: string;
  underlying: string | null;
  themes: string[];
  token: TokenFacts;

  pyth: { token: PythRef; underlying: PythRef };
  restrictions: string[];
  excluded: boolean;
  excludedReason: string | null;
  liquidity: {
    class: LiquidityClass;
    classReason: string;
    measuredAt: string | null;
    maxAccounts: 30;
    jupiterPooledUsd: number | null;
    jupiterUsdPrice: number | null;
    holders: number | null;
    volume24hUsd: number | null;
    quotes: Quote[] | null;
    buyCost100Pct: number | null;
    buyCost1000Pct?: number | null;
  };
  sources: Source[];
  unverified: string[];
};

export type Registry = {
  generatedAt: string;
  generator: string;
  inputs: { jupiter: string; rpc: string; keys: string; quoteFloorUsd: number; quoteSizesUsd: number[]; maxAccounts: 30; tradeableRule: string };
  gaps: string[];
  counts: Record<string, Record<LiquidityClass, number>>;
  /** Issuer-wide facts; join on spot[].issuerTag. */
  issuers: typeof ISSUERS;
  /** Per-asset source URLs follow these templates ({mint} is the asset's mint). */
  sourceTemplates: Record<string, string>;
  spot: SpotAsset[];
  permissioned: typeof PERMISSIONED;
  phoenix: (PhoenixSnapshot & { measuredAt: string; restrictions: string[]; sources: Source[]; markets: (PhoenixSnapshot["markets"][number] & { pyth: PythRef; themes: string[]; class: LiquidityClass })[] }) | null;
  usdcYield: { measuredAt: string; kaminoUsdcVaultCount: number; vaults: YieldVault[]; sources: Source[] } | null;
  cards: (CardsSummary & { measuredAt: string; tokenStandards: string; marketplaceProgram: string; restrictions: string[]; sources: Source[] }) | null;
  gemini: (GeminiSummary & { measuredAt: string; custody: string; restrictions: string[]; sources: Source[] }) | null;
};

function classify(a: SpotAsset): { cls: LiquidityClass; reason: string; cost: number | null } {
  if (a.excluded) return { cls: "excluded", reason: a.excludedReason ?? "excluded", cost: null };
  const q = a.liquidity.quotes;
  const fee = (a.token.transferFeeBps ?? 0) / 100;
  const hasPrice = (a.liquidity.jupiterUsdPrice ?? 0) > 0 || Boolean(a.pyth.token || a.pyth.underlying);
  if (!q) {
    const pooled = a.liquidity.jupiterPooledUsd ?? 0;
    const why = pooled >= QUOTE_FLOOR ? "not quoted this run (--max-quotes cap or quote error)" : `not quoted: Jupiter reports $${pooled.toFixed(0)} pooled liquidity (< $${QUOTE_FLOOR} floor)`;
    return hasPrice ? { cls: "price-only", reason: why, cost: null } : { cls: "no-market", reason: `${why}; no price anywhere`, cost: null };
  }
  // Cost of each routed quote: the worst of Jupiter's priceImpactPct, slippage vs the $10 rate, and the
  // shortfall vs Jupiter's USD price (per UI token, so raw amounts are scaled by the UI multiplier), plus transfer fee.
  const price = a.liquidity.jupiterUsdPrice ?? 0;
  const dec = a.token.decimals ?? 0;
  const mult = a.token.scaledUiMultiplier ?? 1;
  for (const x of q) {
    if (!x.routed) continue;
    x.costVsRefPct = price > 0 ? Math.max(0, (1 - ((Number(x.outAmountRaw) / 10 ** dec) * mult * price) / x.usd) * 100) : null;
    x.costPct = Math.max(x.priceImpactPct ?? 0, x.impactVsSmallestPct ?? 0, x.costVsRefPct ?? 0) + fee;
  }
  const q1000 = q.find((x) => x.usd === 1000);
  a.liquidity.buyCost1000Pct = q1000?.routed ? (q1000.costPct ?? null) : null;
  const q100 = q.find((x) => x.usd === 100)!;
  const anyRouted = q.some((x) => x.routed);
  if (q100.routed) {
    const cost = q100.costPct!;
    if (a.token.paused) return { cls: "price-only", reason: "mint is paused", cost };
    if (cost < 1) return { cls: "tradeable", reason: `$100 buy routes, cost ${cost.toFixed(2)}% (< 1%)`, cost };
    return { cls: "thin", reason: `$100 buy routes but costs ${cost.toFixed(2)}%${fee ? ` incl. ${fee}% transfer fee` : ""}`, cost };
  }
  if (anyRouted) return { cls: "thin", reason: `only $10 routes ($100: ${q100.error})`, cost: null };
  return hasPrice ? { cls: "price-only", reason: `no route at maxAccounts=30 (${q100.error})`, cost: null } : { cls: "no-market", reason: `no route (${q100.error}) and no price`, cost: null };
}

/** Classifies every spot asset, sorts tradeable first, and returns counts per category:issuer. */
function finalizeSpot(spot: SpotAsset[]): Registry["counts"] {
  for (const a of spot) {
    const c = classify(a);
    a.liquidity.class = c.cls;
    a.liquidity.classReason = c.reason;
    a.liquidity.buyCost100Pct = c.cost;
  }
  const order: LiquidityClass[] = ["tradeable", "thin", "price-only", "no-market", "excluded"];
  const counts: Registry["counts"] = {};
  for (const a of spot) {
    const k = a.issuerTag ? `${a.category}:${a.issuerTag}` : a.category;
    counts[k] ??= { tradeable: 0, thin: 0, "price-only": 0, "no-market": 0, excluded: 0 };
    counts[k][a.liquidity.class]++;
  }
  spot.sort((a, b) => order.indexOf(a.liquidity.class) - order.indexOf(b.liquidity.class) || (b.liquidity.jupiterPooledUsd ?? 0) - (a.liquidity.jupiterPooledUsd ?? 0));
  return counts;
}

/** Drops null, false and empty values inside an asset so 2,000+ records stay small. */
function prune(v: any): any {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === false || (Array.isArray(x) && x.length === 0)) continue;
      o[k] = prune(x);
    }
    return o;
  }
  return v;
}

/** Pretty top level, one line per spot asset and per perp market (small and diff-friendly). */
function serialize(r: Registry): string {
  const { spot, phoenix, ...rest } = r;
  // Tokens with no route and no price anywhere are listed compactly: [symbol, mint, issuerTag, category].
  const listed = spot.filter((a) => a.liquidity.class !== "no-market");
  const noMarket = spot.filter((a) => a.liquidity.class === "no-market").map((a) => [a.symbol, a.mint, a.issuerTag, a.category]);
  const slim = (a: SpotAsset) => {
    const { mintAuthority, freezeAuthority, ...token } = a.token;
    return { ...a, token };
  };
  const head = JSON.stringify({ ...rest, phoenix: phoenix ? { ...phoenix, markets: "__PHX__" } : null }, null, 2);
  const lines = (xs: any[]) => (xs.length ? `[\n${xs.map((x) => "    " + JSON.stringify(prune(x))).join(",\n")}\n  ]` : "[]");
  let out = head.replace(/\n}$/, `,\n  "noMarketFormat": ["symbol", "mint", "issuerTag", "category"],\n  "noMarket": ${lines(noMarket)},\n  "spot": ${lines(listed.map(slim))}\n}`);
  if (phoenix) out = out.replace('"markets": "__PHX__"', `"markets": ${lines(phoenix.markets).replace(/\n/g, "\n  ")}`);
  JSON.parse(out); // sanity: must stay valid JSON
  return out + "\n";
}

function pythRef(f: PythFeed | undefined): PythRef {
  return f ? { symbol: f.symbol, id: f.id, access: f.access, pushAccount: f.pushAccount } : null;
}

/** Rebuilds the in-memory registry from assets.json (re-adding pruned defaults) so the doc can be re-rendered without new API calls. */
function rehydrate(json: any): Registry {
  const fix = (a: any): SpotAsset => ({
    ...a,
    themes: a.themes ?? [],
    restrictions: a.restrictions ?? [],
    unverified: a.unverified ?? [],
    sources: a.sources ?? [],
    pyth: { token: a.pyth?.token ?? null, underlying: a.pyth?.underlying ?? null },
    token: { extensions: [], ...a.token },
    liquidity: { quotes: null, ...a.liquidity },
  });
  const noMarket = (json.noMarket ?? []).map(([symbol, mint, issuerTag, category]: string[]) =>
    fix({ symbol, mint, issuerTag: issuerTag ?? null, category, name: symbol, issuer: "", liquidity: { class: "no-market", classReason: "no route and no price" } }),
  );
  return {
    ...json,
    spot: [...json.spot.map(fix), ...noMarket],
    phoenix: json.phoenix ? { ...json.phoenix, markets: json.phoenix.markets.map((m: any) => ({ themes: [], ...m })) } : null,
  };
}

async function main() {
  const t0 = Date.now();
  if (args["render-only"]) {
    const { readFileSync } = await import("node:fs");
    // Re-derives classes from the stored quotes (so rule changes apply) and rewrites both files.
    const jsonPath = resolve(REGISTRY_DIR, "assets.json");
    const reg = rehydrate(JSON.parse(readFileSync(jsonPath, "utf8")));
    reg.counts = finalizeSpot(reg.spot);
    reg.inputs.tradeableRule = TRADEABLE_RULE;
    writeFileSync(jsonPath, serialize(reg));
    writeFileSync(resolve(REPO_ROOT, "docs/liquidity.md"), renderMarkdown(reg));
    console.log("re-classified from stored quotes and re-rendered assets.json + docs/liquidity.md (no API calls)");
    return;
  }
  const env = loadEnv();
  const rpc = new Rpc(env.rpcUrl);
  const jup = new Jupiter(env.jupiterApiKey);
  const nowSec = Math.floor(Date.now() / 1000);
  const generatedAt = new Date().toISOString();
  const gaps: string[] = [];
  console.log(`env: ${describeEnv(env)}`);
  console.log(`rpc: ${rpc.label}; jupiter: ${jup.label}`);
  if (!env.rpcUrl) gaps.push("QUICKNODE_RPC_URL is empty: on-chain reads used the public mainnet-beta RPC (rate-limited, fine for this script).");
  if (!env.jupiterApiKey) gaps.push(`JUPITER_API_KEY is empty: quotes used the free lite-api.jup.ag (about 5 requests per window), so only tokens with >= $${QUOTE_FLOOR} pooled liquidity were quoted.`);
  if (!env.pythApiKey) gaps.push("PYTH_API_KEY is empty: Pyth prices were not fetched. Feed IDs come from the keyless Hermes catalog; 'free on-chain' is decided by reading the sponsored push accounts on mainnet.");

  // Kick off the independent venues while Jupiter quotes run (different hosts).
  const side = {
    phoenix: SKIP.has("phoenix") ? null : loadPhoenix().catch((e) => (gaps.push(`Phoenix failed: ${e.message}`), null)),
    kamino: SKIP.has("yield") ? null : loadKamino().catch((e) => (gaps.push(`Kamino failed: ${e.message}`), null)),
    jupLend: SKIP.has("yield") ? null : loadJupiterLend().catch((e) => (gaps.push(`Jupiter Lend failed: ${e.message}`), null)),
    cards: SKIP.has("cards") ? null : loadCollectorCrypt().catch((e) => (gaps.push(`Collector Crypt failed: ${e.message}`), null)),
    gemini: SKIP.has("gemini") ? null : loadGemini().catch((e) => (gaps.push(`Gemini failed: ${e.message}`), null)),
  };

  console.log("jupiter: loading verified token list");
  const verified = await jup.verifiedTokens();
  let remora: JupToken[] = [];
  try {
    remora = (await jup.search("rStock")).filter((t) => /rStock$/.test(t.name ?? ""));
  } catch (e) {
    gaps.push(`Remora rStocks search failed: ${(e as Error).message}`);
  }
  const byMint = new Map<string, JupToken>();
  for (const t of [...verified, ...remora]) byMint.set(t.id, t);
  const universe = [...byMint.values()].filter((t) => categoryOf(t, issuerTagOf(t)) !== null);
  console.log(`universe: ${universe.length} tokens (from ${verified.length} verified + ${remora.length} rStocks)`);

  const [epochInfo, mints, catalog] = await Promise.all([rpc.call<any>("getEpochInfo", []), rpc.getAccounts(universe.map((t) => t.id), "jsonParsed"), loadPythCatalog()]);

  // Pyth symbols for every token: the token's own feed, then the underlying.
  const pythWant = (t: JupToken, tag: string | null, und: string | null) => {
    const own = MINT_INFO[t.id]?.pyth ?? `Crypto.${t.symbol.toUpperCase()}/USD`;
    let u: string | null = null;
    if (und === "XAU") u = "Metal.XAU/USD";
    else if (und === "XAG") u = "Metal.XAG/USD";
    else if (und && (tag === "prestocks" || tag === "tessera")) u = `Equity.Index.${und}/USD`;
    else if (und && tag && tag !== "shift") u = `Equity.US.${und}/USD`;
    return { own: catalog.has(own) ? own : null, und: u && catalog.has(u) ? u : null };
  };

  const phoenixSnap = await side.phoenix;
  const phoenixPythSymbols = (phoenixSnap?.markets ?? []).map((m) => PHOENIX_PYTH[m.symbol] ?? (m.assetClass === "equities" ? `Equity.US.${m.symbol}/USD` : `Crypto.${m.symbol}/USD`));
  const wanted = universe.flatMap((t) => {
    const tag = issuerTagOf(t);
    const p = pythWant(t, tag, underlyingOf(t, tag));
    return [p.own, p.und].filter(Boolean) as string[];
  });
  console.log("pyth: checking sponsored push accounts on mainnet");
  const feeds = await checkPushFeeds(rpc, catalog, [...wanted, ...phoenixPythSymbols], nowSec, PYTH_FRESH_SECONDS);

  const spot: SpotAsset[] = universe.map((t) => {
    const tag = issuerTagOf(t);
    const und = underlyingOf(t, tag);
    const cat = categoryOf(t, tag)!;
    const iss = tag ? ISSUERS[tag] : null;
    const mi = MINT_INFO[t.id];
    const token = parseMint(mints.get(t.id), Number(epochInfo.epoch), nowSec);
    const p = pythWant(t, tag, und);
    // Issuer-wide restrictions, sources and unverified notes live once in registry.issuers[issuerTag];
    // per-asset fields hold only what is specific to this mint.
    const restrictions = [...(mi?.restrictions ?? [])];
    if (token.transferFeeBps) restrictions.push(`Token-2022 transfer fee: ${token.transferFeeBps / 100}% on every transfer.`);
    if (token.transferHookProgram) restrictions.push(`Transfer hook program ${token.transferHookProgram} runs on every transfer (may enforce an allowlist; unverified).`);
    if (token.permanentDelegate && !iss && !restrictions.some((r) => /permanent delegate/i.test(r))) restrictions.push("Issuer holds a permanent delegate (can move or burn holders' tokens).");
    if (token.paused) restrictions.push("Mint is currently PAUSED: transfers fail.");
    const defaultFrozen = token.defaultAccountState === "frozen";
    if (defaultFrozen) restrictions.push("New token accounts start frozen: the issuer must thaw (allowlist) each holder.");
    const unverified = [...(mi?.unverified ?? [])];
    if (!tag && !mi) unverified.push("issuer: not in curated list; name comes from Jupiter token metadata");
    const a: SpotAsset = {
      id: `jup:${t.id}`,
      kind: "spot-token",
      category: cat,
      symbol: t.symbol,
      name: t.name,
      issuer: iss?.issuer ?? mi?.issuer ?? `unverified (${t.name})`,
      issuerTag: tag,
      venue: "Jupiter",
      mint: t.id,
      underlying: und,
      themes: [...new Set([...themesFor(und), ...themesFor(t.symbol), ...(cat === "commodity" ? ["Commodities"] : [])])],
      token,
      pyth: { token: pythRef(p.own ? feeds.get(p.own) : undefined), underlying: pythRef(p.und ? feeds.get(p.und) : undefined) },
      restrictions,
      excluded: defaultFrozen,
      excludedReason: defaultFrozen ? "permissioned: default-frozen token accounts (issuer allowlist)" : null,
      liquidity: {
        class: "no-market",
        classReason: "",
        measuredAt: null,
        maxAccounts: 30,
        jupiterPooledUsd: t.liquidity ?? null,
        jupiterUsdPrice: t.usdPrice ?? null,
        holders: t.holderCount ?? null,
        volume24hUsd: t.stats24h ? (t.stats24h.buyVolume ?? 0) + (t.stats24h.sellVolume ?? 0) : null,
        quotes: null,
        buyCost100Pct: null,
      },
      sources: [...(mi?.sources ?? [])],
      unverified,
    };
    return a;
  });

  // Live quotes, biggest pools first so a partial run still covers what matters.
  const toQuote = SKIP.has("quotes")
    ? []
    : spot
        .filter((a) => !a.excluded && (a.liquidity.jupiterPooledUsd ?? 0) >= QUOTE_FLOOR)
        .sort((a, b) => (b.liquidity.jupiterPooledUsd ?? 0) - (a.liquidity.jupiterPooledUsd ?? 0))
        .slice(0, MAX_QUOTES);
  console.log(`jupiter: quoting ${toQuote.length} tokens at $10/$100/$1000, maxAccounts=30`);
  let done = 0;
  for (const a of toQuote) {
    try {
      a.liquidity.quotes = await jup.ladder(a.mint);
      a.liquidity.measuredAt = new Date().toISOString();
    } catch (e) {
      a.unverified.push(`quote failed: ${(e as Error).message.slice(0, 120)}`);
    }
    if (++done % 10 === 0 || done === toQuote.length) console.log(`  quoted ${done}/${toQuote.length} (last: ${a.symbol})`);
  }
  const counts = finalizeSpot(spot);

  if (rpc.fallbackReason) gaps.push(`${rpc.fallbackReason}. Check the URL includes the QuickNode token path.`);
  const [kamino, jupLend, cards, gemini] = await Promise.all([side.kamino, side.jupLend, side.cards, side.gemini]);
  const measuredAt = new Date().toISOString();

  const registry: Registry = {
    generatedAt,
    generator: "node packages/venues/registry/src/build.ts",
    inputs: {
      jupiter: jup.label,
      rpc: rpc.label,
      keys: describeEnv(env),
      quoteFloorUsd: QUOTE_FLOOR,
      quoteSizesUsd: [10, 100, 1000],
      maxAccounts: 30,
      tradeableRule: TRADEABLE_RULE,
    },
    gaps,
    counts,
    issuers: ISSUERS,
    sourceTemplates: {
      jupiterToken: "https://lite-api.jup.ag/tokens/v2/search?query={mint}",
      jupiterQuote: `${COMMON_SOURCES.jupiterQuote}?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint={mint}&amount=100000000&maxAccounts=30`,
      mintAccount: "https://solscan.io/token/{mint} (read live via getMultipleAccounts, jsonParsed)",
      pythFeed: "https://hermes.pyth.network/v2/price_feeds?query={symbol}",
    },
    spot,
    permissioned: PERMISSIONED,
    phoenix: phoenixSnap
      ? {
          ...phoenixSnap,
          measuredAt,
          restrictions: ["Not available in the US or sanctioned jurisdictions (Phoenix docs).", ...(phoenixSnap.gated ? ["Exchange status is 'gated': traders must register via a referral code or builder onboarding before trading."] : []), "Collateral is Phoenix USD (PhUsd), converted from USDC through the Ember program."],
          sources: [{ url: COMMON_SOURCES.phoenixExchange }, { url: "https://perp-api.phoenix.trade/v1/exchange/snapshot" }, { url: COMMON_SOURCES.phoenixOrderbook }, { url: COMMON_SOURCES.phoenixDocs, note: "US restriction" }, { url: COMMON_SOURCES.phoenixSdk, note: "SDK, onboarding paths" }],
          markets: phoenixSnap.markets.map((m) => {
            const sym = PHOENIX_PYTH[m.symbol] ?? (m.assetClass === "equities" ? `Equity.US.${m.symbol}/USD` : `Crypto.${m.symbol}/USD`);
            const imp = m.buyImpactPct["1000"];
            const cls: LiquidityClass = m.mid === null ? "price-only" : imp !== null && imp < 1 ? "tradeable" : "thin";
            return { ...m, pyth: pythRef(feeds.get(sym)), themes: themesFor(m.symbol), class: cls };
          }),
        }
      : null,
    usdcYield:
      kamino || jupLend
        ? {
            measuredAt,
            kaminoUsdcVaultCount: kamino?.usdcVaultCount ?? 0,
            vaults: [...(jupLend ?? []), ...(kamino?.vaults ?? [])],
            sources: [{ url: COMMON_SOURCES.jupiterLend }, { url: COMMON_SOURCES.jupiterLendDocs }, { url: COMMON_SOURCES.kaminoVaults }, { url: COMMON_SOURCES.kaminoMetrics }, { url: COMMON_SOURCES.kaminoDocs }],
          }
        : null,
    cards: cards
      ? {
          ...cards,
          measuredAt,
          tokenStandards: "Metaplex Core and programmable NFTs (pNFT); the marketplace program also supports compressed and legacy NFTs",
          marketplaceProgram: "CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr",
          restrictions: ["Prices come only from the Collector Crypt API (listing price, insuredValue): no on-chain oracle, so a trusted settler must sign card prices.", "Listings are escrowless 1/1 NFTs: each card is its own market with exactly one unit."],
          sources: [{ url: COMMON_SOURCES.collectorCrypt }, { url: COMMON_SOURCES.collectorCryptDocs }, { url: COMMON_SOURCES.collectorCryptProgram }],
        }
      : null,
    gemini: gemini
      ? {
          ...gemini,
          measuredAt,
          custody: "Custodial: Thesis's own Gemini account places every order; users never link Gemini.",
          restrictions: ["Orders need Gemini API credentials and acceptance of the prediction-markets terms (POST /v1/prediction-markets/terms/accept).", "Nothing is on-chain; resolution follows each contract's terms PDF. Regulated venue and US availability are unverified."],
          sources: [{ url: COMMON_SOURCES.geminiCategories }, { url: COMMON_SOURCES.gemini }, { url: COMMON_SOURCES.geminiSpec }],
        }
      : null,
  };

  const jsonPath = resolve(REGISTRY_DIR, "assets.json");
  const mdPath = resolve(REPO_ROOT, "docs/liquidity.md");
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(jsonPath, serialize(registry));
  writeFileSync(mdPath, renderMarkdown(registry));
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
