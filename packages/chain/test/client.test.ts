import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/thesis.json" with { type: "json" };
import {
  DEFAULT_CONFIG_PARAMS,
  DEFAULT_TRADE_PROGRAMS,
  FADE_VIA,
  LEG_KIND,
  RISK,
  THESIS_PROGRAM_ID,
  BADGE_KIND_INDEX,
  authorPositionAddress,
  badgeMintAddress,
  badgeMetadataUri,
  BADGE_META,
  supabaseBadgeUriBase,
  backIx,
  beginTradeIx,
  cancelTradeIx,
  claimCreatorFeesIx,
  claimHash,
  createTakeIx,
  fadeIx,
  initConfigIx,
  legsMask,
  mintBadgeIx,
  parseThesisEvents,
  positionAddress,
  recordEntryPricesIx,
  recordExitPricesIx,
  settlePositionIx,
  settleTakeIx,
  splitFee,
  takeAddress,
  thesisProgram,
  escrowVaultAddress,
  eventAuthorityAddress,
  thesisLookupTableAddresses,
  ticketAddress,
  tradeOutputs,
  tradeStepIx,
  updateConfigIx,
  acceptAdminIx,
  updateAllowlistIx,
  acceptAllowlistAdminIx,
  usdcToBaseUnits,
  withdrawFeesIx,
} from "../src/index.ts";

// Never contacted: building instructions is offline.
const program = thesisProgram(new Connection("http://127.0.0.1:8899"));
const author = Keypair.generate().publicKey;
const backer = Keypair.generate().publicKey;
const appPayer = Keypair.generate().publicKey;

const leg = {
  kind: LEG_KIND.spot,
  asset: Keypair.generate().publicKey,
  weightBps: 10_000,
  leverage: 1,
  fadeVia: FADE_VIA.phoenixShort,
};

test("addresses are deterministic and distinct", () => {
  const take = takeAddress(author, 7n);
  assert.ok(take.equals(takeAddress(author, 7)));
  assert.ok(!take.equals(takeAddress(author, 8n)));
  assert.ok(!take.equals(takeAddress(backer, 7n)));
  assert.ok(authorPositionAddress(take, author).equals(positionAddress(take, author, 0n)));
  assert.ok(!positionAddress(take, backer, 1n).equals(positionAddress(take, author, 1n)));
});

test("createTake: author signs, app can pay rent", async () => {
  const ix = await createTakeIx(program, {
    author,
    payer: appPayer,
    id: 1n,
    claimHash: claimHash("AI power demand is underrated"),
    risk: RISK.medium,
    horizonEnd: new BN(1_800_000_000),
    legs: [leg],
    stake: new BN(usdcToBaseUnits("10").toString()),
    legsMask: legsMask([0]),
  });
  assert.ok(ix.programId.equals(THESIS_PROGRAM_ID));
  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
  assert.deepEqual(new Set(signers), new Set([author.toBase58(), appPayer.toBase58()]));
  assert.ok(ix.keys.some((k) => k.pubkey.equals(takeAddress(author, 1n)) && k.isWritable));
});

test("back and fade use the same accounts and different instructions", async () => {
  const take = takeAddress(author, 1n);
  const p = { owner: backer, take, id: 42n, stake: new BN(10_000_000), legsMask: legsMask([0]) };
  const back = await backIx(program, p);
  const fade = await fadeIx(program, p);
  assert.deepEqual(
    back.keys.map((k) => k.pubkey.toBase58()),
    fade.keys.map((k) => k.pubkey.toBase58()),
  );
  assert.notDeepEqual(back.data.subarray(0, 8), fade.data.subarray(0, 8));
  assert.ok(back.keys.some((k) => k.pubkey.equals(positionAddress(take, backer, 42n))));
  // Blink transactions are tight on space: 12 accounts, plus the ticket and the Instructions
  // sysvar for proof of trade, the escrow vault, and the event authority and the program itself
  // for events (`emit_cpi!`). The sysvar, the vault and the event authority are in the Thesis
  // lookup table, and the program is already in the transaction: each costs one byte.
  assert.equal(back.keys.length, 17);
  assert.ok(back.keys[15].pubkey.equals(eventAuthorityAddress()) && back.keys[16].pubkey.equals(THESIS_PROGRAM_ID));
  assert.ok(thesisLookupTableAddresses().some((k) => k.equals(eventAuthorityAddress())));
});

