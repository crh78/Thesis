// What positions are worth on the fork: token prices (the asset bank's, else Jupiter), stock
// prices (Alpaca), the tokens each position bought, and live marks on each leg's entry basis.
// Marks follow the same rules as the settler and the marker (valueLeg, settler/leg-value.ts): the
// token only with the $50k liquidity floor, else the stock times the entry's premium; no
// prediction mark from a book that doesn't add up. Only the reads and their freshness are this
// file's own: display values may use a price a little older than one the settler signs.
import { PublicKey } from "@solana/web3.js";
import type { TakeAccount } from "@thesis/chain";
import { boughtTokens, liquidTokenPrice, toPriceUnits, valueLeg, type LegToValue, type LegValue, type SpotBasisRef } from "@thesis/executor/settler";
import { FileSink, cardLeg, defaultSink, effectiveMultiplier, pricesFileFor, readBankPrices, underlyingIdHex, type BankPrices } from "@thesis/venues/bank";
import { JL_USDC_MINT, jupiterLendShareValue } from "@thesis/venues/jupiter";
import type { ServiceOpts } from "./common.ts";
import type { MappedLeg } from "./legs.ts";
import type { StateStore } from "./store.ts";

const PRICE_CACHE_MS = 10_000;
/** Longest wait for a Jupiter price read; past it, the cache or the asset bank's price stands in. */
const PRICE_TIMEOUT_MS = 10_000;
/** Alpaca latest trades: reused this long, waited for at most STOCK_TIMEOUT_MS, and a stale one used up to STOCK_STALE_MS. */
const STOCK_CACHE_MS = 15_000;
const STOCK_TIMEOUT_MS = 10_000;
const STOCK_STALE_MS = 5 * 60_000;
/**
 * The asset bank's batched price (refreshed about every 90 s) is used instead of calling Jupiter
 * while it's at most this old. Display only: the settler reads its own.
 */
const BANK_FRESH_MS = 2 * 60_000;
/**
 * When Jupiter can't be read, the newest price known (this API's last read or the bank's) stands
 * in up to this old: the marker's run interval, so the Me page is never staler than the feed.
 */
const DISPLAY_STALE_MS = 5 * 60_000;
/** The bank's prices file (asset-bank.prices.json) is re-read at most this often. */
const BANK_FILE_READ_MS = 15_000;

/** A token price as display values use it: USD per UI token, pooled liquidity, and when it was read (ms). */
export type TokenQuote = { usd: number; liquidityUsd: number; at: number };

/** The asset bank's prices file, next to its file sink's bank (null with the Supabase sink). */
function defaultPricesFile(): string | null {
  try {
    const sink = defaultSink();
    return sink instanceof FileSink ? pricesFileFor(sink.path) : null;
  } catch {
    return null;
  }
}

const stockOf = (key: string | null | undefined) => (key && /^(equity|etf):/.test(key) ? key.split(":")[2] : null);

export class Valuation {
  #o: ServiceOpts;
  #store: StateStore;
  #priceCache = new Map<string, TokenQuote>();
  /** Jupiter reads in flight, by mint: a burst of views shares one read. */
  #priceReads = new Map<string, Promise<void>>();
  #pricesFile: string | null;
  #bankFile: { readAt: number; prices: BankPrices | null; pending: Promise<BankPrices | null> | null } = { readAt: 0, prices: null, pending: null };
  /** Tokens each position's trade bought (fixed once the trade has landed). */
  #bought = new Map<string, Map<string, bigint>>();
  #mintDecimals = new Map<string, number>();

  /** `pricesFile`: the asset bank's prices file (default: next to its file sink; null: none). */
  constructor(o: ServiceOpts, store: StateStore, opts: { pricesFile?: string | null } = {}) {
    this.#o = o;
    this.#store = store;
    this.#pricesFile = opts.pricesFile === undefined ? defaultPricesFile() : opts.pricesFile;
  }

