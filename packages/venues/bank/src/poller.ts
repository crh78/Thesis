// The tiered asset-bank poller. Each tier refreshes one kind of data on its own
// cadence and only touches what is stale:
//
//   discovery  hourly     Jupiter verified tokens + rStocks search, mint accounts (multipliers,
//                         pause, fees), Pyth feed ids
//   prices     ~90 s      Jupiter Price v3, 50 mints per call, probe candidates only
//   probes     every 60 s $100 and $1,000 USDC quotes at maxAccounts=30 for the stalest tokens,
//                         sized to the Jupiter budget so each routed token refreshes every ~7.5 min
//   phoenix    10 min     every perp market and its order-book depth
//   gemini     10 min     active prediction-market events by category
//   cards      15 min     Collector Crypt listings, and the cards baskets picked (card legs)
//   yield      15 min     Kamino Earn and Jupiter Lend USDC APYs
//   flush      15 s       writes what changed to the sink
import { describeEnv, loadEnv } from "../../registry/src/lib/env.ts";
import { isPrivate } from "../../registry/src/lib/http.ts";
import { Rpc } from "../../registry/src/lib/solana.ts";
import { ISSUERS, MINT_INFO, themesFor } from "../../registry/src/curated.ts";
import type { JupToken } from "../../registry/src/sources/jupiter.ts";
import { loadPhoenix } from "../../registry/src/sources/phoenix.ts";
import { loadGeminiMarkets } from "../../registry/src/sources/gemini.ts";
import type { GeminiContract } from "../../gemini/src/markets.ts";
import { mergeGeminiContracts } from "./predictions.ts";
import { loadCollectorCrypt } from "../../registry/src/sources/cards.ts";
import { CollectorCryptClient, cardPrice } from "../../collector-crypt/src/index.ts";
import { cardsToRead, mergePicked, pickedCard, type PickedCard } from "./cards.ts";
import { loadJupiterLend, loadKamino } from "../../registry/src/sources/yield.ts";
import { loadPythCatalog } from "../../registry/src/sources/pyth.ts";
import { categoryOf, issuerTagOf, parseMint, underlyingOf } from "../../registry/src/tokens.ts";
import { type BankConfig } from "./config.ts";
import { displayName, phoenixUnderlyingKey, spotUnderlyingKey } from "./identity.ts";
import { JupiterClient, toProbeQuote } from "./jupiter.ts";
import { ratioFor, readScaledUi, usPersonsFor } from "./ratios.ts";
import { cleanDirty, isDirty, type BankSink, type Dirty } from "./sinks.ts";
import { Scheduler, realClock, type Clock, type Job, type SchedulerEvent } from "./scheduler.ts";
import { ageMs, emptyState, isProbeCandidate, newUnderlying, reclassify, selectStale, type BankState, type PerpMarket, type TokenEntry } from "./state.ts";

export type TierName = "discovery" | "prices" | "probes" | "phoenix" | "gemini" | "cards" | "yield" | "flush";
export const TIERS: TierName[] = ["discovery", "prices", "probes", "phoenix", "gemini", "cards", "yield", "flush"];

export type PollerDeps = {
  sink: BankSink;
  config: BankConfig;
  jupiter?: JupiterClient;
  rpc?: Rpc;
  clock?: Clock;
  log?: (msg: string) => void;
  /**
   * Runs after each Gemini sweep with the contracts it read (the executor keeps the take builder's
   * catalog current with it). A failure is logged; the sweep still counts.
   */
  afterGemini?: (contracts: GeminiContract[]) => Promise<void>;
  /**
   * The Collector Crypt card ids baskets have picked (the executor reads the catalog's `card:`
   * rows). The cards tier reads each one so the settler can price card legs. None: not tracked.
   */
  pickedCards?: () => Promise<string[]>;
  cardClient?: CollectorCryptClient;
};

