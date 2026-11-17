// Hand-maintained facts the live APIs can't give us: who issues what, who may
// hold it, and which theme an underlying belongs to. Everything else in the
// registry is measured live. Each fact carries a source URL, or "unverified".

export type Source = { url: string; note?: string };

export type IssuerInfo = {
  issuer: string;
  category: "stock" | "pre-ipo" | "leveraged" | "commodity" | "yield-token" | "other-rwa";
  restrictions: string[];
  sources: Source[];
  unverified?: string[];
};

/** Keyed by Jupiter token tag (or a pseudo tag we assign, like "remora"). */
export const ISSUERS: Record<string, IssuerInfo> = {
  xstocks: {
    issuer: "xStocks (Backed Finance, owned by Kraken)",
    category: "stock",
    restrictions: [
      "Not for US persons; issuer also lists Australia, Canada, UK and sanctioned regions as unavailable (Kraken support page). Secondary trading on Jupiter is permissionless on-chain.",
      "Issuer holds a permanent delegate (can move or burn any holder's tokens) and a pause authority.",
    ],
    sources: [
      { url: "https://support.kraken.com/articles/xstocks-availability", note: "restricted regions" },
      { url: "https://assets.backed.fi/", note: "issuer site; sale only to non-US persons" },
    ],
  },
  ondo: {
    issuer: "Ondo Global Markets",
    category: "stock",
    restrictions: [
      "Ondo's mint/redeem is geo-restricted and excludes US persons (unverified against Ondo's own terms). Secondary trading on Jupiter is permissionless on-chain.",
      "Issuer holds a pause/freeze authority; no permanent delegate.",
    ],
    sources: [
      { url: "https://solana.com/news/ondo-global-markets-tokenized-stocks-etfs-solana", note: "launch on Solana" },
      { url: "https://www.coingecko.com/en/coins/nvidia-ondo-tokenized-stock", note: "US exclusion (3rd party)" },
    ],
    unverified: ["exact eligibility terms"],
  },
  backpack: {
    issuer: "Backpack Securities",
    category: "stock",
    restrictions: [
      "1:1 backed by shares held at Backpack's US brokerage; who may hold the token on-chain (US vs non-US) is unverified. The token itself is freely transferable on Jupiter.",
      "Issuer holds a permanent delegate and a pause authority.",
    ],
    sources: [
      { url: "https://solanacompass.com/news/backpack-securities-launches-tokenized-us-equity-and-etf-trading-on-solana", note: "launch, 1:1 backing" },
      { url: "https://news.tokenizer.estate/backpack-tokenizes-micron-shares-solana-on-chain-equity-trading", note: "exemption for non-US persons unclear" },
    ],
    unverified: ["holder eligibility"],
  },
  remora: {
    issuer: "Remora Markets (rStocks)",
    category: "stock",
    restrictions: ["Not on Jupiter's verified list. Issuer terms unverified."],
    sources: [{ url: "https://lite-api.jup.ag/tokens/v2/search?query=rStock", note: "discovered via Jupiter token search" }],
    unverified: ["issuer, backing and eligibility"],
  },
  prestocks: {
    issuer: "PreStocks (SPV exposure to private companies)",
    category: "pre-ipo",
    restrictions: [
      "Indirect SPV exposure, not shares. Anthropic and OpenAI have said SPV transfers of their stock are void, and the tokens fell 34-39%.",
      "Token-2022 transfer fee on every transfer (see transferFeeBps) and a permanent delegate.",
    ],
    sources: [
      { url: "https://coinmarketcap.com/academy/article/anthropic-openai-tokenized-share-warning", note: "issuer warnings" },
      { url: "https://blocmates.com/articles/prestocks-modernizing-and-democratizing-access-to-pre-ipo-stocks", note: "how it works" },
    ],
  },
  tessera: {
    issuer: "Tessera (pre-IPO exposure)",
    category: "pre-ipo",
    restrictions: ["Indirect pre-IPO exposure; issuer terms unverified. Token-2022 transfer fee applies (see transferFeeBps)."],
    sources: [],
    unverified: ["issuer, structure and eligibility"],
  },
  shift: {
    issuer: "SHIFT RWA (leveraged equity tokens)",
    category: "leveraged",
    restrictions: ["Daily-rebalanced 1-3x long/short equity tokens; NAV tracking and liquidity are unproven. Eligibility unverified."],
    sources: [{ url: "https://solanacompass.com/news/shift-rwa-lists-leveraged-tokenized-equities-on-jupiter-adding-no-liquidation-stock-exposure-to-solana-defi" }],
    unverified: ["eligibility"],
  },
};

