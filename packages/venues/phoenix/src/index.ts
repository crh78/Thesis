// Phoenix perps (Ellipsis Labs) for perp legs and the shorts that fade stock and crypto legs.
// docs/phoenix-plan.md has the design. In short:
//   - each wallet has a parent trader account (subaccount 0), registered and onboarded once;
//   - each perp leg of each position trades in its own isolated child (1–100), which the receipt's
//     proof of trade names as the leg's output account;
//   - a leg's trade is two venue legs, a deposit (USDC → PhUSD → the child's collateral) and a
//     market order (long for a back, short for a fade, collateral × leverage);
//   - a sale closes the child's position; a sweep then withdraws its exact collateral to USDC
//     (Phoenix refuses to withdraw more than is there, and the amount is only known once the
//     close lands).
// Instructions come from Phoenix's TypeScript SDK (@solana/kit) and are converted to web3.js,
// which the composer and the rest of the repo use. The app's payer pays every fee and all rent.
import { calculateLiquidationPriceUsd, createPhoenixClient, getPlaceMarketOrderDecoder, MarginType, Side, type Authority, type PhoenixClient, type Symbol as MarketSymbol } from "@ellipsis-labs/rise";
import { AccountRole, type Instruction } from "@solana/kit";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { VenueLeg } from "../../jupiter/src/index.ts";
import { PERP_ASSET_MAP, PHOENIX_PROGRAM_ID, traderAddress, type TraderView } from "./layout.ts";

export * from "./layout.ts";
export * from "./makers.ts";

export const PHOENIX_API_URL = "https://perp-api.phoenix.trade";
/** How far a market order may fill from the price it was sized at. */
export const DEFAULT_SLIPPAGE = 0.01;
/** How long a market's mid is reused (Phoenix rate-limits reads per address). */
const MID_CACHE_MS = 5_000;
/** Compute for one Phoenix leg (deposit or order); orders use about 160–200k. */
export const PHOENIX_LEG_CU = 260_000;

export type PhoenixMarket = {
  symbol: string;
  assetId: number;
  marketPubkey: PublicKey;
  splinePubkey: PublicKey;
  baseLotsDecimals: number;
  isolatedOnly: boolean;
  /** Largest leverage the market allows for a small position. */
  maxLeverage: number;
  takerFee: number;
  status: string;
  /**
   * Risk parameters for liquidation math: maintenance margin is `maintenanceBps` of the initial
   * margin at the market's first leverage tier (`maxLeverage`), and `upnlBps` of a gain counts.
   */
  maintenanceBps: number;
  upnlBps: number;
};

/** Where a Phoenix position gets liquidated, by Phoenix's own equation. */
export type Liquidation = {
  side: "long" | "short";
  /** Signed size in the market's units (contracts). */
  size: number;
  entryUsd: number;
  /** Null when the position can't be liquidated by this market's price alone (fully backed). */
  liquidationUsd: number | null;
};

/**
 * A trader account's liquidation price for its position, solving Phoenix's static margin
 * equation (`calculateLiquidationPriceUsd`, the same boundary Phoenix's on-chain Hawkeye view
 * returns; checked on the fork: a 5x SOL long from $75.00, $61.2129 vs Hawkeye's $61.21).
 * Thesis children hold one position each, so nothing else in the account moves the answer.
 */
export function liquidationOf(t: TraderView, m: PhoenixMarket): Liquidation | null {
  const p = t.positions[0];
  if (!p) return null;
  const size = Number(p.baseLots) / 10 ** m.baseLotsDecimals;
  const entryUsd = -Number(p.virtualQuoteLots) / 1e6 / size;
  const liquidationUsd = calculateLiquidationPriceUsd({
    positionSize: size,
    entryPriceUsd: entryUsd,
    leverage: m.maxLeverage,
    maintenanceMarginBps: m.maintenanceBps,
    upnlRiskFactorBps: m.upnlBps,
    collateralUsd: Number(t.collateral) / 1e6,
  });
  return { side: size > 0 ? "long" : "short", size, entryUsd, liquidationUsd };
}

/** How far the mark is from liquidation, as a share of the mark (0.18 = an 18% move away). */
export function liquidationDistance(markUsd: number, l: Liquidation): number | null {
  if (l.liquidationUsd === null || !(markUsd > 0)) return null;
  return l.side === "long" ? (markUsd - l.liquidationUsd) / markUsd : (l.liquidationUsd - markUsd) / markUsd;
}

