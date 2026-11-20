// The fixed asset ontology the take builder's `search` tool filters on: sector → industry (each asset has
// exactly ONE industry) plus cross-cutting tags (multi-select). Per-asset values live in
// packages/take-builder/security-tags.json. Prediction markets are classified by category / league and
// linked to the same ontology through EVENT_LINKS. No imports: usable from Deno and Node.

/** snake_case ids. */
export const SECTORS = [
  "technology",
  "communication_services",
  "consumer_discretionary",
  "consumer_staples",
  "healthcare",
  "financials",
  "crypto", // tokens AND crypto-native companies (Coinbase, Strategy, miners), so "everything crypto" is one filter
  "industrials",
  "energy",
  "utilities",
  "materials",
  "real_estate",
  "commodities", // the raw commodity (gold, oil...) or a fund/perp on it, not the companies that dig it up
  "macro", // broad indexes, country funds, rates, volatility
  "cash",
  "other",
] as const;
export type Sector = typeof SECTORS[number];

/** industry id → its sector and a short human label. Entries marked "none yet" have no asset today but
 *  are needed for takes people write (or for prediction-market links). */
export const INDUSTRIES: Record<string, { sector: Sector; label: string }> = {
  // technology
  semiconductors: { sector: "technology", label: "Chip designers (GPUs, CPUs, networking, analog)" },
  semiconductor_equipment: { sector: "technology", label: "Semiconductor equipment (lithography, deposition, inspection)" },
  memory_storage: { sector: "technology", label: "Memory and storage chips (DRAM, HBM, NAND)" },
  foundry: { sector: "technology", label: "Chip foundries (contract manufacturing)" },
  hardware_devices: { sector: "technology", label: "Computers, phones, servers and consumer devices" },
  telecom_equipment: { sector: "technology", label: "Telecom and network equipment" },
  software: { sector: "technology", label: "Enterprise and application software, IT services" },
  cloud_infrastructure: { sector: "technology", label: "Cloud and AI compute infrastructure (hyperscale and neoclouds)" },
  cybersecurity: { sector: "technology", label: "Cybersecurity and network security" },
  quantum_computing: { sector: "technology", label: "Quantum computing pure plays" },
  ai_labs: { sector: "technology", label: "AI labs (frontier model developers)" },

  // communication services
  internet_ads: { sector: "communication_services", label: "Search and internet advertising" },
  social_media: { sector: "communication_services", label: "Social media, dating and online communities" },
  streaming: { sector: "communication_services", label: "Video and music streaming" },
  video_games: { sector: "communication_services", label: "Video games and gaming platforms" },
  media_entertainment: { sector: "communication_services", label: "Movies, theaters, live venues and media" },
  telecom_services: { sector: "communication_services", label: "Wireless and broadband carriers (none yet)" },

  // consumer discretionary
  ecommerce: { sector: "consumer_discretionary", label: "E-commerce marketplaces and commerce platforms" },
  specialty_retail: { sector: "consumer_discretionary", label: "Specialty and brick-and-mortar retail" },
  restaurants: { sector: "consumer_discretionary", label: "Restaurants, fast food and coffee chains" },
  apparel_footwear: { sector: "consumer_discretionary", label: "Apparel, footwear and athleisure" },
  autos_ev: { sector: "consumer_discretionary", label: "Automakers and EVs" },
  travel_leisure: { sector: "consumer_discretionary", label: "Travel, lodging and car rental" },
  gambling_casinos: { sector: "consumer_discretionary", label: "Casinos and sports betting" },
  ride_hailing_delivery: { sector: "consumer_discretionary", label: "Ride-hailing and delivery apps" },
  homebuilders: { sector: "consumer_discretionary", label: "Homebuilders (none yet)" },

  // consumer staples
  big_box_retail: { sector: "consumer_staples", label: "Big-box, grocery and warehouse retail" },
  food_beverages: { sector: "consumer_staples", label: "Packaged food, snacks and beverages" },
  household_products: { sector: "consumer_staples", label: "Household and personal-care products" },
  tobacco: { sector: "consumer_staples", label: "Tobacco and nicotine" },

  // healthcare
  pharma: { sector: "healthcare", label: "Large pharmaceutical companies" },
  biotech: { sector: "healthcare", label: "Biotech and vaccine developers" },
  medical_devices: { sector: "healthcare", label: "Medical devices, diagnostics and neurotech" },
  telehealth: { sector: "healthcare", label: "Telehealth and consumer health platforms" },
  health_insurance: { sector: "healthcare", label: "Health insurers and managed care" },

  // financials
  banks: { sector: "financials", label: "Banks and investment banks" },
  brokers_exchanges: { sector: "financials", label: "Brokers, exchanges and prediction-market venues" },
  payments: { sector: "financials", label: "Payment networks and fintech payments" },
  asset_managers: { sector: "financials", label: "Asset managers" },
  insurance: { sector: "financials", label: "Insurers and reinsurers (none yet)" },
  diversified_holdings: { sector: "financials", label: "Diversified holding companies" },

  // crypto
  crypto_companies: { sector: "crypto", label: "Crypto companies and crypto-treasury stocks" },
  bitcoin_miners: { sector: "crypto", label: "Bitcoin miners (incl. those pivoting to AI hosting)" },
  crypto_l1: { sector: "crypto", label: "Layer-1 blockchains and their coins (BTC, ETH, SOL...)" },
  crypto_l2: { sector: "crypto", label: "Layer-2 and scaling networks" },
  defi: { sector: "crypto", label: "DeFi protocols (DEXs, lending, synthetic dollars, RWA)" },
  exchange_tokens: { sector: "crypto", label: "Exchange, perp-DEX and launchpad tokens" },
  crypto_infrastructure: { sector: "crypto", label: "Oracles, interoperability, storage and DePIN" },
  ai_tokens: { sector: "crypto", label: "AI and decentralized-compute tokens" },
  memecoins: { sector: "crypto", label: "Memecoins" },

  // industrials
  aerospace_defense: { sector: "industrials", label: "Aerospace and defense" },
  space: { sector: "industrials", label: "Space launch and satellites" },
  airlines: { sector: "industrials", label: "Airlines" },
  logistics: { sector: "industrials", label: "Parcel delivery, freight and logistics" },
  industrial_conglomerates: { sector: "industrials", label: "Industrial conglomerates and automation" },
  robotics_automation: { sector: "industrials", label: "Robotics and humanoid robots" },

  // energy
  oil_gas: { sector: "energy", label: "Oil and gas companies" },
  uranium_nuclear: { sector: "energy", label: "Uranium and nuclear power" },
  power_clean_energy: { sector: "energy", label: "Power generation and clean-energy equipment (fuel cells, solar)" },

  // utilities
  utilities: { sector: "utilities", label: "Electric and gas utilities (none yet)" },

  // materials
  chemicals_gases: { sector: "materials", label: "Chemicals and industrial gases" },
  metals_mining: { sector: "materials", label: "Metal and gold miners (none yet)" },

  // real estate
  reits: { sector: "real_estate", label: "Real estate investment trusts" },
  proptech: { sector: "real_estate", label: "Home sales and real-estate tech" },

  // commodities
  gold: { sector: "commodities", label: "Gold" },
  silver: { sector: "commodities", label: "Silver" },
  copper: { sector: "commodities", label: "Copper (metal and copper-miner funds)" },
  crude_oil: { sector: "commodities", label: "Crude oil (WTI, Brent)" },
  natural_gas: { sector: "commodities", label: "Natural gas (none yet; prediction markets only)" },

  // macro
  broad_index: { sector: "macro", label: "Broad stock indexes (S&P 500, Nasdaq-100, total market)" },
  country_index: { sector: "macro", label: "Single-country equity funds" },
  bonds_rates: { sector: "macro", label: "Bonds and interest rates" },
  volatility: { sector: "macro", label: "Volatility (VIX products)" },

  // cash
  cash_yield: { sector: "cash", label: "Stablecoin and cash yield products" },

  // other
  unclassified: { sector: "other", label: "Not yet identified (listing whose business we couldn't confirm)" },
};