/** Per-mint facts for commodities, yield tokens and other RWAs found by tag. */
/**
 * How many underlying units one (UI) token represents, from the issuer's own docs. Used by the
 * asset bank to compare issuers of the same underlying. Absent means unknown: not comparable.
 */
export type UnitRatio = { underlyingPerToken: number; unit: string; source: Source };
const TROY_OZ_GRAMS = 31.1034768;

export const MINT_INFO: Record<string, { issuer: string; category?: IssuerInfo["category"]; underlying?: string; pyth?: string; ratio?: UnitRatio; usPersons?: "no" | "unverified" | "yes"; restrictions?: string[]; sources?: Source[]; unverified?: string[] }> = {
  // physical commodities
  "5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW": { issuer: "Paxos (PAX Gold)", category: "commodity", underlying: "XAU", pyth: "Crypto.PAXG/USD", ratio: { underlyingPerToken: 1, unit: "troy oz", source: { url: "https://www.paxos.com/pax-gold", note: "one fine troy ounce per PAXG" } }, restrictions: ["Paxos holds a permanent delegate and freeze authority on this Token-2022 mint."], unverified: ["that this Solana mint is Paxos-issued rather than bridged; matched by name and Jupiter verified tag only"] },
  AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P: { issuer: "Tether (XAUt0, omnichain XAUT)", category: "commodity", underlying: "XAU", pyth: "Crypto.XAUT/USD", ratio: { underlyingPerToken: 1, unit: "troy oz", source: { url: "https://gold.tether.to/", note: "one troy fine ounce per XAUT; XAUt0 is its omnichain form" } }, restrictions: ["Freeze authority held by issuer."], unverified: ["issuer mapping; matched by name and Jupiter tag"] },
  "9TPL8droGJ7jThsq4momaoz6uhTcvX2SeMqipoPmNa8R": { issuer: "VNX (VNX Gold)", category: "commodity", underlying: "XAU", ratio: { underlyingPerToken: 1 / TROY_OZ_GRAMS, unit: "gram", source: { url: "https://vnx.li/vnx-gold/", note: "1 VNXAU = 1 gram of LBMA gold" } }, unverified: ["issuer mapping; matched by name and Jupiter tag"] },
  "5aLhp9VnUEKcsdtkfsf2DUgpJfomx7GmYVny24dHUZoB": { issuer: "Matrixdock (XAUm)", category: "commodity", underlying: "XAU", ratio: { underlyingPerToken: 1, unit: "troy oz", source: { url: "https://www.matrixdock.com/xaum", note: "each token represents 1 troy oz" } }, unverified: ["issuer mapping; matched by name"] },
  GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A: { issuer: "unverified (token named GOLD, Jupiter tag commodities)", category: "commodity", underlying: "XAU", unverified: ["issuer and gold backing"] },
  SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L: { issuer: "unverified (Dominion Silver)", category: "commodity", underlying: "XAG", unverified: ["issuer and silver backing"] },
  dg1dmo6NZNagkwB6EAfUeaco6CFXFLRhb1KCrsqXTVz: { issuer: "unverified (Digital Gold)", category: "commodity", underlying: "XAU", unverified: ["issuer and gold backing"] },
  // yield tokens
  A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6: { issuer: "Ondo Finance (USDY, tokenized notes on T-bills)", category: "yield-token", usPersons: "no", pyth: "Crypto.USDY/USD", restrictions: ["Not for US persons (Reg S). Primary mint needs Ondo KYC; secondary buys on Jupiter are permissionless after the issuer's lock-up."], sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers", note: "USDY is non-US Reg S" }] },
  AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: { issuer: "Maple (syrupUSDC)", category: "yield-token", unverified: ["eligibility for secondary holders"] },
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5": { issuer: "OnRe (tokenized reinsurance)", category: "yield-token", unverified: ["eligibility"] },
  "59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw": { issuer: "Huma (PayFi Strategy Token)", category: "yield-token", unverified: ["issuer mapping and eligibility"] },
  "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7": { issuer: "unverified (PRIME, Jupiter tag yb)", category: "yield-token", unverified: ["issuer and backing"] },
  "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih": { issuer: "unverified (wYLDS)", category: "yield-token", unverified: ["issuer and backing"] },
};

/** Permissioned products: excluded from baskets. Solana mints are not on Jupiter's verified list, so they are not measured. */
export const PERMISSIONED: { symbol: string; name: string; issuer: string; why: string; sources: Source[] }[] = [
  { symbol: "OUSG", name: "Ondo Short-Term US Government Treasuries", issuer: "Ondo Finance", why: "KYC plus qualified-purchaser checks; allowlisted wallets only", sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers" }] },
  { symbol: "BUIDL", name: "BlackRock USD Institutional Digital Liquidity Fund", issuer: "BlackRock / Securitize", why: "Qualified purchasers only ($5M minimum); transfer-agent allowlist", sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers" }] },
  { symbol: "BENJI", name: "Franklin OnChain US Government Money Fund", issuer: "Franklin Templeton", why: "Fund-share registry with KYC; only registered wallets", sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers" }] },
  { symbol: "USTB / USCC", name: "Superstate Short Duration Treasury / Crypto Carry", issuer: "Superstate", why: "Allowlisted wallets after KYC (accredited or qualified)", sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers" }] },
  { symbol: "ACRED", name: "Apollo Diversified Credit Securitize Fund", issuer: "Apollo / Securitize", why: "Accredited investors only; transfer-agent allowlist", sources: [{ url: "https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers" }] },
  { symbol: "VBILL", name: "VanEck Treasury Fund", issuer: "VanEck / Securitize", why: "Qualified investors only; transfer-agent allowlist", sources: [{ url: "https://platform.solana.com/docs/tutorials/tokenize-a-treasury-fund", note: "how Solana allowlists reject non-listed wallets" }] },
];

/** Theme by underlying ticker. Used for the "good basket candidates" section and by the take builder. */
const THEMES: Record<string, string[]> = {
  "AI and compute": ["NVDA", "AMD", "AVGO", "TSM", "MU", "SKHY", "SNDK", "ARM", "INTC", "QCOM", "MRVL", "DELL", "CRWV", "NBIS", "IREN", "ORCL", "MSFT", "GOOGL", "GOOG", "META", "AMZN", "PLTR", "SMCI", "ASML", "AMAT", "KLAC", "LRCX", "CBRS", "DRAM", "SOXX", "SMH", "OPENAI", "ANTHROPIC", "XAI", "FIGUREAI", "TTMI", "ANET", "VRT", "CRM", "NOW", "SNOW", "AI", "IONQ", "QUBT", "RGTI", "MDB", "NET", "CRWD", "APP", "SOX", "SOX3L", "SOX3S", "WULF", "CORZ", "CIFR", "APLD"],
  "Energy and power": ["VST", "CEG", "NRG", "NEE", "OKLO", "SMR", "BE", "URA", "CCJ", "LEU", "GEV", "XOM", "CVX", "OXY", "COP", "USO", "XLE", "TLN", "PPL", "LNT", "DUK", "SO", "OVV", "NNE", "FSLR", "ENPH", "WTIOIL", "NATGAS", "PUSA"],
  Commodities: ["GLD", "IAU", "SLV", "COPX", "USO", "XAU", "XAG", "GOLD", "SILVER", "COPPER", "WTIOIL", "GDX", "PPLT", "FCX", "ANTO", "CHONG"],
  "Crypto-adjacent": ["COIN", "MSTR", "HOOD", "CRCL", "RIOT", "MARA", "BMNR", "GLXY", "BLSH", "CLSK", "SBET", "BTBT", "HUT", "KALSHI", "POLYMARKET", "CYPH", "FWDI", "BULL", "GME", "BOT", "WULF"],
  "Index and macro": ["SPY", "QQQ", "VTI", "VOO", "IWM", "DIA", "SQQQ", "UVXY", "TLT", "EWY", "EWZ", "SCHH", "SPX3L", "SPX3S", "SRLN"],
  "Space and defense": ["SPCX", "SPACEX", "RKLB", "LMT", "BA", "ANDURIL", "FLY", "ASTS", "NOC", "RTX", "PL", "LUNR"],
  "Consumer and media": ["AAPL", "TSLA", "NFLX", "MCD", "NKE", "COST", "CMG", "SBUX", "DIS", "RBLX", "TTWO", "SNAP", "RDDT", "SHOP", "ABNB", "LULU", "WEN", "DNUT", "AMC", "DKNG", "MGM", "CHWY", "BROS", "UBER", "SPOT", "DUOL", "MAT"],
  Healthcare: ["LLY", "NVO", "JNJ", "PFE", "MRNA", "HIMS", "UNH", "ALNY", "PTN"],
};

export function themesFor(ticker: string | null): string[] {
  if (!ticker) return [];
  const t = ticker.toUpperCase();
  return Object.entries(THEMES)
    .filter(([, list]) => list.includes(t))
    .map(([theme]) => theme);
}

/** Phoenix perp underlyings we map to Pyth symbols that don't follow Crypto.X / Equity.US.X. */
export const PHOENIX_PYTH: Record<string, string> = {
  GOLD: "Metal.XAU/USD",
  SILVER: "Metal.XAG/USD",
  COPPER: "Commodities.Index.CU/USD",
  WTIOIL: "Commodities.Index.WTI1M/USD",
  ANTHROPIC: "Equity.Index.ANTHROPIC/USD",
  SPCX: "Equity.Index.SPACEX/USD",
};

export const COMMON_SOURCES = {
  jupiterTokens: "https://lite-api.jup.ag/tokens/v2/tag?query=verified",
  jupiterQuote: "https://lite-api.jup.ag/swap/v1/quote",
  jupiterQuoteDocs: "https://dev.jup.ag/docs/swap/get-quote",
  jupiterLend: "https://lite-api.jup.ag/lend/v1/earn/tokens",
  jupiterLendDocs: "https://developers.jup.ag/docs/api-reference/lend/earn",
  phoenixExchange: "https://perp-api.phoenix.trade/exchange",
  phoenixOrderbook: "https://perp-api.phoenix.trade/v1/view/orderbook/{symbol}",
  phoenixDocs: "https://docs.phoenix.trade",
  phoenixSdk: "https://github.com/Ellipsis-Labs/rise-public",
  kaminoVaults: "https://api.kamino.finance/kvaults/vaults",
  kaminoMetrics: "https://api.kamino.finance/kvaults/{vault}/metrics",
  kaminoDocs: "https://kamino.com/docs",
  collectorCrypt: "https://api.collectorcrypt.com/marketplace",
  collectorCryptDocs: "https://docs.collectorcrypt.com/marketplace/api",
  collectorCryptProgram: "https://docs.collectorcrypt.com/marketplace/program",
  gemini: "https://api.gemini.com/v1/prediction-markets/events",
  geminiCategories: "https://api.gemini.com/v1/prediction-markets/categories",
  geminiSpec: "https://developer.gemini.com/specs/openapi/prediction-markets.yaml",
  pythCatalog: "https://hermes.pyth.network/v2/price_feeds",
  pythKey: "https://docs.pyth.network/pro/pyth-core-upgrade.mdx",
  pythSponsored: "https://docs.pyth.network/pro/sponsored-feeds",
  solanaRpc: "https://solana.com/docs/rpc/http/getmultipleaccounts",
};

export const PYTH_PUSH_PROGRAMS = {
  core: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
  compatible: "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou",
};

export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