/** Phoenix's SDK brands its addresses and market symbols. */
const auth = (k: PublicKey) => k.toBase58() as Authority;
const sym = (s: string) => s as MarketSymbol;

/** A kit instruction as web3.js. */
export function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

/** `sha256("global:place_market_order")[..8]`. */
const PLACE_MARKET_ORDER = Buffer.from([90, 118, 192, 252, 192, 99, 39, 145]);

/** What a market order did, read from its instruction: which trader account, which market, which way. */
export type MarketOrder = { trader: PublicKey; orderbook: PublicKey; side: "long" | "short"; baseLots: bigint };

/**
 * A Phoenix `place_market_order` instruction's trader account (account 4), order book (second
 * to last) and side, or null for any other instruction. This is how the settler knows what a
 * leg's trade opened even after the position was sold.
 */
export function decodeMarketOrder(programId: PublicKey, keys: PublicKey[], data: Readonly<Uint8Array>): MarketOrder | null {
  if (!programId.equals(PHOENIX_PROGRAM_ID) || keys.length < 7 || !Buffer.from(data.slice(0, 8)).equals(PLACE_MARKET_ORDER)) return null;
  try {
    const packet = getPlaceMarketOrderDecoder().decode(data as Uint8Array) as unknown as { side: number; numBaseLots: bigint | number };
    return { trader: keys[4], orderbook: keys[keys.length - 2], side: packet.side === Side.Bid ? "long" : "short", baseLots: BigInt(packet.numBaseLots) };
  } catch {
    return null;
  }
}

/** Base units for `collateral` (USDC base units) × `leverage` at `price`, rounded down to a lot. */
export function orderSize(collateral: bigint, leverage: number, price: number, baseLotsDecimals: number): string {
  if (!(price > 0) || !(leverage >= 1)) throw new Error("order size needs a price and a leverage of at least 1");
  const notional = (Number(collateral) / 1e6) * leverage;
  const lots = Math.floor((notional / price) * 10 ** baseLotsDecimals);
  if (lots < 1) throw new Error(`$${notional.toFixed(2)} is less than one lot at $${price}`);
  return (lots / 10 ** baseLotsDecimals).toFixed(baseLotsDecimals);
}

export type Registration = {
  instructions: TransactionInstruction[];
  /** The key that must co-sign besides owner and payer: the fork's onboarder, or Phoenix's (via its API). */
  onboarder: PublicKey;
  /** The trader's parent account. */
  parent: PublicKey;
};

export class PhoenixVenue {
  readonly client: PhoenixClient;
  readonly apiUrl: string;
  #markets: { at: number; bySymbol: Map<string, PhoenixMarket>; byAsset: Map<number, PhoenixMarket>; byOrderbook: Map<string, PhoenixMarket> } | null = null;
  #fetch: typeof fetch;

  #backoffMs: number;

  constructor(o: { rpcUrl: string; apiUrl?: string; fetch?: typeof fetch; backoffMs?: number }) {
    this.apiUrl = o.apiUrl ?? PHOENIX_API_URL;
    this.client = createPhoenixClient({ apiUrl: this.apiUrl, rpcUrl: o.rpcUrl, exchangeMetadata: { stream: false } });
    this.#fetch = o.fetch ?? fetch;
    this.#backoffMs = o.backoffMs ?? 1_000;
  }

  /** Every market, from Phoenix's exchange metadata (cached for 10 minutes). */
  async markets(): Promise<{ bySymbol: Map<string, PhoenixMarket>; byAsset: Map<number, PhoenixMarket>; byOrderbook: Map<string, PhoenixMarket> }> {
    if (this.#markets && Date.now() - this.#markets.at < 10 * 60_000) return this.#markets;
    const snap = await this.#sdk(() => this.client.exchange.ready());
    const list: PhoenixMarket[] = snap.markets.map((m) => ({
      symbol: m.symbol,
      assetId: Number(m.assetId),
      marketPubkey: new PublicKey(m.marketPubkey),
      splinePubkey: new PublicKey(m.splinePubkey),
      baseLotsDecimals: m.baseLotsDecimals,
      isolatedOnly: Boolean(m.isolatedOnly),
      maxLeverage: Number(m.leverageTiers?.[0]?.maxLeverage ?? 1),
      takerFee: Number(m.takerFee),
      status: String(m.marketStatus),
      maintenanceBps: Number((m as { riskFactors?: { maintenanceBps?: number } }).riskFactors?.maintenanceBps ?? 5_000),
      upnlBps: Number((m as { riskFactors?: { upnlBps?: number } }).riskFactors?.upnlBps ?? 10_000),
    }));
    this.#markets = {
      at: Date.now(),
      bySymbol: new Map(list.map((m) => [m.symbol, m])),
      byAsset: new Map(list.map((m) => [m.assetId, m])),
      byOrderbook: new Map(list.map((m) => [m.marketPubkey.toBase58(), m])),
    };
    return this.#markets;
  }