/** Counts outgoing requests per host (QuickNode shown as "quicknode", never its URL). */
export class RequestCounter {
  byHost: Record<string, number> = {};
  since = Date.now();
  #orig: typeof fetch | null = null;
  install() {
    if (this.#orig) return;
    const orig = (this.#orig = globalThis.fetch);
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let host = "other";
      try {
        host = isPrivate(url) ? "quicknode" : new URL(url).host;
      } catch {}
      this.byHost[host] = (this.byHost[host] ?? 0) + 1;
      return orig(input, init);
    }) as typeof fetch;
  }
  uninstall() {
    if (this.#orig) globalThis.fetch = this.#orig;
    this.#orig = null;
  }
  perHour(nowMs = Date.now()): Record<string, number> {
    const h = Math.max(1, nowMs - this.since) / 3_600_000;
    return Object.fromEntries(Object.entries(this.byHost).map(([k, v]) => [k, Math.round(v / h)]));
  }
}

export class AssetBankPoller {
  state: BankState;
  config: BankConfig;
  sink: BankSink;
  jup: JupiterClient;
  rpc: Rpc;
  clock: Clock;
  log: (msg: string) => void;
  afterGemini: PollerDeps["afterGemini"];
  pickedCards: PollerDeps["pickedCards"];
  cardClient: CollectorCryptClient;
  dirty: Dirty = cleanDirty();
  /** Cap on tokens probed per probe run (smoke tests); Infinity in production. */
  maxProbesPerRun = Infinity;

  constructor(state: BankState | null, d: PollerDeps) {
    this.config = d.config;
    this.sink = d.sink;
    this.clock = d.clock ?? realClock;
    this.log = d.log ?? ((m) => console.log(m));
    this.afterGemini = d.afterGemini;
    this.pickedCards = d.pickedCards;
    this.cardClient = d.cardClient ?? new CollectorCryptClient();
    const env = d.jupiter && d.rpc ? null : loadEnv();
    if (env) this.log(`asset-bank: ${describeEnv(env)}`);
    this.jup = d.jupiter ?? new JupiterClient(env!.jupiterApiKey, this.config.jupiterRpm);
    this.rpc = d.rpc ?? new Rpc(env!.rpcUrl);
    this.state = state ?? emptyState(new Date(this.clock.now()));
    if (!state) this.markAll();
  }

  static async open(d: PollerDeps): Promise<AssetBankPoller> {
    return new AssetBankPoller(await d.sink.load(), d);
  }

  markAll() {
    for (const m of Object.keys(this.state.tokens)) this.dirty.tokens.add(m);
    for (const k of Object.keys(this.state.underlyings)) this.dirty.underlyings.add(k);
    for (const v of Object.keys(this.state.venues)) this.dirty.venues.add(v);
    this.dirty.meta = true;
  }

  nowIso() {
    return new Date(this.clock.now()).toISOString();
  }

  #reclassify() {
    const changed = reclassify(this.state, this.clock.now(), { tradeableCostPct: this.config.tradeableCostPct, maxDeviationPct: this.config.maxDeviationPct, refMaxAgeMs: this.config.freshness.maxPriceAgeMs });
    for (const k of changed) {
      this.dirty.underlyings.add(k);
      for (const m of this.state.underlyings[k]?.mints ?? []) this.dirty.tokens.add(m);
    }
  }

  candidates(): TokenEntry[] {
    return Object.values(this.state.tokens).filter((t) => isProbeCandidate(t, this.config.quoteFloorUsd));
  }

  // ---- tiers ----

