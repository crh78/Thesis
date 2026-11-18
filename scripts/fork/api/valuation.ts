// What positions are worth on the fork: token prices (Jupiter), stock prices (Alpaca), the tokens
// each position bought, and live marks on each leg's entry basis.
import { PublicKey } from "@solana/web3.js";
import type { TakeAccount } from "@thesis/chain";
import { boughtTokens } from "@thesis/executor/settler";
import { cardLeg, effectiveMultiplier, underlyingIdHex } from "@thesis/venues/bank";
import { legPrice } from "@thesis/venues/gemini";
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
/** How old an asset-bank price can be and still stand in for a missing Jupiter read (display only). */
const BANK_PRICE_MAX_AGE_MS = 30 * 60_000;

export class Valuation {
  #o: ServiceOpts;
  #store: StateStore;
  #priceCache = new Map<string, { usd: number; at: number }>();
  /** Tokens each position's trade bought (fixed once the trade has landed). */
  #bought = new Map<string, Map<string, bigint>>();
  #mintDecimals = new Map<string, number>();

  constructor(o: ServiceOpts, store: StateStore) {
    this.#o = o;
    this.#store = store;
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
   * Live marks (8 decimals) per position and leg, on the leg's entry basis: the token the owner
   * bought (Jupiter Price), or the stock (Alpaca). Legs with no entry basis yet fall back to the
   * stock. Prediction legs mark at their exit price now, card legs at the card's insured value from
   * the asset bank's last reading. Null where there's no source (a non-stock with no token).
   * Token and stock marks are scaled by the token's ScaledUiAmount multiplier now over the one
   * recorded at entry, as the settler does, so a split or a reinvested dividend isn't a loss.
   */
  async marks(take: TakeAccount, legs: MappedLeg[], positions: { publicKey: PublicKey; account?: { side: object } }[]): Promise<Map<string, (bigint | null)[]>> {
    type Need =
      | { kind: "token"; mint: string; perUi: number; entryM?: number }
      | { kind: "stock"; symbol: string; mint?: string; entryM?: number }
      | { kind: "paper"; price: number | null }
      | { kind: "phoenix"; symbol: string; units: number }
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
          // A prediction leg's mark is its exit price now (the held side's bid, or the resolution).
          const prediction = legs[i]?.prediction;
          if (prediction) {
            const c = current(prediction.contract);
            const held = p.account && "fade" in p.account.side ? "fade" : "back";
            return { kind: "paper", price: legPrice(c, prediction.side, held, "exit") };
          }
          const basis = this.#o.bases?.get(key, i) ?? null;
          if (basis?.source === "token") return { kind: "token", mint: basis.mint, perUi: basis.underlyingPerUiToken, entryM: basis.multiplier };
          // Legs held on Phoenix (a back's perp leg, a fade's short) mark on Phoenix's mid.
          if (basis?.source === "phoenix") return { kind: "phoenix", symbol: basis.symbol, units: basis.unitsPerContract };
          const fade = Boolean(p.account && "fade" in p.account.side);
          const market = fade ? legs[i]?.short : "perp" in leg.kind ? legs[i]?.phoenix : undefined;
          if (market) return { kind: "phoenix", symbol: market.symbol, units: 1 };
          const u = legs[i]?.key;
          if (!u || !/^(equity|etf):/.test(u)) return null;
          return { kind: "stock", symbol: u.split(":")[2], ...(basis?.source === "stock" && basis.mint ? { mint: basis.mint, entryM: basis.multiplier } : {}) };
        }),
      );
    }
    const all = [...needs.values()].flat();
    const mints = [...new Set(all.flatMap((n) => (n?.kind === "token" ? [n.mint] : [])))];
    const symbols = [...new Set(all.flatMap((n) => (n?.kind === "stock" ? [n.symbol] : [])))];
    const perps = [...new Set(all.flatMap((n) => (n?.kind === "phoenix" ? [n.symbol] : [])))];
    const vaults = [...new Set(all.flatMap((n) => (n?.kind === "lend" ? [n.shareMint] : [])))];
    const shareValue = new Map(await Promise.all(vaults.map(async (m) => [m, await this.lendShareValue(m)] as const)));
    const venue = this.#o.phoenix?.venue;
    // Phoenix's mid, else the asset bank's (when Phoenix's API is rate-limiting this address).
    const bankMid = (s: string) => this.#o.bank().venues.phoenix?.markets.find((m) => m.symbol === s)?.mid ?? null;
    const perpMid = new Map(await Promise.all(perps.map(async (s) => [s, (venue ? await venue.mid(s).catch(() => null) : null) ?? bankMid(s)] as const)));
    const [tokenUsd, stockUsd] = await Promise.all([
      this.tokenPrices(mints),
      Promise.all(symbols.map(async (sym) => [sym, await this.#stockPrice(sym)] as const)).then((e) => new Map(e)),
    ]);
    const toUnits = (usd: number | null | undefined) => (usd && usd > 0 ? BigInt(Math.round(usd * 1e8)) : null);
    const bankTokens = this.#o.bank().tokens;
    const nowSec = Math.floor(Date.now() / 1000);
    // Multiplier now / at entry; null when the entry recorded one but the bank can't tell it now.
    const scaleOf = (mint: string | undefined, entryM: number | undefined): number | null => {
      if (!mint || !entryM || !(entryM > 0)) return 1;
      const t = bankTokens[mint];
      if (!t) return null;
      return effectiveMultiplier(t.scaledUi ?? null, nowSec) / entryM;
    };
    const scaled = (usd: number | null | undefined, scale: number | null) => (scale === null || usd == null ? null : usd * scale);
    const out = new Map<string, (bigint | null)[]>();
    for (const [key, list] of needs) {
      out.set(
        key,
        list.map((n) => {
          if (!n) return null;
          if (n.kind === "paper") return n.price === null ? null : BigInt(Math.round(n.price * 1e8));
          if (n.kind === "stock") return toUnits(scaled(stockUsd.get(n.symbol), scaleOf(n.mint, n.entryM)));
          if (n.kind === "lend") return toUnits(shareValue.get(n.shareMint));
          if (n.kind === "card") return toUnits(n.usd);
          if (n.kind === "phoenix") {
            const mid = perpMid.get(n.symbol);
            return toUnits(mid != null ? mid / n.units : null);
          }
          const usd = tokenUsd.get(n.mint);
          return toUnits(scaled(usd !== undefined ? usd / n.perUi : null, scaleOf(n.mint, n.entryM)));
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

  /** USD per UI token (after any scaled-UI multiplier) from Jupiter Price v3, cached for 10 s. */
  async tokenPrices(mints: string[]): Promise<Map<string, number>> {
    const now = Date.now();
    const stale = mints.filter((m) => !((this.#priceCache.get(m)?.at ?? 0) > now - PRICE_CACHE_MS));
    const key = this.#o.jupiterApiKey;
    if (!key && stale.length) this.#keyless();
    for (let i = 0; i < stale.length; i += 50) {
      const ids = stale.slice(i, i + 50).join(",");
      const r = await fetch(`${key ? "https://api.jup.ag" : "https://lite-api.jup.ag"}/price/v3?ids=${ids}`, {
        headers: key ? { "x-api-key": key } : {},
        signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
      }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => ({}))) as Record<string, { usdPrice?: number }>) : {};
      for (const [mint, v] of Object.entries(j)) if (typeof v?.usdPrice === "number") this.#priceCache.set(mint, { usd: v.usdPrice, at: now });
    }
    const out = new Map<string, number>();
    // Jupiter drops reads when this address calls it too often (the VM's asset bank shares it):
    // a token it didn't answer for falls back to the asset bank's price, if under 30 minutes old.
    const tokens = this.#o.bank().tokens;
    for (const m of mints) {
      const c = this.#priceCache.get(m);
      if (c) out.set(m, c.usd);
      else {
        const banked = tokens[m]?.price;
        if (banked && banked.usd > 0 && Date.now() - Date.parse(banked.at) < BANK_PRICE_MAX_AGE_MS) out.set(m, banked.usd);
      }
    }
    return out;
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
