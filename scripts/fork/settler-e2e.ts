// pnpm fork:settler-e2e — the settler's whole job on the fork, with made-up prices.
//
// Posts a two-leg take (NVDA 60%, SPY 40%) whose author never sells, so it runs its full year, and
// backs it, each buying the legs' issuer tokens through Jupiter (a receipt needs a real trade
// behind it), then runs the
// settler crank: entry prices and the "first take" badge, a time jump past the horizon, then
// exit prices, settlement of the take and its positions, and the "+50%" badge. Entry prices are
// the tokens' real Jupiter prices (the settler checks the tokens received are worth the stake);
// exits are made up from them (NVDA ×2, SPY ×1.1), so the take settles at +64%.
//
// It also checks proof of trade end to end: a receipt with no trade behind it is refused on-chain;
// a back that bought the wrong token for a leg (TSLA's for the NVDA leg) settles at 0%, unscored,
// after waiting out the price grace period (so the clock jumps past it); and a "fade" of the
// stock legs whose stake went into Jupiter Lend is refused on-chain (each stock leg of a fade
// needs a Phoenix short the trade opened).
//
// With SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set and the fork relay running, the settler reads
// its open positions from chain_positions (the Stream's table) only, with no program scan at all,
// so the database path is what settles everything. Without them it scans, as before.
// Needs the asset bank and moves the fork's clock a year ahead, so it refuses to start without
// `--move-clock` (the shared fork is public): run it only with the fork maintainer's OK, then restart the fork.
import BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TAKE_LIFETIME_SECS,
  AUTHOR_POSITION_ID,
  FADE_VIA,
  LEG_KIND,
  RISK,
  THESIS_COMPUTE_UNITS,
  backIx,
  badgeMintAddress,
  claimHash,
  composeTransactions,
  createTakeIx,
  fadeIx,
  fetchConfig,
  positionAddress,
  profileAddress,
  takeAddress,
  thesisProgram,
  usdcToBaseUnits,
  BADGE_KIND_INDEX,
  BADGE_META,
  badgeMetadataUri,
} from "@thesis/chain";
import { JupiterPrices, MemoryAuditLog, Settler, SupabaseOpenPositions, bankIndex, chainTime, type Sources } from "@thesis/executor/settler";
import { loadBankState, underlyingId } from "@thesis/venues/bank";
import { jupiterLendDeposit } from "@thesis/venues/jupiter";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { PATHS, addSol, addUsdc, connection, deployedElf, loadKeypair, main, requireClockMoveFlag, requireSurfpool, rpc, thesisLookupTable } from "./lib.ts";
import { buyBasket, sendTrade, type BasketLeg } from "./trade.ts";

const BASKET: BasketLeg[] = [
  { key: "equity:US:NVDA", weightBps: 6_000, kind: "spot" },
  { key: "etf:US:SPY", weightBps: 4_000, kind: "spot" },
];

// Every take runs a year unless its author sells (the config allows a day either side, which
// covers the minute or two the trades take before create_take lands).
const HORIZON_SECS = TAKE_LIFETIME_SECS;
/** Made-up moves from entry to the horizon: 60% × +100% + 40% × +10% = +64%. */
const MOVES: Record<string, number> = { NVDA: 2, SPY: 1.1 };

