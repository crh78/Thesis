// Phoenix trader accounts, read without the SDK: the same bytes the Thesis program checks in
// proof of trade (anchor/programs/thesis/src/proof.rs), plus what the fork API and the settler
// need. Checked against Phoenix's SDK (`@ellipsis-labs/rise`, accounts/Trader/codec.ts) and live
// accounts on the fork.
import { PublicKey } from "@solana/web3.js";

export const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
/** Ember: USDC to Phoenix's dollar token (PhUSD) and back. */
export const EMBER_PROGRAM_ID = new PublicKey("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");
/** Where Phoenix keeps every market's mark price, funding and open interest. */
export const PERP_ASSET_MAP = new PublicKey("2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC");

/**
 * Accounts every Phoenix leg's instructions name, whoever trades (found by building the same legs
 * for two wallets on the fork): the programs passed as accounts, Phoenix's log
 * authority, global config, vault, trader index, active-trader buffer, PerpAssetMap and withdraw
 * queue, and Ember's state and vault and the PhUSD mint. The fork puts them in the Thesis lookup
 * table so a Phoenix leg fits next to the proof-of-trade instructions.
 */
export const PHOENIX_LOOKUP_ADDRESSES: PublicKey[] = [
  "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih",
  "GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS",
  "2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ",
  "csZXgw2G58hbiWc9ndxaxrQVYVvqdXgQzYLuznEzHJu",
  "HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK",
  "2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok",
  "2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC",
  "3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K",
  "EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy",
  "6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz",
  "FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq",
  "PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A",
].map((k) => new PublicKey(k));

/** `sha256("account:trader")[..8]`. */
export const TRADER_DISCRIMINATOR = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);
const AUTHORITY = 56;
const COLLATERAL = 88;
const PDA_INDEX = 154;
const SUBACCOUNT_INDEX = 155;
const ENTRIES = 224;
const ENTRY_LEN = 40;
/** Asset indexes at or above this are spot collateral, not perps. */
const PERP_ASSET_INDEX_BOUND = 0xff00_0000n;

/** Subaccount 0 is the parent (onboarded once); Thesis gives each perp leg its own child, 1–100. */
export const PARENT_SUBACCOUNT = 0;
export const FIRST_CHILD = 1;
export const LAST_CHILD = 100;

export type PerpPosition = {
  /** Phoenix's asset id (the market's `assetId`). */
  assetId: number;
  /** Signed: positive is long, negative short. */
  baseLots: bigint;
  /** The position's quote side in quote lots (micro-dollars): about −entry notional for a long. */
  virtualQuoteLots: bigint;
};

export type TraderView = {
  authority: PublicKey;
  /** Collateral in quote lots (micro-dollars, PhUSD base units). Realized PnL and fees land here. */
  collateral: bigint;
  pdaIndex: number;
  subaccountIndex: number;
  positions: PerpPosition[];
};

/** A trader account's fields, or null when the bytes aren't one. */
export function decodeTrader(data: Uint8Array): TraderView | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < ENTRIES + 16 || !b.subarray(0, 8).equals(TRADER_DISCRIMINATOR)) return null;
  const len = Number(b.readBigUInt64LE(ENTRIES));
  const fit = Math.floor((b.length - ENTRIES - 16) / ENTRY_LEN);
  const positions: PerpPosition[] = [];
  for (let i = 0; i < Math.min(len, fit); i++) {
    const at = ENTRIES + 16 + i * ENTRY_LEN;
    const asset = b.readBigUInt64LE(at) & 0xffff_ffffn;
    if (asset >= PERP_ASSET_INDEX_BOUND) continue;
    const baseLots = b.readBigInt64LE(at + 8);
    if (baseLots === 0n) continue;
    positions.push({ assetId: Number(asset), baseLots, virtualQuoteLots: b.readBigInt64LE(at + 16) });
  }
  return {
    authority: new PublicKey(b.subarray(AUTHORITY, AUTHORITY + 32)),
    collateral: b.readBigInt64LE(COLLATERAL),
    pdaIndex: b[PDA_INDEX],
    subaccountIndex: b[SUBACCOUNT_INDEX],
    positions,
  };
}

/** The size the Thesis program counts for proof of trade: absolute base lots of every perp position. */
export function positionSize(t: TraderView): bigint {
  return t.positions.reduce((n, p) => n + (p.baseLots < 0n ? -p.baseLots : p.baseLots), 0n);
}

/** A wallet's trader account: `["trader", authority, pdaIndex, subaccountIndex]` under Phoenix. */
export function traderAddress(owner: PublicKey, subaccount: number, pdaIndex = 0): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("trader"), owner.toBuffer(), Buffer.from([pdaIndex]), Buffer.from([subaccount])], PHOENIX_PROGRAM_ID)[0];
}

/** A Phoenix permission account: `["permission", authority, delegatedKey]`. */
export function permissionAddress(authority: PublicKey, delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("permission"), authority.toBuffer(), delegated.toBuffer()], PHOENIX_PROGRAM_ID)[0];
}

/** Permission layout: discriminator (8), permission authority (32), delegated key (32), ... */
const PERMISSION_AUTHORITY = 8;
const PERMISSION_DELEGATED = 40;

/**
 * Fork only: a copy of Phoenix's onboarding permission that names `onboarder` instead of
 * Phoenix's own key, at the address Phoenix derives for it. Written with a Surfpool cheatcode,
 * it lets the fork register traders the way mainnet does, co-signed by a key the fork holds.
 */
export function forkOnboardingPermission(theirs: Uint8Array, onboarder: PublicKey): { address: PublicKey; data: Buffer } {
  const data = Buffer.from(theirs);
  const authority = new PublicKey(data.subarray(PERMISSION_AUTHORITY, PERMISSION_AUTHORITY + 32));
  onboarder.toBuffer().copy(data, PERMISSION_DELEGATED);
  return { address: permissionAddress(authority, onboarder), data };
}

/** Which key a permission account delegates to. */
export function permissionDelegate(data: Uint8Array): PublicKey {
  return new PublicKey(Buffer.from(data).subarray(PERMISSION_DELEGATED, PERMISSION_DELEGATED + 32));
}