/** Cross-cutting tags (multi-select), with a one-line meaning. */
export const TAGS: Record<string, string> = {
  // countries / regions (where the company is headquartered, or what the fund holds)
  us: "United States company or US-focused fund",
  china: "Chinese company or China exposure",
  taiwan: "Taiwanese company",
  korea: "South Korean company or Korea fund",
  japan: "Japanese company or Japan fund",
  europe: "European company (incl. UK, Netherlands, Nordics)",
  canada: "Canadian company",
  latin_america: "Latin American company or fund (Brazil, Mexico...)",
  asia_pacific: "Other Asia-Pacific company (Australia, Singapore, Hong Kong, India...)",
  global: "Fund holding companies across many countries",

  // themes
  ai: "Makes money from AI: models, chips, compute or AI software",
  ai_infrastructure: "Sells the picks and shovels of AI: chips, memory, chip tools, servers, networking, compute",
  data_centers: "Builds, fills, powers or rents data centers",
  ai_power: "Benefits from rising electricity demand from AI data centers: power gen, nuclear, grid metals",
  cloud_computing: "Runs a meaningful cloud computing business",
  quantum: "Quantum computing exposure (pure plays and big-tech quantum programs)",
  glp1_obesity: "Makes or sells GLP-1 / obesity drugs",
  vaccines: "Meaningful vaccine business",
  ev: "Electric vehicles and the electrification supply chain",
  autonomous_driving: "Self-driving cars and robotaxis",
  robotics: "Robots, humanoids and physical AI",
  space: "Space launch, satellites and lunar missions",
  defense: "Sells to the military and defense agencies",
  clean_energy: "Low-carbon power: nuclear, fuel cells, solar, wind",
  digital_advertising: "Earns mainly from online ads",
  consumer_spending: "Moves with discretionary consumer spending",
  consumer_trade_down: "Wins when consumers trade down to value (Walmart, Costco, fast food)",
  travel: "Moves with travel demand (airlines, lodging, rental cars, casinos)",
  entertainment: "Movies, TV, games and live entertainment",

  // crypto
  crypto_exposure: "Price is driven by crypto: tokens, crypto companies, miners, treasury stocks",
  crypto_majors: "One of the largest, most liquid crypto assets",
  bitcoin_treasury: "Company whose main asset is a bitcoin treasury (Strategy and its preferreds)",
  crypto_treasury: "Public company built around holding a crypto treasury (BTC, ETH, SOL, ZEC...)",
  bitcoin_mining: "Mines bitcoin",
  stablecoins: "Issues, uses or is a stablecoin (USDC, USDe, USDT rails)",
  tokenization: "Tokenized real-world assets (T-bills, funds, credit, reinsurance) or the rails for them",
  solana_ecosystem: "Lives on or is tied to Solana",
  ethereum_ecosystem: "Lives on Ethereum or its layer-2s (incl. Base, Arbitrum)",
  privacy: "Privacy coins and the companies holding them (Zcash)",
  depin: "Decentralized physical infrastructure: storage, GPU compute, wireless",
  defi_lending: "Yield from lending to crypto borrowers through DeFi money markets",
  private_credit: "Yield from lending to real-world borrowers (private credit, payment finance)",
  tbill_backed: "Backed by short-term US Treasury bills",

  // market character
  prediction_markets: "Runs or offers prediction markets / event contracts",
  retail_trading: "Driven by or earns from retail-trader activity",
  meme: "Meme stock or memecoin: trades on hype and social momentum",
  musk_ecosystem: "Elon Musk companies, or assets that trade on Musk news",
  private_company: "Not publicly listed (pre-IPO exposure)",
  megacap: "Company worth roughly $500B+, or a fund dominated by them",
  small_cap: "Small, speculative company (roughly under $5B)",
  income: "Pays meaningful regular income: dividends, preferred coupons, distributions",
  defensive: "Steady demand in downturns; tends to hold up in selloffs",
  inflation_hedge: "Tends to rise with inflation (commodities, energy)",
  safe_haven: "Tends to hold up or rise in risk-off selloffs (gold, Treasuries, volatility)",
  rate_sensitive: "Moves strongly with interest rates (bonds, REITs, banks, housing)",

  // macro / event themes (mainly for prediction-market links)
  us_politics: "Moves with US politics, elections and government policy",
  monetary_policy: "Moves with Fed decisions and central-bank policy",
  macro: "Moves with the overall economy and macro data",
  labor_market: "Jobs and unemployment data",
  geopolitics: "Moves with wars, sanctions, shipping lanes and foreign elections",

  // kind of exposure
  leveraged: "Leveraged fund (2x/3x daily)",
  inverse: "Inverse fund: rises when the underlying falls",
  index: "Fund or perp that tracks a basket or index, not a single company",
};