async function e2e(): Promise<void> {
  requireClockMoveFlag("fork:settler-e2e");
  await requireSurfpool();
  if (!(await deployedElf())) throw new Error("Thesis isn't deployed on the fork. Run `pnpm fork:up`.");
  const conn = connection();
  const program = thesisProgram(conn);
  const settlerKey = loadKeypair(PATHS.settler);
  await addSol(settlerKey.publicKey, 2);
  const lookupTable = thesisLookupTable();
  if (!lookupTable) throw new Error("No Thesis lookup table on this fork. Rerun `pnpm fork:up`.");
  const state = await loadBankState();
  const bank = bankIndex(state);
  const apiKey = envVar("JUPITER_API_KEY");
  if (!apiKey) throw new Error("JUPITER_API_KEY is not set (environment or repo-root .env): the settler prices tokens on api.jup.ag");

  const [author, backer, cheater, fader, faker] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const kp of [author, backer, cheater, fader, faker]) {
    await addSol(kp.publicKey, 1);
    await addUsdc(kp.publicKey, 100);
  }

  const start = await chainTime(conn);
  const horizonEnd = start + HORIZON_SECS;
  const id = BigInt(Date.now());
  const take = takeAddress(author.publicKey, id);
  const leg = (key: string, weightBps: number) => ({
    kind: LEG_KIND.spot,
    asset: new PublicKey(underlyingId(key)),
    weightBps,
    leverage: 1,
    fadeVia: FADE_VIA.phoenixShort,
  });
  const usd = (n: string) => new BN(usdcToBaseUnits(n).toString());
  const trade = async (name: string, who: Keypair, stake: string, receipt: Parameters<typeof sendTrade>[4], cu: number, position: PublicKey, buyAs?: Record<number, string>) => {
    const buys = await buyBasket(state, BASKET, who.publicKey, who.publicKey, usdcToBaseUnits(stake), apiKey, { buyAs });
    await sendTrade(name, who, who, buys, receipt, cu, lookupTable, position);
  };
  const create = await createTakeIx(program, {
    author: author.publicKey,
    id,
    claimHash: claimHash("AI chips beat the market this year (settler e2e)"),
    risk: RISK.medium,
    horizonEnd: new BN(horizonEnd),
    legs: [leg("equity:US:NVDA", 6_000), leg("etf:US:SPY", 4_000)],
    stake: usd("10"),
    legsMask: 0b11,
  });
  await trade("create_take", author, "10", create, THESIS_COMPUTE_UNITS.createTake, positionAddress(take, author.publicKey, AUTHOR_POSITION_ID));
  const back = await backIx(program, { owner: backer.publicKey, take, id: 1n, stake: usd("25"), legsMask: 0b11 });
  await trade("back", backer, "25", back, THESIS_COMPUTE_UNITS.back, positionAddress(take, backer.publicKey, 1n));

  // Proof of trade. A receipt with no trade behind it: refused on-chain.
  const fakeBack = await backIx(program, { owner: faker.publicKey, take, id: 1n, stake: usd("25"), legsMask: 0b11 });
  const noTrade = await composeTransactions({
    payer: faker.publicKey,
    legs: [],
    receipt: fakeBack,
    receiptCu: THESIS_COMPUTE_UNITS.back,
    lookupTables: [lookupTable],
    connection: conn,
    proof: { program, owner: faker.publicKey, position: positionAddress(take, faker.publicKey, 1n) },
  });
  noTrade[0].tx.sign([faker]);
  const refused = await conn.sendTransaction(noTrade[0].tx).then(() => "", (e: unknown) => String(e instanceof Error ? e.message : e));
  console.log(`receipt with no trade: ${refused ? "refused" : "ACCEPTED"}`);
  // A back that buys TSLA's token for the NVDA leg: the program can't tell, the settler can.
  const wrong = await backIx(program, { owner: cheater.publicKey, take, id: 1n, stake: usd("20"), legsMask: 0b11 });
  await trade("back (wrong asset)", cheater, "20", wrong, THESIS_COMPUTE_UNITS.back, positionAddress(take, cheater.publicKey, 1n), { 0: "equity:US:TSLA" });
  // A "fade" of the stock legs whose stake went into Jupiter Lend instead of a Phoenix short:
  // refused on-chain, since each stock leg of a fade needs a short the trade opened (security
  // review L-3).
  const fade = await fadeIx(program, { owner: fader.publicKey, take, id: 1n, stake: usd("20"), legsMask: 0b11 });
  const parked = await jupiterLendDeposit({ user: fader.publicKey, payer: fader.publicKey, amount: usdcToBaseUnits("20"), label: "jlUSDC (not a short)", apiKey: apiKey! });
  const fadeRefused = await sendTrade("fade (no short)", fader, fader, [parked], fade, THESIS_COMPUTE_UNITS.fade, lookupTable, positionAddress(take, fader.publicKey, 1n)).then(
    () => "",
    (e: unknown) => String(e instanceof Error ? e.message : e),
  );
  console.log(`fade of stock legs: ${fadeRefused ? "refused" : "ACCEPTED"}`);
  console.log(`take ${take.toBase58()}, horizon in ${horizonEnd - (await chainTime(conn))}s`);

  // Made-up market for the tokens bought: each token's real price when first asked (entry), and
  // that times the stock's made-up move after the horizon. Stocks have no trades: tokens only.
  const real = new JupiterPrices(apiKey);
  const entryPrice = new Map<string, number>();
  const phase = async () => ((await chainTime(conn)) >= horizonEnd ? 1 : 0);
  const sources: Sources = {
    stocks: {
      async firstTradeAtOrAfter() {
        return null;
      },
      async latestTrade() {
        return null;
      },
    },
    tokens: {
      async price(mint) {
        const t = bank.token(mint);
        const u = t && [...Object.values(state.underlyings)].find((x) => x.idHex === t.underlyingIdHex);
        if (!t?.underlyingPerUiToken || !u || !MOVES[u.code]) return null;
        if (!entryPrice.has(mint)) {
          const p = await real.price(mint);
          if (!p) return null;
          // Whole cents per share, so the made-up moves give exact on-chain prices and returns.
          entryPrice.set(mint, Math.round((p.usdPrice / t.underlyingPerUiToken) * 100) / 100);
        }
        const perShare = entryPrice.get(mint)! * ((await phase()) ? MOVES[u.code] : 1);
        const usdPrice = perShare * t.underlyingPerUiToken;
        return { mint, usdPrice, liquidityUsd: 1e9, at: await chainTime(conn), raw: { fake: u.code, mint, move: MOVES[u.code] } };
      },
    },
  };
  const audit = new MemoryAuditLog();
  const [dbUrl, dbKey] = [envVar("SUPABASE_URL"), envVar("SUPABASE_PUBLISHABLE_KEY")];
  const open = dbUrl && dbKey ? new SupabaseOpenPositions({ url: dbUrl, key: dbKey, network: "solana-mainnet-fork" }) : null;
  const ours = [author, backer, cheater].map((k) => positionAddress(take, k.publicKey, k === author ? AUTHOR_POSITION_ID : 1n).toBase58());
  if (open) {
    // The relay delivers each transaction to the webhook; wait until all three positions are in.
    console.log(`
open positions from ${open.name}, no program scan`);
    for (let i = 0; ; i++) {
      const rows = new Set((await open.open()).map((r) => r.position));
      if (ours.every((p) => rows.has(p))) break;
      if (i >= 60) throw new Error("chain_positions never listed this run's positions: is the fork relay running with THESIS_WEBHOOK_URL?");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const settler = new Settler({
    program,
    connection: conn,
    settler: settlerKey,
    bank,
    sources,
    rules: { minLiquidityUsd: 100_000, liveWindowSecs: 300 },
    audit,
    log: (m) => console.log(`  ${m}`),
    openPositions: open,
    initialScan: !open,
    fullScanEverySecs: open ? 1e9 : undefined,
  });
  const scans: boolean[] = [];

  console.log("\ntick 1 (before the horizon)");
  // Surfpool only travels forward: setting up the trades can take longer than 5 s.
  await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (Math.max(start + 5, await chainTime(conn)) + 1) * 1000 }]);
  scans.push((await settler.tick()).fullScan);

  console.log("\ntick 2 (after the horizon)");
  await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (horizonEnd + 120) * 1000 }]);
  scans.push((await settler.tick()).fullScan);

  // Positions with legs that never get a price settle at 0%, unscored, once the grace period is over.
  const grace = (await fetchConfig(program)).params.maxPriceDelaySecs.toNumber();
  console.log(`\ntick 3 (past the ${grace}s price grace period)`);
  await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (horizonEnd + grace + 120) * 1000 }]);
  scans.push((await settler.tick()).fullScan);

  // Checks.
  const t = await program.account.take.fetch(take);
  const positions = [
    positionAddress(take, author.publicKey, AUTHOR_POSITION_ID),
    positionAddress(take, backer.publicKey, 1n),
    positionAddress(take, cheater.publicKey, 1n),
  ];
  const left = await conn.getMultipleAccountsInfo(positions);
  const mine = new Set(positions.map(String));
  const profile = async (k: Keypair) => program.account.profile.fetch(profileAddress(k.publicKey));
  const [a, b, c] = [await profile(author), await profile(backer), await profile(cheater)];
  const unscored = (p: typeof c) => p.positionsSettled === 1 && p.scoredPositions === 0 && p.scoredPnl.toNumber() === 0;
  const badges = await conn.getMultipleAccountsInfo([
    badgeMintAddress(author.publicKey, BADGE_KIND_INDEX.firstTake),
    badgeMintAddress(author.publicKey, BADGE_KIND_INDEX.firstOver50),
  ]);
  // The badge's metadata: its URI is under the config's base (Supabase Storage after fork:up), and
  // wallets can fetch it there.
  const base = (await fetchConfig(program)).badgeUriBase;
  const minted = await getTokenMetadata(conn, badgeMintAddress(author.publicKey, BADGE_KIND_INDEX.firstOver50), "confirmed", TOKEN_2022_PROGRAM_ID);
  const uri = badgeMetadataUri(base, "firstOver50");
  const served = base.includes("placeholder") ? null : await fetch(uri).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const checks: [string, boolean][] = [
    ["take settled at +64%", "settled" in t.status && t.resultBps.toNumber() === 6_400],
    ["all three positions closed", left.every((x) => x === null)],
    ["author: +64% on 10 USDC", a.scoredPnl.toNumber() === 6_400_000 && a.takesOver50 === 1],
    ["backer: +64% on 25 USDC", b.scoredPnl.toNumber() === 16_000_000 && b.wins === 1],
    [`proof of trade: a receipt with no trade is refused on-chain (${refused.match(/StakeNotSpent/) ? "StakeNotSpent" : refused.slice(0, 60)})`, /StakeNotSpent/.test(refused)],
    ["proof of trade: the wrong-asset back settled at 0%, unscored", unscored(c)],
    ["a fade of stock legs with no Phoenix short is refused on-chain (OutputNotBought)", /OutputNotBought|InvalidOutputAccount/.test(fadeRefused)],
    ["badges: first take and +50%", badges.every((x) => x !== null)],
    [`badge metadata: on-chain URI ${uri}`, minted?.uri === uri],
    ...(served !== null || !base.includes("placeholder")
      ? [["badge metadata: served with its name and image", served?.name === BADGE_META.firstOver50.name && typeof served?.image === "string"] as [string, boolean]]
      : []),
    // The crank also prices other e2e runs' positions on a shared fork: count only these.
    // Author and backer: entry + exit. The wrong-asset back: its SPY leg only, entry + exit.
    ["one audit document per price record (3 entry + 3 exit)", audit.entries.filter((e) => mine.has((e.doc as { position: string }).position)).length === 6],
    ...(open ? [["open set: every tick read chain_positions, none scanned the program", scans.every((s) => !s)] as [string, boolean]] : []),
  ];
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("settler e2e failed");

}

if (import.meta.main) await main(e2e);