  async discovery(): Promise<void> {
    const verified = await this.jup.verifiedTokens();
    let remora: JupToken[] = [];
    try {
      remora = (await this.jup.search("rStock")).filter((t) => /rStock$/.test(t.name ?? ""));
    } catch (e) {
      this.log(`discovery: rStock search failed: ${(e as Error).message}`);
    }
    const byMint = new Map<string, JupToken>();
    for (const t of [...verified, ...remora]) byMint.set(t.id, t);
    const universe = [...byMint.values()].filter((t) => categoryOf(t, issuerTagOf(t)) !== null);
    if (universe.length < 50) throw new Error(`discovery: only ${universe.length} tokens in Jupiter's list; keeping the previous bank`);
    // Mint accounts carry the ScaledUiAmount multiplier, pause state and fees. Re-read hourly only
    // for new tokens and probe candidates (whose multiplier feeds routing); the rest once a day.
    const t0 = this.clock.now();
    const toRead = universe.filter((t) => {
      const prev = this.state.tokens[t.id];
      if (!prev?.mintReadAt) return true;
      const age = ageMs(prev.mintReadAt, t0);
      const candidate = isProbeCandidate(prev, this.config.quoteFloorUsd) || (t.liquidity ?? 0) >= this.config.quoteFloorUsd;
      return age >= 24 * 3_600_000 || (candidate && age >= this.config.discoveryMs * 0.9);
    });
    const [epochInfo, mints] = await Promise.all([this.rpc.call<any>("getEpochInfo", []), this.rpc.getAccounts(toRead.map((t) => t.id), "jsonParsed")]);
    let catalog: Map<string, { id: string }> | null = null;
    try {
      catalog = await loadPythCatalog();
    } catch (e) {
      this.log(`discovery: Pyth catalog failed: ${(e as Error).message}`);
    }
    const nowMs = this.clock.now();
    const now = this.nowIso();
    const nowSec = Math.floor(nowMs / 1000);
    let added = 0;
    let unkeyed = 0;
    const namesBy = new Map<string, string[]>();
    for (const t of universe) {
      const tag = issuerTagOf(t);
      const category = categoryOf(t, tag)!;
      const und = underlyingOf(t, tag);
      const key = spotUnderlyingKey({ mint: t.id, name: t.name, category, underlying: und });
      if (!key) {
        unkeyed++;
        continue;
      }
      const prev = this.state.tokens[t.id];
      const acc = mints.get(t.id);
      // Not read this run: keep the previous facts.
      const read = acc !== undefined || !prev;
      const facts = parseMint(acc, Number(epochInfo.epoch), nowSec);
      const mi = MINT_INFO[t.id];
      if (prev && prev.underlying !== key) this.#detach(prev.mint, prev.underlying);
      const entry: TokenEntry = {
        mint: t.id,
        symbol: t.symbol,
        name: t.name,
        issuer: (tag ? ISSUERS[tag]?.issuer : null) ?? mi?.issuer ?? `unverified (${t.name})`,
        issuerTag: tag,
        category,
        underlying: key,
        decimals: read ? (facts.decimals ?? t.decimals) : prev.decimals,
        program: read ? facts.program : prev.program,
        transferFeeBps: read ? facts.transferFeeBps : prev.transferFeeBps,
        paused: read ? facts.paused : prev.paused,
        defaultFrozen: read ? facts.defaultAccountState === "frozen" : prev.defaultFrozen,
        permanentDelegate: read ? Boolean(facts.permanentDelegate) : prev.permanentDelegate,
        scaledUi: read ? (acc ? readScaledUi(acc) : null) : prev.scaledUi,
        ratio: ratioFor({ mint: t.id, issuerTag: tag, underlyingKey: key }),
        usPersons: usPersonsFor({ mint: t.id, issuerTag: tag }),
        jupiterPooledUsd: t.liquidity ?? null,
        holders: t.holderCount ?? null,
        pythFeedId: catalog?.get(mi?.pyth ?? `Crypto.${t.symbol.toUpperCase()}/USD`)?.id ?? prev?.pythFeedId ?? null,
        discoveredAt: prev?.discoveredAt ?? now,
        seenAt: now,
        mintReadAt: acc ? now : (prev?.mintReadAt ?? null),
        price: prev?.price ?? null,
        probe: prev?.probe ?? null,
        liquidity: prev?.liquidity ?? { class: "unprobed", reason: "not probed yet", cost100Pct: null, cost1000Pct: null, unitsPerUsd100: null, premium100Pct: null, ratioSuspect: false },
      };
      if (!prev) added++;
      this.state.tokens[t.id] = entry;
      this.dirty.tokens.add(t.id);
      const u = (this.state.underlyings[key] ??= newUnderlying(key, t.name, []));
      if (!u.mints.includes(t.id)) u.mints.push(t.id);
      namesBy.set(key, [...(namesBy.get(key) ?? []), t.name]);
    }
    // Names, themes and Pyth feeds per underlying.
    for (const [key, names] of namesBy) {
      const u = this.state.underlyings[key];
      const tokens = u.mints.map((m) => this.state.tokens[m]).filter(Boolean);
      u.name = displayName(names, key);
      u.themes = [...new Set([...themesFor(u.code), ...tokens.flatMap((t) => themesFor(t.symbol)), ...(u.cls === "commodity" ? ["Commodities"] : [])])];
      const sym = u.cls === "equity" || u.cls === "etf" ? `Equity.US.${u.code}/USD` : u.cls === "commodity" ? `Metal.${u.code}/USD` : u.cls === "private" ? `Equity.Index.${u.code}/USD` : null;
      u.pythFeedId = (sym && catalog?.get(sym)?.id) ?? u.pythFeedId;
      this.dirty.underlyings.add(key);
    }
    // Drop tokens Jupiter stopped listing a day ago.
    let dropped = 0;
    for (const t of Object.values(this.state.tokens)) {
      if (ageMs(t.seenAt, nowMs) > this.config.dropAfterMs) {
        this.#detach(t.mint, t.underlying);
        delete this.state.tokens[t.mint];
        this.dirty.tokens.add(t.mint);
        dropped++;
      }
    }
    this.#reclassify();
    this.log(`discovery: ${universe.length} tokens (${toRead.length} mint accounts read, batch ${this.rpc.maxBatch}), ${added} new, ${dropped} dropped, ${unkeyed} without an underlying; ${Object.keys(this.state.underlyings).length} underlyings`);
  }