test("proof of trade: tickets sit where the program looks for them", async () => {
  // anchor/programs/thesis/src/proof.rs finds the ticket by its index in each instruction.
  const take = takeAddress(author, 1n);
  const position = positionAddress(take, backer, 42n);
  const ticket = ticketAddress(backer, position);
  const out = Keypair.generate().publicKey;
  const begin = await beginTradeIx(program, { owner: backer, payer: appPayer, position, outputsMask: 0b1, outputs: [out] });
  assert.ok(begin.keys[4].pubkey.equals(ticket));
  assert.ok(begin.keys.at(-1)!.pubkey.equals(out) && !begin.keys.at(-1)!.isWritable);
  const step = await tradeStepIx(program, { owner: backer, position, open: true, outputsMask: 0, outputs: [] });
  assert.ok(step.keys[2].pubkey.equals(ticket));
  assert.equal(step.data[8], 1, "the open flag follows the discriminator");
  const back = await backIx(program, { owner: backer, take, id: 42n, stake: new BN(10_000_000), legsMask: 1, outputs: [out] });
  assert.ok(back.keys[12].pubkey.equals(ticket));
  // The escrow vault follows the Instructions sysvar, then the event accounts; outputs come after.
  assert.ok(back.keys[14].pubkey.equals(escrowVaultAddress()));
  assert.ok(back.keys[17].pubkey.equals(out));
  const create = await createTakeIx(program, {
    author,
    id: 1n,
    claimHash: claimHash("x"),
    risk: RISK.low,
    horizonEnd: new BN(1_800_000_000),
    legs: [leg],
    stake: new BN(10_000_000),
    legsMask: 1,
  });
  assert.ok(create.keys[11].pubkey.equals(ticketAddress(author, authorPositionAddress(take, author))));
  const cancel = await cancelTradeIx(program, { owner: backer, position, rentPayer: appPayer });
  assert.ok(cancel.keys[1].pubkey.equals(ticket));
  // Tickets are per owner and position.
  assert.ok(!ticket.equals(ticketAddress(author, position)));
});