/** Gemini prediction-market categories as they appear in data.category (keep these exact strings). */
export const PREDICTION_CATEGORIES = ["Sports", "Economics", "Politics", "Crypto", "Commodities", "Business", "Tech", "Culture", "Weather"] as const;

export const LEAGUES = [
  "nfl", "nba", "nhl", "ncaam", "ncaaf", "ucl", "epl", "mls", "laliga", "ligamx", "golf", "f1", "fantasy_football",
] as const;
export type League = typeof LEAGUES[number];

/** Event-ticker prefix → league, longest prefix first so NBAF beats NBA and NCAAM beats nothing shorter. */
const LEAGUE_PREFIXES: [string, League][] = [
  ["FANTASY", "fantasy_football"],
  ["LALIGA", "laliga"],
  ["LIGAMX", "ligamx"],
  ["NCAAM", "ncaam"],
  ["NCAAF", "ncaaf"],
  ["NBAF", "nba"], // NBA futures (champion, MVP...)
  ["GOLF", "golf"],
  ["CFB", "ncaaf"], // college football conference / championship futures
  ["NFL", "nfl"],
  ["NBA", "nba"],
  ["NHL", "nhl"],
  ["UCL", "ucl"],
  ["EPL", "epl"],
  ["MLS", "mls"],
  ["F1", "f1"],
  ["FF", "fantasy_football"],
];