  #detach(mint: string, key: string) {
    const u = this.state.underlyings[key];
    if (!u) return;
    u.mints = u.mints.filter((m) => m !== mint);
    this.dirty.underlyings.add(key);
    if (!u.mints.length && !u.perps.length) delete this.state.underlyings[key];
  }

  async prices(): Promise<void> {
    const nowMs = this.clock.now();
    const due = this.candidates().filter((t) => ageMs(t.price?.at, nowMs) >= this.config.pricesMs * 0.9);
    if (!due.length) return;
    const prices = await this.jup.prices(due.map((t) => t.mint));
    const at = this.nowIso();
    for (const t of due) {
      const p = prices.get(t.mint);
      if (!p) continue;
      t.price = { usd: p.usdPrice, underlyingUsd: p.underlyingUsd, at };
      this.dirty.tokens.add(t.mint);
    }
    this.#reclassify();
    this.log(`prices: ${prices.size}/${due.length} priced in ${Math.ceil(due.length / 50)} calls`);
  }

  /** Tokens per probe run that fit the Jupiter budget left after prices and discovery. */
  probeBudget(): number {
    const c = this.candidates().length;
    const priceCallsPerMin = Math.ceil(c / 50) * (60_000 / Math.max(1, this.config.pricesMs));
    const discoveryPerMin = 2 * (60_000 / Math.max(1, this.config.discoveryMs));
    const quotesPerMin = Math.max(1, this.config.jupiterRpm - priceCallsPerMin - discoveryPerMin);
    const perRun = (quotesPerMin * this.config.probeTickMs) / 60_000;
    return Math.max(1, Math.floor(perRun / 2)); // up to 2 quotes per token
  }

  async probes(): Promise<void> {
    const nowMs = this.clock.now();
    const limit = Math.min(this.probeBudget(), this.maxProbesPerRun);
    const stale = selectStale(this.candidates(), nowMs, { ttlMs: this.config.probeTtlMs, unroutedTtlMs: this.config.unroutedTtlMs, limit });
    if (!stale.length) return;
    const [small, large] = this.config.probeSizesUsd;
    let quotes = 0;
    for (const t of stale) {
      const q1 = toProbeQuote(small, await this.jup.quote(t.mint, small, { maxAccounts: this.config.maxAccounts }));
      quotes++;
      // If $100 does not route, $1,000 will not either: save the request.
      const q2 = q1.routed ? toProbeQuote(large, await this.jup.quote(t.mint, large, { maxAccounts: this.config.maxAccounts })) : { ...q1, usd: large, error: `not quoted: $${small} did not route` };
      if (q1.routed) quotes++;
      t.probe = { at: this.nowIso(), maxAccounts: this.config.maxAccounts, quotes: [q1, q2] };
      this.dirty.tokens.add(t.mint);
    }
    this.#reclassify();
    this.log(`probes: ${stale.length} tokens, ${quotes} quotes (budget ${limit}/run)`);
  }

  async phoenix(): Promise<void> {
    // Paced: one book at a time, so live trades from this address can still read prices.
    const snap = await loadPhoenix({ minGapMs: this.config.phoenixGapMs, concurrency: 1 });
    const markets: PerpMarket[] = snap.markets.map((m) => {
      const { key, unitsPerContract } = phoenixUnderlyingKey(m);
      const imp = m.buyImpactPct["1000"];
      return { symbol: m.symbol, name: m.name, marketPubkey: m.marketPubkey, underlying: key, unitsPerContract, maxLeverage: m.maxLeverage, takerFeeBps: m.takerFeeBps, mid: m.mid, spreadBps: m.spreadBps, depthUsdWithin1Pct: m.depthUsdWithin1Pct, buyImpact1000Pct: imp, tradeable: m.mid !== null && imp !== null && imp < 1 };
    });
    for (const u of Object.values(this.state.underlyings)) {
      if (!u.perps.length) continue;
      u.perps = [];
      this.dirty.underlyings.add(u.key);
    }
    for (const m of markets) {
      const u = (this.state.underlyings[m.underlying] ??= newUnderlying(m.underlying, m.name, themesFor(m.symbol)));
      u.perps.push(m.symbol);
      this.dirty.underlyings.add(u.key);
    }
    for (const [k, u] of Object.entries(this.state.underlyings)) if (!u.mints.length && !u.perps.length) delete this.state.underlyings[k];
    this.state.venues.phoenix = { at: this.nowIso(), gated: snap.gated, markets };
    this.dirty.venues.add("phoenix");
    this.#reclassify();
    this.log(`phoenix: ${markets.length} markets, ${markets.filter((m) => m.tradeable).length} fill $1,000 within 1%`);
  }

  async gemini(): Promise<void> {
    const { summary, contracts } = await loadGeminiMarkets();
    const kept = mergeGeminiContracts(this.state.venues.gemini?.contracts ?? {}, contracts, Date.parse(this.nowIso()));
    this.state.venues.gemini = { at: this.nowIso(), summary, contracts: kept };
    this.dirty.venues.add("gemini");
    this.log(`gemini: ${summary.totalActiveEvents} active events`);
    if (this.afterGemini) await this.afterGemini(contracts).catch((e) => this.log(`gemini: after the sweep: ${e instanceof Error ? e.message : e}`));
  }

  async cards(): Promise<void> {
    const prev = this.state.venues.cards;
    // Picked cards first: card legs are priced from them, so a failed listings scan doesn't stop them.
    let picked = prev?.picked ?? {};
    if (this.pickedCards) {
      try {
        const ids = await this.pickedCards();
        const toRead = cardsToRead(picked, ids, this.clock.now(), this.config.cardsMaxReads);
        const read: PickedCard[] = [];
        for (const id of toRead) {
          const card = await this.cardClient.card(id).catch((e) => (this.log(`cards: ${id}: ${e instanceof Error ? e.message : e}`), null));
          if (card) read.push(pickedCard(card, cardPrice(card), this.nowIso()));
        }
        picked = mergePicked(picked, read);
        this.log(`cards: ${read.length} of ${ids.length} picked cards read (${Object.keys(picked).length} held)`);
      } catch (e) {
        this.log(`cards: picked cards: ${e instanceof Error ? e.message : e}`);
      }
    }
    let summary = prev?.summary ?? null;
    let failed: unknown = null;
    try {
      summary = await loadCollectorCrypt(this.config.cardsMaxPages);
      this.log(`cards: ${summary.scanned} listings scanned of ${summary.listedOnCollectorCrypt}`);
    } catch (e) {
      failed = e;
    }
    this.state.venues.cards = { at: failed ? (prev?.at ?? this.nowIso()) : this.nowIso(), summary, picked };
    this.dirty.venues.add("cards");
    if (failed) throw failed;
  }

  async yield(): Promise<void> {
    const [kamino, lend] = await Promise.allSettled([loadKamino(), loadJupiterLend()]);
    if (kamino.status === "rejected" && lend.status === "rejected") throw new Error(`yield: Kamino and Jupiter Lend both failed (${kamino.reason})`);
    const vaults = [...(lend.status === "fulfilled" ? lend.value : this.state.venues.yield?.vaults.filter((v) => v.venue === "Jupiter Lend Earn") ?? []), ...(kamino.status === "fulfilled" ? kamino.value.vaults : this.state.venues.yield?.vaults.filter((v) => v.venue === "Kamino Earn") ?? [])];
    this.state.venues.yield = { at: this.nowIso(), vaults };
    this.dirty.venues.add("yield");
    this.log(`yield: ${vaults.length} USDC vaults`);
  }

  async flush(): Promise<void> {
    if (!isDirty(this.dirty)) return;
    const d = this.dirty;
    this.dirty = cleanDirty();
    this.state.updatedAt = this.nowIso();
    d.meta = true;
    try {
      await this.sink.save(this.state, d);
    } catch (e) {
      // Put the changes back so the next flush retries them.
      for (const m of d.tokens) this.dirty.tokens.add(m);
      for (const k of d.underlyings) this.dirty.underlyings.add(k);
      for (const v of d.venues) this.dirty.venues.add(v);
      this.dirty.meta = true;
      throw e;
    }
  }

  // ---- scheduling ----

  #recordTier(e: SchedulerEvent) {
    const s = (this.state.tiers[e.job] ??= { lastStartAt: null, lastOkAt: null, lastError: null, lastDurationMs: null, runs: 0, requests: 0 });
    const at = new Date(e.at).toISOString();
    if (e.type === "start") {
      s.lastStartAt = at;
      s.runs++;
    } else {
      s.lastDurationMs = e.durationMs ?? null;
      if (e.type === "ok") {
        s.lastOkAt = at;
        s.lastError = null;
      } else s.lastError = e.error ?? "error";
    }
    if (e.job !== "flush") this.dirty.meta = true;
    if (e.type === "error") this.log(`${e.job}: FAILED: ${e.error}`);
  }

  jobs(only?: TierName[]): Job[] {
    const c = this.config;
    const all: Record<TierName, Job> = {
      discovery: { name: "discovery", intervalMs: c.discoveryMs, run: () => this.discovery() },
      // Prices and probes wait for the first discovery when the bank is empty.
      prices: { name: "prices", intervalMs: c.pricesMs, initialDelayMs: Object.keys(this.state.tokens).length ? 0 : 5_000, run: () => this.prices() },
      probes: { name: "probes", intervalMs: c.probeTickMs, initialDelayMs: Object.keys(this.state.tokens).length ? 0 : 10_000, run: () => this.probes() },
      phoenix: { name: "phoenix", intervalMs: c.phoenixMs, run: () => this.phoenix() },
      // A restart doesn't sweep Gemini again while the last sweep is recent.
      gemini: { name: "gemini", intervalMs: c.geminiMs, initialDelayMs: this.#untilDue(this.state.venues.gemini?.at, c.geminiMs), run: () => this.gemini() },
      cards: { name: "cards", intervalMs: c.cardsMs, run: () => this.cards() },
      yield: { name: "yield", intervalMs: c.yieldMs, run: () => this.yield() },
      flush: { name: "flush", intervalMs: c.flushMs, initialDelayMs: c.flushMs, run: () => this.flush() },
    };
    return (only ?? TIERS).map((t) => all[t]);
  }

  /** Ms until a tier last run at `at` is due again (0 if it never ran or is overdue). */
  #untilDue(at: string | undefined, intervalMs: number): number {
    const last = at ? Date.parse(at) : NaN;
    return Number.isFinite(last) ? Math.max(0, last + intervalMs - this.clock.now()) : 0;
  }

  scheduler(only?: TierName[]): Scheduler {
    return new Scheduler(this.jobs(only), { clock: this.clock, onEvent: (e) => this.#recordTier(e) });
  }

  /** Runs the given tiers once, in dependency order, then flushes. For smoke tests and cron use. */
  async runOnce(tiers: TierName[] = TIERS): Promise<Record<string, { ok: boolean; ms: number; error?: string }>> {
    const out: Record<string, { ok: boolean; ms: number; error?: string }> = {};
    const order: TierName[] = ["discovery", "phoenix", "prices", "probes", "gemini", "cards", "yield"];
    for (const t of order.filter((x) => tiers.includes(x))) {
      const t0 = this.clock.now();
      this.#recordTier({ type: "start", job: t, at: t0 });
      try {
        await (this as any)[t]();
        out[t] = { ok: true, ms: this.clock.now() - t0 };
        this.#recordTier({ type: "ok", job: t, at: this.clock.now(), durationMs: out[t].ms });
      } catch (e) {
        out[t] = { ok: false, ms: this.clock.now() - t0, error: String((e as Error).message ?? e).slice(0, 300) };
        this.#recordTier({ type: "error", job: t, at: this.clock.now(), durationMs: out[t].ms, error: out[t].error });
      }
    }
    await this.flush();
    return out;
  }
}