  /** The transactions that opened a position, so its tokens are read from exactly those. */
  recordOpening(position: PublicKey, signatures: string[]) {
    const key = position.toBase58();
    (this.#store.state.openingTransactions ??= {})[key] = signatures;
    this.#bought.delete(key);
  }

  /** Raw token amounts a position's opening transactions gave its owner. */
  async bought(position: PublicKey, owner: PublicKey): Promise<Map<string, bigint>> {
    const key = position.toBase58();
    let bought = this.#bought.get(key);
    if (!bought) {
      bought = await boughtTokens(this.#o.connection, position, owner, {
        openingOnly: true, signatures: this.#store.state.openingTransactions?.[key],
      });
      this.#bought.set(key, bought);
    }
    return bought;
  }

  /**
   * What the tokens a trade bought are worth now (Jupiter prices), or null if one has no price.
   * Use the transactions confirmed for this position. Older positions fall back to the receipt
   * transaction, which can prove a single-transaction purchase without counting nearby trades.
   */
  async positionValue(position: PublicKey, owner: PublicKey, assets: Set<string>): Promise<number | null> {
    const bought = await this.bought(position, owner);
    const tokens = this.#o.bank().tokens;
    // A spot leg's asset is its underlying; a yield leg's is the vault token itself (`token:<mint>`).
    const covered = new Set<string>();
    const mints = [...bought.keys()].filter((mint) => {
      const token = underlyingIdHex(`token:${mint}`);
      const underlying = tokens[mint] && underlyingIdHex(tokens[mint].underlying);
      if (assets.has(token)) covered.add(token);
      if (underlying && assets.has(underlying)) covered.add(underlying);
      return assets.has(token) || Boolean(underlying && assets.has(underlying));
    });
    if (!mints.length || covered.size !== assets.size) return null;
    const [prices, decimals] = await Promise.all([this.tokenPrices(mints), this.decimals(mints)]);
    const nowSec = Math.floor(Date.now() / 1000);
    let usd = 0;
    for (const mint of mints) {
      const raw = bought.get(mint)!;
      const price = prices.get(mint);
      const dec = decimals.get(mint);
      if (price === undefined || dec === undefined) return null;
      usd += (Number(raw) / 10 ** dec) * effectiveMultiplier(tokens[mint]?.scaledUi ?? null, nowSec) * price;
    }
    return usd;
  }