test("init_config names the program's ProgramData, so only the upgrade authority can run it", async () => {
  const ix = await initConfigIx(program, { admin: author, settler: backer, allowlistAdmin: appPayer, params: DEFAULT_CONFIG_PARAMS });
  const [programData] = PublicKey.findProgramAddressSync([THESIS_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")); // ggignore
  // Last before the event authority and the program, which Anchor appends for events.
  const at = ix.keys.findIndex((k) => k.pubkey.equals(programData));
  assert.equal(at, ix.keys.length - 3);
  assert.ok(!ix.keys[at].isWritable);
});

test("tradeOutputs orders accounts by leg", () => {
  const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const { outputsMask, outputs } = tradeOutputs(new Map([[3, b], [0, a]]));
  assert.equal(outputsMask, 0b1001);
  assert.deepEqual(outputs, [a, b]);
});

test("every instruction builds against the IDL", async () => {
  const take = takeAddress(author, 1n);
  const position = positionAddress(take, backer, 42n);
  const ixs = await Promise.all([
    initConfigIx(program, { admin: author, settler: backer, allowlistAdmin: appPayer, params: DEFAULT_CONFIG_PARAMS }),
    updateConfigIx(program, {
      admin: author,
      args: { params: DEFAULT_CONFIG_PARAMS, newAdmin: null, newSettler: null, newBadgeUriBase: null },
    }),
    withdrawFeesIx(program, { admin: author, destination: backer, amount: new BN(1) }),
    claimCreatorFeesIx(program, { author, take }),
    recordEntryPricesIx(program, {
      settler: appPayer,
      take,
      position,
      prices: [{ leg: 0, price: new BN(10_000_000_000), publishedAt: new BN(1_800_000_060) }],
      sourceHash: Array(32).fill(3),
    }),
    recordExitPricesIx(program, {
      settler: appPayer,
      take,
      position,
      prices: [{ leg: 1, price: new BN(0), publishedAt: new BN(1_802_592_060) }],
      sourceHash: Array(32).fill(3),
    }),
    settleTakeIx(program, { take, author }),
    settlePositionIx(program, { take, position, owner: backer, rentPayer: appPayer }),
    mintBadgeIx(program, { payer: appPayer, owner: author, kind: "firstOver50" }),
    acceptAdminIx(program, { newAdmin: backer }),
    updateAllowlistIx(program, { allowlistAdmin: appPayer, tradePrograms: DEFAULT_TRADE_PROGRAMS }),
    acceptAllowlistAdminIx(program, { newAllowlistAdmin: backer }),
  ]);
  for (const ix of ixs) assert.ok(ix.programId.equals(THESIS_PROGRAM_ID));

  const [, , , , entry, exit] = ixs;
  for (const ix of [entry, exit]) {
    assert.ok(ix.keys.some((k) => k.pubkey.equals(appPayer) && k.isSigner), "settler signs");
    assert.ok(ix.keys.some((k) => k.pubkey.equals(position) && k.isWritable));
  }
});

test("fee split at the $10 minimum: 1 cent, half to the creator", () => {
  const params = { feeBps: DEFAULT_CONFIG_PARAMS.feeBps, creatorFeeBps: DEFAULT_CONFIG_PARAMS.creatorFeeBps };
  const stake = usdcToBaseUnits("10");
  assert.deepEqual(splitFee(stake, params, { isAuthor: false }), {
    fee: 10_000n,
    creator: 5_000n,
    platform: 5_000n,
  });
  assert.equal(splitFee(stake, params, { isAuthor: true }).creator, 0n);
});

test("usdc parsing and legs masks", () => {
  assert.equal(usdcToBaseUnits("10.5"), 10_500_000n);
  assert.throws(() => usdcToBaseUnits("1.0000001"));
  assert.equal(legsMask([0, 2]), 0b101);
});

test("events decode from transaction logs", () => {
  const take = Keypair.generate().publicKey;
  const event = idl.events.find((e) => e.name === "TakeSettled")!;
  const body = program.coder.types.encode("takeSettled", { take, author, resultBps: new BN(-250) });
  const data = Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64");
  const logs = [
    `Program ${THESIS_PROGRAM_ID.toBase58()} invoke [1]`,
    `Program data: ${data}`,
    `Program ${THESIS_PROGRAM_ID.toBase58()} success`,
  ];
  const [parsed] = parseThesisEvents(program, logs);
  assert.equal(parsed.name, "takeSettled");
  assert.ok((parsed.data as { take: PublicKey }).take.equals(take));
  assert.equal((parsed.data as { resultBps: BN }).resultBps.toNumber(), -250);
});

test("badge names and slugs mirror the program, and URIs follow the config's base", () => {
  const state = readFileSync(join(import.meta.dirname, "../../../anchor/programs/thesis/src/state.rs"), "utf8");
  for (const [kind, { name, slug }] of Object.entries(BADGE_META)) {
    const variant = kind[0].toUpperCase() + kind.slice(1);
    assert.ok(state.includes(`BadgeKind::${variant} => "${name}"`), `${kind} name`);
    assert.ok(state.includes(`BadgeKind::${variant} => "${slug}"`), `${kind} slug`);
  }
  const base = supabaseBadgeUriBase("https://abc.supabase.co/");
  assert.equal(base, "https://abc.supabase.co/storage/v1/object/public/badges/");
  assert.equal(badgeMetadataUri(base, "firstOver50"), `${base}first-50.json`);
});

test("badge mints are per user and per badge", () => {
  const a = badgeMintAddress(author, BADGE_KIND_INDEX.firstTake);
  assert.ok(a.equals(badgeMintAddress(author, 0)));
  assert.ok(!a.equals(badgeMintAddress(author, BADGE_KIND_INDEX.over1000)));
  assert.ok(!a.equals(badgeMintAddress(backer, BADGE_KIND_INDEX.firstTake)));
  // The order must match the program's BadgeKind enum.
  const programOrder = idl.types.find((t) => t.name === "BadgeKind")!.type as { variants: { name: string }[] };
  assert.deepEqual(
    programOrder.variants.map((v) => v.name),
    ["FirstTake", "FirstOver50", "FirstOver100", "TenOver50", "Over1000"],
  );
});