  async market(symbol: string): Promise<PhoenixMarket> {
    const m = (await this.markets()).bySymbol.get(symbol);
    if (!m) throw new Error(`Phoenix lists no ${symbol} market`);
    return m;
  }

  /**
   * Retries a call into Phoenix's SDK while Phoenix's API rate-limits this address (HTTP 429:
   * about one read every two seconds). The SDK's builders only read and build instructions, and
   * a rate-limited registration send was refused, so a retry is safe.
   */
  async #sdk<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const limited = /\b429\b|rate_limited|Too Many Requests/i.test(e instanceof Error ? e.message : String(e));
        if (!limited || attempt >= 5) throw e;
        await new Promise((res) => setTimeout(res, 2 ** (attempt + 1) * this.#backoffMs));
      }
    }
  }

  /** Accounts a Phoenix trade reads from mainnet: the fork refreshes them first (book, makers, marks). */
  marketAccounts(m: PhoenixMarket): PublicKey[] {
    return [m.marketPubkey, m.splinePubkey, PERP_ASSET_MAP];
  }

  /**
   * Registers and onboards the parent account. Phoenix's API builds both instructions; its
   * onboarder key co-signs. With `fork`, a fork-only permission (layout.ts,
   * `forkOnboardingPermission`) stands in for Phoenix's, so the fork's own key co-signs.
   */
  async registration(o: { owner: PublicKey; payer: PublicKey; fork?: { onboarder: PublicKey; permission: PublicKey } }): Promise<Registration> {
    const r = await this.#sdk(() => this.client.api.exchange().buildRegisterIxs({
      traderAuthority: auth(o.owner),
      txFeePayer: auth(o.payer),
      maxPositions: 128,
    }));
    const theirs = r.traderOnboarder;
    let theirPermission: string | null = null;
    const instructions = r.instructions.map((ix) => {
      const i = new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(ix.data),
      });
      // The onboarding instruction: Phoenix's onboarder signs, its permission account follows.
      const at = ix.keys.findIndex((k) => k.pubkey === theirs && k.isSigner);
      if (at >= 0) theirPermission = ix.keys[at + 1]?.pubkey ?? null;
      return i;
    });
    if (!o.fork) return { instructions, onboarder: new PublicKey(theirs), parent: new PublicKey(r.traderPda) };
    if (!theirPermission) throw new Error("Phoenix's registration has no onboarding instruction to sign");
    const swap = new Map([[theirs, o.fork.onboarder], [theirPermission, o.fork.permission]]);
    for (const ix of instructions) for (const k of ix.keys) k.pubkey = swap.get(k.pubkey.toBase58()) ?? k.pubkey;
    return { instructions, onboarder: o.fork.onboarder, parent: new PublicKey(r.traderPda) };
  }

  /**
   * Mainnet: sends a registration the owner and payer signed to Phoenix, which adds its
   * onboarder's signature and submits it. Not used on the fork.
   */
  async submitRegistration(o: { signedBase64: string; owner: PublicKey; payer: PublicKey }): Promise<string> {
    const r = await this.#sdk(() => this.client.api.exchange().sendRegisterIxs({
      transaction: o.signedBase64,
      traderAuthority: auth(o.owner),
      txFeePayer: auth(o.payer),
      maxPositions: 128,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    }));
    return r.signature;
  }

  /** Registers child `sub` (room for one position) and copies the parent's onboarding to it. */
  async childRegistration(o: { owner: PublicKey; payer: PublicKey; sub: number }): Promise<TransactionInstruction[]> {
    const owner = auth(o.owner);
    const [register, sync] = await this.#sdk(() => Promise.all([
      this.client.ixs.buildRegisterTrader({ authority: owner, feePayer: auth(o.payer), marginType: MarginType.Isolated, traderSubaccountIndex: o.sub } as never),
      this.client.ixs.buildSyncParentToChild({ traderWallet: owner, traderPdaIndex: 0, traderSubaccountIndex: o.sub }),
    ]));
    return [toWeb3(register), toWeb3(sync)];
  }

  /**
   * A leg's trade: `collateral` USDC into child `sub`, then a market order for collateral ×
   * leverage at `price` (long or short), filling within `slippage` of it. Two venue legs, so the
   * composer can put them in separate transactions; both name the child as the leg's output.
   */
  async openLeg(o: {
    owner: PublicKey;
    payer: PublicKey;
    sub: number;
    symbol: string;
    side: "long" | "short";
    collateral: bigint;
    leverage: number;
    price: number;
    label: string;
    slippage?: number;
  }): Promise<VenueLeg[]> {
    const m = await this.market(o.symbol);
    const owner = auth(o.owner);
    const child = traderAddress(o.owner, o.sub);
    const slip = o.slippage ?? DEFAULT_SLIPPAGE;
    const baseUnits = orderSize(o.collateral, o.leverage, o.price, m.baseLotsDecimals);
    const side = o.side === "long" ? Side.Bid : Side.Ask;
    const limit = o.side === "long" ? o.price * (1 + slip) : o.price * (1 - slip);
    const [deposit, packet] = await this.#sdk(() => Promise.all([
      this.client.ixs.buildDepositIxs({ authority: owner, amount: o.collateral, feePayer: auth(o.payer), traderSubaccountIndex: o.sub }),
      this.client.orderPackets.buildMarketOrderPacket({ symbol: sym(o.symbol), side, baseUnits, priceLimitUsd: limit.toFixed(6) }),
    ]));
    const order = await this.#sdk(() => this.client.ixs.buildPlaceMarketOrder({ authority: owner, symbol: sym(o.symbol), orderPacket: packet, traderSubaccountIndex: o.sub }));
    const markets = this.marketAccounts(m);
    return [
      { label: `${o.label}: collateral`, instructions: deposit.instructions.map(toWeb3), lookupTables: [], marketAccounts: [], outputAccount: child },
      { label: `${o.label}: ${o.side} ${baseUnits} ${o.symbol}`, instructions: [toWeb3(order)], lookupTables: [], marketAccounts: markets, outputAccount: child },
    ];
  }

  /** Closes child `sub`'s position (`baseLots` as it stands: signed) with a market order. */
  async closeLeg(o: { owner: PublicKey; sub: number; symbol: string; baseLots: bigint; price: number; label: string; slippage?: number }): Promise<VenueLeg> {
    const m = await this.market(o.symbol);
    const lots = o.baseLots < 0n ? -o.baseLots : o.baseLots;
    const baseUnits = (Number(lots) / 10 ** m.baseLotsDecimals).toFixed(m.baseLotsDecimals);
    const slip = o.slippage ?? DEFAULT_SLIPPAGE;
    // Closing a long sells; closing a short buys.
    const side = o.baseLots > 0n ? Side.Ask : Side.Bid;
    const limit = o.baseLots > 0n ? o.price * (1 - slip) : o.price * (1 + slip);
    const packet = await this.#sdk(() => this.client.orderPackets.buildMarketOrderPacket({ symbol: sym(o.symbol), side, baseUnits, priceLimitUsd: limit.toFixed(6) }));
    const order = await this.#sdk(() => this.client.ixs.buildPlaceMarketOrder({ authority: auth(o.owner), symbol: sym(o.symbol), orderPacket: packet, traderSubaccountIndex: o.sub }));
    return { label: `${o.label}: close`, instructions: [toWeb3(order)], lookupTables: [], marketAccounts: this.marketAccounts(m) };
  }

  /**
   * Phoenix's `withdraw_to_target_leverage`: moves child `sub`'s collateral above what keeps its
   * position at `targetLeverageBps` (10,000 = 1x) to the parent (subaccount 0). After a partial
   * close this frees the closed share's margin while what's left keeps its leverage; `sweepLeg`
   * on the parent then withdraws it, once the amount is known.
   */
  async releaseLeg(o: { owner: PublicKey; sub: number; targetLeverageBps: bigint; label: string }): Promise<VenueLeg> {
    const ix = await this.#sdk(() => this.client.ixs.buildWithdrawToTargetLeverage({ authority: auth(o.owner), traderPdaIndex: 0, childSubaccountIndex: o.sub, targetLeverageBps: o.targetLeverageBps }));
    return { label: `${o.label}: release margin`, instructions: [toWeb3(ix)], lookupTables: [], marketAccounts: [] };
  }

  /** Withdraws `collateral` (exactly what trader account `sub` holds, with no position open) back to USDC. */
  async sweepLeg(o: { owner: PublicKey; payer: PublicKey; sub: number; collateral: bigint; label: string }): Promise<VenueLeg> {
    const wd = await this.#sdk(() => this.client.ixs.buildWithdrawIxs({ authority: auth(o.owner), amount: o.collateral, feePayer: auth(o.payer), traderSubaccountIndex: o.sub }));
    return { label: `${o.label}: withdraw`, instructions: wd.instructions.map(toWeb3), lookupTables: [], marketAccounts: [] };
  }

  /**
   * GET with backoff: Phoenix's public API answers 429 when an address reads too fast (the asset
   * bank's Phoenix sweep reads every market's book from the same VM). Retries 429s and 5xxs up
   * to four times, waiting Retry-After or 1, 2, 4, 8 s.
   */
  async #get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.#fetch(url);
      if ((r.status !== 429 && r.status < 500) || attempt >= 4) return r;
      const after = Number(r.headers.get("retry-after"));
      await new Promise((res) => setTimeout(res, (after > 0 && after <= 30 ? after : 2 ** attempt) * this.#backoffMs));
    }
  }

  /**
   * The market's mid from Phoenix's order book (mainnet), or null if one side is empty. Cached
   * for 5 s per market: Phoenix allows about one read every two seconds from an address.
   */
  async mid(symbol: string): Promise<number | null> {
    const hit = this.#mids.get(symbol);
    if (hit && Date.now() - hit.at < MID_CACHE_MS) return hit.value;
    // Callers at the same moment share one read; a failed read isn't kept.
    const value = this.#readMid(symbol);
    this.#mids.set(symbol, { at: Date.now(), value });
    value.catch(() => this.#mids.delete(symbol));
    return value;
  }
  #mids = new Map<string, { at: number; value: Promise<number | null> }>();

  async #readMid(symbol: string): Promise<number | null> {
    const r = await this.#get(`${this.apiUrl}/v1/view/orderbook/${encodeURIComponent(symbol)}`);
    if (!r.ok) throw new Error(`Phoenix order book ${symbol}: HTTP ${r.status}`);
    const book = (await r.json()) as { bids?: [number, number][]; asks?: [number, number][] };
    const bid = book.bids?.[0]?.[0];
    const ask = book.asks?.[0]?.[0];
    return bid && ask ? (bid + ask) / 2 : null;
  }

  /**
   * Phoenix's mark price at the first one-minute bar at or after `atSec`, within `maxDelaySecs`.
   * The mark is what Phoenix values positions and liquidations on. Null while no such bar exists.
   */
  async markAtOrAfter(symbol: string, atSec: number, maxDelaySecs: number): Promise<{ price: number; at: number } | null> {
    const from = Math.floor(atSec / 60) * 60 * 1000;
    const to = (atSec + maxDelaySecs) * 1000;
    const url = `${this.apiUrl}/v1/candles_v2/${encodeURIComponent(symbol)}?timeframe=1m&from=${from}&to=${to}&limit=10`;
    const r = await this.#get(url);
    if (!r.ok) throw new Error(`Phoenix candles ${symbol}: HTTP ${r.status}`);
    const body = (await r.json()) as { bars?: { time: number; markOpen?: number; open?: number }[] };
    // The bar's open is the mark at its start: only a bar starting at or after the moment counts.
    const bar = (body.bars ?? []).map((b) => ({ at: Math.floor(b.time / 1000), price: Number(b.markOpen ?? b.open) })).find((b) => b.at >= atSec && b.price > 0);
    return bar && bar.at <= atSec + maxDelaySecs ? bar : null;
  }
}