  /**
   * What these raw token amounts are worth now (Jupiter prices), or null if one has no price.
   * A sale is quoted from this, so a price the API missed is asked for once more.
   */
  async tokensUsd(held: [string, bigint][]): Promise<number | null> {
    const first = await this.#tokensUsdOnce(held);
    if (first !== null) return first;
    await new Promise((r) => setTimeout(r, 500));
    // Still nothing: the last price known for each token, however old. It only sizes the sale's
    // expected proceeds (the swap itself is quoted live), so one failed read doesn't block a sale.
    return (await this.#tokensUsdOnce(held)) ?? this.#tokensUsdOnce(held, true);
  }

  async #tokensUsdOnce(held: [string, bigint][], lastKnown = false): Promise<number | null> {
    const mints = held.map(([mint]) => mint);
    const [prices, decimals] = await Promise.all([lastKnown ? this.#lastKnownPrices(mints) : this.tokenPrices(mints), this.decimals(mints)]);
    const tokens = this.#o.bank().tokens;
    const nowSec = Math.floor(Date.now() / 1000);
    let usd = 0;
    for (const [mint, amount] of held) {
      const price = prices.get(mint);
      const d = decimals.get(mint);
      if (price == null || d == null) return null;
      // Jupiter's price is per UI token: raw amounts are scaled by the mint's multiplier first.
      usd += (Number(amount) / 10 ** d) * effectiveMultiplier(tokens[mint]?.scaledUi ?? null, nowSec) * price;
    }
    return usd;
  }

  /**
   * Live marks (8 decimals) per position and leg, on the leg's entry basis, by the shared rules
   * (valueLeg): a token-priced leg on its token while the token holds the $50k floor, else on the
   * stock times the token's premium at entry; a stock-priced leg on the stock (Alpaca). Legs with
   * no entry basis yet fall back to the stock. Prediction legs mark at their exit price now (never
   * from a book that doesn't add up), card legs at the card's insured value from the asset bank's
   * last reading. Null where there's no price. Token and stock marks are scaled by the token's
   * ScaledUiAmount multiplier now over the one recorded at entry, as the settler does, so a split
   * or a reinvested dividend isn't a loss.
   */
  async marks(take: TakeAccount, legs: MappedLeg[], positions: { publicKey: PublicKey; account?: { side: object } }[]): Promise<Map<string, (bigint | null)[]>> {
    type Need =
      /** `mint`: the token a token-priced entry bought, or the token a stock-priced entry holds (for its multiplier). */
      | { kind: "spot"; basis: SpotBasisRef; mint: string | null; perUi: number; stock: string | null; entryM?: number }
      | { kind: "paper"; leg: LegToValue; contract: NonNullable<MappedLeg["prediction"]>["contract"] }
      | { kind: "phoenix"; symbol: string; units: number; held: "back" | "fade" }
      | { kind: "lend"; shareMint: string }
      | { kind: "card"; usd: number | null }
      | null;
    const contracts = this.#o.bank().venues.gemini?.contracts;
    // Marks use the live market where it can be read (one read per event, cached briefly).
    const paper = legs.flatMap((l) => (l?.prediction ? [l.prediction.contract] : []));
    if (paper.length && positions.length) await this.#o.gemini?.refresh(paper);
    const current = (c: NonNullable<MappedLeg["prediction"]>["contract"]) => {
      const swept = contracts?.[c.instrumentSymbol] ?? c;
      return this.#o.gemini?.latest(c, swept) ?? swept;
    };
    const needs = new Map<string, Need[]>();
    for (const p of positions) {
      const key = p.publicKey.toBase58();
      needs.set(
        key,
        take.legs.map((leg, i): Need => {
          // A yield leg's mark is one vault share's value now (it counts in the score).
          if ("yield" in leg.kind) {
            const basis = this.#o.bases?.get(key, i) ?? null;
            return { kind: "lend", shareMint: basis?.source === "lend" ? basis.shareMint : JL_USDC_MINT };
          }
          // A card leg's mark is the card's insured value as the asset bank last read it (no CC request per mark).
          if ("card" in leg.kind) return { kind: "card", usd: cardLeg(this.#o.bank(), leg.asset.toBuffer().toString("hex"))?.insuredValueUsd ?? null };
          const held = p.account && "fade" in p.account.side ? "fade" : "back";
          // A prediction leg's mark is its exit price now (the held side's bid, or the resolution).
          const prediction = legs[i]?.prediction;
          if (prediction) return { kind: "paper", contract: current(prediction.contract), leg: { kind: "prediction", held, prediction: { side: prediction.side } } };
          const basis = this.#o.bases?.get(key, i) ?? null;
          const stock = stockOf(legs[i]?.key);
          if (basis?.source === "token") {
            return { kind: "spot", basis: { source: "token", premium: basis.premium }, mint: basis.mint, perUi: basis.underlyingPerUiToken, stock, entryM: basis.multiplier };
          }
          // Legs held on Phoenix (a back's perp leg, a fade's short) mark on Phoenix's mid.
          if (basis?.source === "phoenix") return { kind: "phoenix", symbol: basis.symbol, units: basis.unitsPerContract, held };
          const market = held === "fade" ? legs[i]?.short : "perp" in leg.kind ? legs[i]?.phoenix : undefined;
          if (market) return { kind: "phoenix", symbol: market.symbol, units: 1, held };
          if (!stock) return null;
          const holds = basis?.source === "stock" && basis.mint ? { mint: basis.mint, entryM: basis.multiplier } : { mint: null };
          return { kind: "spot", basis: { source: "stock" }, perUi: 1, stock, ...holds };
        }),
      );
    }
    const all = [...needs.values()].flat();
    const spots = all.filter((n): n is Extract<Need, { kind: "spot" }> => n?.kind === "spot");
    const mints = [...new Set(spots.flatMap((n) => (n.basis?.source === "token" && n.mint ? [n.mint] : [])))];
    const perps = [...new Set(all.flatMap((n) => (n?.kind === "phoenix" ? [n.symbol] : [])))];
    const vaults = [...new Set(all.flatMap((n) => (n?.kind === "lend" ? [n.shareMint] : [])))];
    const venue = this.#o.phoenix?.venue;
    // Phoenix's mid, else the asset bank's (when Phoenix's API is rate-limiting this address).
    const bankMid = (s: string) => this.#o.bank().venues.phoenix?.markets.find((m) => m.symbol === s)?.mid ?? null;
    const [shareValue, perpMid, tokenQuote] = await Promise.all([
      Promise.all(vaults.map(async (m) => [m, await this.lendShareValue(m)] as const)).then((e) => new Map(e)),
      Promise.all(perps.map(async (s) => [s, (venue ? await venue.mid(s).catch(() => null) : null) ?? bankMid(s)] as const)).then((e) => new Map(e)),
      this.tokenQuotes(mints),
    ]);
    const quoteOf = (mint: string | null) => {
      const q = mint ? tokenQuote.get(mint) : undefined;
      return q ? { usdPrice: q.usd, liquidityUsd: q.liquidityUsd } : null;
    };
    // The stock: for stock-priced legs, and for token-priced legs whose token can't be used now
    // (under the floor, or no price) and whose entry recorded a premium to carry it over.
    const needsStock = (n: Extract<Need, { kind: "spot" }>) =>
      n.stock !== null && (n.basis?.source === "stock" || (n.basis?.source === "token" && !!n.basis.premium && liquidTokenPrice(quoteOf(n.mint), n.perUi) === null));
    const symbols = [...new Set(spots.filter(needsStock).map((n) => n.stock!))];
    const stockUsd = new Map(await Promise.all(symbols.map(async (sym) => [sym, await this.#stockPrice(sym)] as const)));
    const units = (v: LegValue) => (v.ok ? toPriceUnits(v.price) : null);
    const bankTokens = this.#o.bank().tokens;
    const nowSec = Math.floor(Date.now() / 1000);
    // Multiplier now / at entry; null when the entry recorded one but the bank can't tell it now.
    const scaleOf = (mint: string | undefined, entryM: number | undefined): number | null => {
      if (!mint || !entryM || !(entryM > 0)) return 1;
      const t = bankTokens[mint];
      if (!t) return null;
      return effectiveMultiplier(t.scaledUi ?? null, nowSec) / entryM;
    };
    const out = new Map<string, (bigint | null)[]>();
    for (const [key, list] of needs) {
      out.set(
        key,
        list.map((n) => {
          if (!n) return null;
          if (n.kind === "paper") return units(valueLeg(n.leg, { contract: n.contract }));
          if (n.kind === "lend") return units(valueLeg({ kind: "yield", held: "back" }, { lendShareValue: shareValue.get(n.shareMint) }));
          if (n.kind === "card") return units(valueLeg({ kind: "card", held: "back" }, { cardInsuredUsd: n.usd }));
          if (n.kind === "phoenix") return units(valueLeg({ kind: "perp", held: n.held, perp: { unitsPerContract: n.units } }, { perp: perpMid.get(n.symbol) }));
          const scale = scaleOf(n.mint ?? undefined, n.entryM);
          if (scale === null) return null;
          return units(valueLeg(
            { kind: "spot", held: "back", spot: { perUi: n.perUi, basis: n.basis, scale } },
            { token: quoteOf(n.mint), stock: n.stock ? stockUsd.get(n.stock) : null },
          ));
        }),
      );
    }
    return out;
  }

  /**
   * One Jupiter Lend vault share's value in USDC (`jupiterLendShareValue`), cached for 60 s. When
   * a read fails, the last value read stands, however old (a share moves a few millionths a day).
   * `retry`: a failed read is tried once more first (a sale, which can't go ahead without a value).
   */
  async lendShareValue(shareMint: string, { retry = false } = {}): Promise<number | null> {
    const hit = this.#shareCache.get(shareMint);
    if (hit && hit.at > Date.now() - 60_000) return hit.usd;
    if (!this.#o.jupiterApiKey) this.#keyless();
    const read = () => jupiterLendShareValue(shareMint, { apiKey: this.#o.jupiterApiKey }).catch(() => null);
    let v = await read();
    if (!v && retry) {
      await new Promise((r) => setTimeout(r, 500));
      v = await read();
    }
    if (v) this.#shareCache.set(shareMint, { usd: v.usdcPerShare, at: Date.now() });
    return v?.usdcPerShare ?? hit?.usd ?? null;
  }
  #shareCache = new Map<string, { usd: number; at: number }>();

  /**
   * Prices go through api.jup.ag with JUPITER_API_KEY. Only without a key do they fall back to
   * the keyless lite-api (slower limits, being phased out): said once, so a missing key shows.
   */
  #keyless() {
    if (this.#warnedKeyless) return;
    this.#warnedKeyless = true;
    (this.#o.log ?? console.warn)("JUPITER_API_KEY isn't set: prices use Jupiter's keyless lite-api");
  }
  #warnedKeyless = false;

  /**
   * A stock's latest trade price (Alpaca), cached STOCK_CACHE_MS, one read per symbol at a time:
   * every receipt with a stock leg marks it, and a burst of receipts made one read each. A read
   * that fails or takes longer than STOCK_TIMEOUT_MS gives the last price seen in the last few
   * minutes, else none.
   */
  #stockPrice(symbol: string): Promise<number | null> {
    const stocks = this.#o.stocks;
    if (!stocks) return Promise.resolve(null);
    const hit = this.#stockCache.get(symbol);
    if (hit && hit.at > Date.now() - STOCK_CACHE_MS) return Promise.resolve(hit.usd);
    const pending = this.#stockReads.get(symbol);
    if (pending) return pending;
    const stale = () => (hit && hit.at > Date.now() - STOCK_STALE_MS ? hit.usd : null);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), STOCK_TIMEOUT_MS).unref()));
    const read = Promise.race([stocks.latestTrade(symbol).then((o) => o?.price ?? null), timeout])
      .catch(() => null)
      .then((usd) => {
        if (usd != null) this.#stockCache.set(symbol, { usd, at: Date.now() });
        return usd ?? stale();
      })
      .finally(() => {
        clearTimeout(timer);
        this.#stockReads.delete(symbol);
      });
    this.#stockReads.set(symbol, read);
    return read;
  }
  #stockCache = new Map<string, { usd: number; at: number }>();
  #stockReads = new Map<string, Promise<number | null>>();

  /** The last price known for each mint, however old: this API's last Jupiter read, else the asset bank's. */
  async #lastKnownPrices(mints: string[]): Promise<Map<string, number>> {
    const tokens = this.#o.bank().tokens;
    const out = new Map<string, number>();
    for (const m of mints) {
      const usd = this.#priceCache.get(m)?.usd ?? tokens[m]?.price?.usd;
      if (usd && usd > 0) out.set(m, usd);
    }
    return out;
  }

  /** USD per UI token (after any scaled-UI multiplier): tokenQuotes' prices. */
  async tokenPrices(mints: string[]): Promise<Map<string, number>> {
    const quotes = await this.tokenQuotes(mints);
    return new Map([...quotes].map(([m, q]) => [m, q.usd]));
  }

  /**
   * Token prices for display, with pooled liquidity (for the floor). The asset bank's batched
   * price when it's under BANK_FRESH_MS old, or this API's Jupiter read under PRICE_CACHE_MS;
   * otherwise one Jupiter Price v3 call per 50 mints, shared by concurrent views. When Jupiter
   * doesn't answer (the key is shared by every process), the newest price known stands in up to
   * DISPLAY_STALE_MS old; past that the token has no price.
   */
  async tokenQuotes(mints: string[]): Promise<Map<string, TokenQuote>> {
    const uniq = [...new Set(mints)];
    const file = uniq.length ? await this.#bankPrices() : null;
    const pick = (m: string, cacheMs: number, bankMs: number): TokenQuote | null => {
      const now = Date.now();
      const c = this.#priceCache.get(m);
      const b = this.#bankQuote(m, file);
      const ok = [c && c.at > now - cacheMs ? c : null, b && b.at > now - bankMs ? b : null].filter((q): q is TokenQuote => q !== null);
      return ok.sort((x, y) => y.at - x.at)[0] ?? null;
    };
    const out = new Map<string, TokenQuote>();
    const missing: string[] = [];
    for (const m of uniq) {
      const q = pick(m, PRICE_CACHE_MS, BANK_FRESH_MS);
      if (q) out.set(m, q);
      else missing.push(m);
    }
    if (missing.length) await this.#readJupiter(missing);
    for (const m of missing) {
      const q = pick(m, DISPLAY_STALE_MS, DISPLAY_STALE_MS);
      if (q) out.set(m, q);
    }
    return out;
  }

  /** The asset bank's price for a mint: its prices file or the copy in memory, whichever is newer. */
  #bankQuote(mint: string, file: BankPrices | null): TokenQuote | null {
    const t = this.#o.bank().tokens[mint];
    const f = file?.tokens[mint];
    const fromFile = f && f.usd > 0 ? { usd: f.usd, at: Date.parse(f.at), liquidityUsd: f.pooledUsd ?? t?.jupiterPooledUsd ?? 0 } : null;
    const fromMemory = t?.price && t.price.usd > 0 ? { usd: t.price.usd, at: Date.parse(t.price.at), liquidityUsd: t.jupiterPooledUsd ?? 0 } : null;
    const all = [fromFile, fromMemory].filter((q): q is TokenQuote => q !== null && Number.isFinite(q.at));
    return all.sort((x, y) => y.at - x.at)[0] ?? null;
  }

  /** The bank's prices file, re-read at most every BANK_FILE_READ_MS (one read at a time). */
  async #bankPrices(): Promise<BankPrices | null> {
    const f = this.#bankFile;
    if (!this.#pricesFile) return null;
    if (Date.now() - f.readAt < BANK_FILE_READ_MS) return f.prices;
    f.pending ??= readBankPrices(this.#pricesFile).then((p) => {
      f.prices = p ?? f.prices;
      f.readAt = Date.now();
      f.pending = null;
      return f.prices;
    });
    return f.pending;
  }

  /** Reads these mints from Jupiter Price v3, 50 per call; a mint already being read waits for that read. */
  async #readJupiter(mints: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const todo: string[] = [];
    for (const m of mints) {
      const pending = this.#priceReads.get(m);
      if (pending) waits.push(pending);
      else todo.push(m);
    }
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const read = this.#fetchPrices(batch).finally(() => {
        for (const m of batch) if (this.#priceReads.get(m) === read) this.#priceReads.delete(m);
      });
      for (const m of batch) this.#priceReads.set(m, read);
      waits.push(read);
    }
    await Promise.all(waits);
  }

  async #fetchPrices(mints: string[]): Promise<void> {
    const key = this.#o.jupiterApiKey;
    if (!key) this.#keyless();
    const r = await fetch(`${key ? "https://api.jup.ag" : "https://lite-api.jup.ag"}/price/v3?ids=${mints.join(",")}`, {
      headers: key ? { "x-api-key": key } : {},
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => ({}))) as Record<string, { usdPrice?: number; liquidity?: number }>) : {};
    const at = Date.now();
    const tokens = this.#o.bank().tokens;
    for (const [mint, v] of Object.entries(j ?? {})) {
      if (typeof v?.usdPrice !== "number") continue;
      this.#priceCache.set(mint, { usd: v.usdPrice, liquidityUsd: typeof v.liquidity === "number" ? v.liquidity : (tokens[mint]?.jupiterPooledUsd ?? 0), at });
    }
  }

  /** Mint decimals: the asset bank's, else read from the chain once. */
  async decimals(mints: string[]): Promise<Map<string, number>> {
    const tokens = this.#o.bank().tokens;
    const missing = mints.filter((m) => tokens[m] === undefined && !this.#mintDecimals.has(m));
    if (missing.length) {
      const infos = await this.#o.connection.getMultipleParsedAccounts(missing.map((m) => new PublicKey(m)));
      infos.value.forEach((info, i) => {
        const d = (info?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals;
        if (typeof d === "number") this.#mintDecimals.set(missing[i], d);
      });
    }
    const out = new Map<string, number>();
    for (const m of mints) {
      const d = tokens[m]?.decimals ?? this.#mintDecimals.get(m);
      if (d !== undefined) out.set(m, d);
    }
    return out;
  }
}