/** Sports event ticker → league id from LEAGUES, or null when the prefix is unknown. */
export function leagueOf(eventTicker: string): string | null {
  const t = eventTicker.trim().toUpperCase();
  for (const [prefix, league] of LEAGUE_PREFIXES) if (t.startsWith(prefix)) return league;
  return null;
}

/** A prediction-market event family and what it's about. `assets`: underlying tickers (as in assets.json
 *  `underlying`, e.g. "BTC", "MSTR", "TLT", "TSLA", "GLD"/"GOLD") the event moves with. `yes`: for a yes/no
 *  event, which way YES pushes those assets ("up" | "down" | null if mixed or N/A, e.g. an election). */
export type EventLink = { match: RegExp; industries: string[]; tags: string[]; assets: string[]; yes: "up" | "down" | null; note?: string };

const LADDER = "price ladder: higher strike = more bullish";

export const EVENT_LINKS: EventLink[] = [
  // crypto price ladders (daily / month-end, tickers roll over)
  { match: /^BTC price on /i, industries: ["crypto_l1", "crypto_companies", "bitcoin_miners"], tags: ["crypto_exposure", "crypto_majors", "bitcoin_treasury"], assets: ["BTC", "MSTR", "STRC", "COIN", "RIOT"], yes: "up", note: LADDER },
  { match: /^ETH price on /i, industries: ["crypto_l1"], tags: ["crypto_exposure", "crypto_majors", "ethereum_ecosystem"], assets: ["ETH", "BMNR", "COIN"], yes: "up", note: LADDER },
  { match: /^SOL price on /i, industries: ["crypto_l1"], tags: ["crypto_exposure", "crypto_majors", "solana_ecosystem"], assets: ["SOL", "DFDV", "FWDI", "JUP"], yes: "up", note: LADDER },
  { match: /^XRP price on /i, industries: ["crypto_l1"], tags: ["crypto_exposure", "crypto_majors"], assets: ["XRP"], yes: "up", note: LADDER },
  { match: /^ZEC price on /i, industries: ["crypto_l1"], tags: ["crypto_exposure", "privacy"], assets: ["ZEC", "CYPH"], yes: "up", note: LADDER },
  { match: /^HYPE price on /i, industries: ["exchange_tokens"], tags: ["crypto_exposure", "retail_trading"], assets: ["HYPE"], yes: "up", note: LADDER },
  { match: /^Zcash .*(vulnerab|exploit)/i, industries: ["crypto_l1"], tags: ["crypto_exposure", "privacy"], assets: ["ZEC", "CYPH"], yes: "up", note: "YES = proof the Orchard pool was not exploited, which removes a tail risk for ZEC" },

  // commodity price ladders
  { match: /^Gold price on /i, industries: ["gold"], tags: ["inflation_hedge", "safe_haven"], assets: ["XAU", "GLD", "GOLD"], yes: "up", note: LADDER },
  { match: /^Silver price on /i, industries: ["silver"], tags: ["inflation_hedge", "safe_haven"], assets: ["XAG", "SLV", "SILVER"], yes: "up", note: LADDER },
  { match: /^Copper price on /i, industries: ["copper"], tags: ["ev", "ai_power", "inflation_hedge"], assets: ["COPPER", "COPX"], yes: "up", note: LADDER },
  { match: /^Oil \((WTI|Brent)\) price on /i, industries: ["crude_oil", "oil_gas"], tags: ["inflation_hedge", "geopolitics"], assets: ["WTIOIL", "USO", "XLE", "XOM", "CVX"], yes: "up", note: LADDER },
  { match: /^Natural Gas price on /i, industries: ["natural_gas", "oil_gas"], tags: ["inflation_hedge"], assets: ["XLE", "XOM", "CVX"], yes: "up", note: `${LADDER}; no gas asset listed, the majors are a loose proxy` },

  // macro
  { match: /^Fed decision/i, industries: ["bonds_rates", "broad_index"], tags: ["monetary_policy", "rate_sensitive", "macro"], assets: ["TLT", "SPY", "QQQ"], yes: null, note: "multi-outcome: a cut pushes TLT and stocks up, a hike pushes them down" },
  { match: /^Recession /i, industries: ["broad_index", "bonds_rates"], tags: ["macro", "safe_haven"], assets: ["SPY", "QQQ", "IVV", "VTI"], yes: "down", note: "YES is bearish for stocks; TLT, gold and UVXY tend to rise instead" },
  { match: /GDP Growth/i, industries: ["broad_index"], tags: ["macro"], assets: ["SPY", "VTI"], yes: null, note: "range buckets: higher growth bracket = more bullish for stocks" },
  { match: /unemployment/i, industries: ["broad_index", "bonds_rates"], tags: ["labor_market", "macro"], assets: ["SPY", "QQQ"], yes: "down", note: "YES on a higher threshold = weaker jobs, bearish stocks; TLT tends to rise" },
  { match: /^S&P close price/i, industries: ["broad_index"], tags: ["index", "macro"], assets: ["SPY", "IVV", "VTI"], yes: null, note: "range buckets on the year-end S&P 500 close" },
  { match: /^How high will the S&P/i, industries: ["broad_index"], tags: ["index", "macro"], assets: ["SPY", "IVV", "VTI"], yes: "up", note: LADDER },
  { match: /^How low will the S&P/i, industries: ["broad_index"], tags: ["index", "macro"], assets: ["SPY", "IVV", "VTI"], yes: "down", note: "YES = the S&P falls to that level at some point this year" },
  { match: /^NASDAQ-100 close price/i, industries: ["broad_index"], tags: ["index", "megacap"], assets: ["QQQ", "TQQQ"], yes: null, note: "range buckets on the year-end Nasdaq-100 close; SQQQ moves the other way" },
  { match: /Strait of Hormuz/i, industries: ["crude_oil", "oil_gas"], tags: ["geopolitics", "inflation_hedge"], assets: ["WTIOIL", "USO", "XLE", "XOM", "CVX"], yes: "down", note: "YES = shipping normalises, more supply, oil falls" },

  // business / tech / culture
  { match: /crypto market structure legislation/i, industries: ["crypto_companies", "brokers_exchanges"], tags: ["us_politics", "crypto_exposure", "stablecoins"], assets: ["COIN", "HOOD", "CRCL", "BTC"], yes: "up" },
  { match: /^Best AI /i, industries: ["ai_labs", "internet_ads", "software"], tags: ["ai"], assets: ["GOOGL", "ANTHROPIC", "OPENAI", "META", "MSFT", "BABA"], yes: null, note: "per outcome: ChatGPT→OPENAI/MSFT, Claude→ANTHROPIC, Gemini→GOOGL, LLaMA→META, Qwen→BABA; Grok and Ernie have no listed asset" },
  { match: /Game of the Year/i, industries: ["video_games"], tags: ["entertainment"], assets: ["TTWO", "RBLX"], yes: null, note: "Grand Theft Auto VI → TTWO; other nominees are not listed publishers" },
  { match: /Rotten Tomatoes/i, industries: ["media_entertainment"], tags: ["entertainment"], assets: ["AMC"], yes: "up", note: "better reviews → bigger box office → theater traffic (studios not listed)" },
  { match: /GameStop acquire eBay/i, industries: ["specialty_retail", "ecommerce"], tags: ["meme", "retail_trading"], assets: ["GME"], yes: null, note: "acquirer often sells off on a big deal, but GME trades on meme momentum" },
  { match: /Tesla Optimus/i, industries: ["autos_ev", "robotics_automation"], tags: ["robotics", "autonomous_driving", "musk_ecosystem"], assets: ["TSLA"], yes: "up" },
  { match: /Stripe announce an IPO/i, industries: ["payments"], tags: ["private_company", "us"], assets: ["V", "MA"], yes: null, note: "Stripe isn't listed; V/MA are the closest comps" },
  { match: /Stripe announce an acquisition of PayPal/i, industries: ["payments"], tags: ["us"], assets: ["V", "MA"], yes: null, note: "PayPal isn't listed; V/MA are the closest comps" },
  { match: /companies will the US take a stake in/i, industries: ["aerospace_defense", "ai_labs", "pharma", "quantum_computing", "semiconductors", "memory_storage", "foundry", "software"], tags: ["us_politics", "us"], assets: ["ANDURIL", "ANTHROPIC", "BA", "LLY", "IONQ", "LMT", "MU", "NVDA", "OPENAI", "PLTR", "PFE", "TSM"], yes: null, note: "per outcome: Anduril→ANDURIL, Anthropic→ANTHROPIC, Boeing→BA, Eli Lilly→LLY, IonQ→IONQ, Lockheed Martin→LMT, Micron→MU, Nvidia→NVDA, OpenAI→OPENAI, Palantir→PLTR, Pfizer→PFE, TSMC→TSM; Freeport-McMoRan and TikTok US not listed. A stake has been read both as a seal of approval and as dilution" },
  { match: /NASA lands on the moon/i, industries: ["space", "aerospace_defense"], tags: ["space"], assets: ["SPCX", "SPACEX", "FLY", "LMT", "BA"], yes: "up", note: "Starship is the Artemis lander (SpaceX), Orion = LMT, SLS = BA, Firefly runs lunar landers" },

  // US politics (tags only)
  { match: /nominee/i, industries: [], tags: ["us_politics"], assets: [], yes: null, note: "2028 presidential / VP nominations" },
  { match: /^Presidential Election Winner/i, industries: [], tags: ["us_politics"], assets: [], yes: null },
  { match: /leave the Trump Administration/i, industries: [], tags: ["us_politics"], assets: [], yes: null },
  { match: /Justice .* retire/i, industries: [], tags: ["us_politics"], assets: [], yes: null },
  { match: /charged with a federal crime/i, industries: [], tags: ["us_politics"], assets: [], yes: null },
  { match: /SAVE Act/i, industries: [], tags: ["us_politics"], assets: [], yes: null },
  { match: /buy .*Greenland/i, industries: [], tags: ["us_politics", "geopolitics"], assets: [], yes: null },

  // world politics (tags only)
  { match: /^French Presidential/i, industries: [], tags: ["geopolitics", "europe"], assets: [], yes: null },
  { match: /UK general election/i, industries: [], tags: ["geopolitics", "europe"], assets: [], yes: null },
  { match: /Prime Minister of Israel/i, industries: [], tags: ["geopolitics"], assets: [], yes: null },
  { match: /world leaders will leave office/i, industries: [], tags: ["geopolitics"], assets: [], yes: null },
  { match: /Díaz-Canel|Diaz-Canel/i, industries: [], tags: ["geopolitics", "latin_america"], assets: [], yes: null },
];

/** The first EVENT_LINKS rule whose regex matches the event title, or null. */
export function eventLinkOf(title: string): EventLink | null {
  return EVENT_LINKS.find((l) => l.match.test(title)) ?? null;
}
