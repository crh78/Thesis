// Phoenix's mainnet traders on a fork. Phoenix keeps every active trader's positions, collateral
// and order links in one account, the active trader buffer (a tree of 88-byte nodes, keyed by
// trader and asset), and each trader's place in that tree in the global trader index. A fork
// copies the markets, the makers' splines and the PerpAssetMap from mainnet again before each
// Phoenix trade, but it can't copy the buffer: our users' positions live there too. So every fork
// fill moved the makers' entries away from mainnet's, and in a thin market (CoreWeave, where one
// maker holds the whole short side) Phoenix's quantity math panics after a few fork trades, on
// every order and close.
//
// `syncMakers` copies, for every trader that exists on mainnet, each of its buffer entries from
// mainnet's buffer into the fork's: the 64-byte value only (positions, collateral, order links),
// never the tree's keys or pointers. Traders that exist only on the fork (our users' accounts)
// keep theirs. So each fork trade starts from the makers' real inventory, and fills against them
// never add up. An entry mainnet no longer has is set flat (all zero, as mainnet's own flat
// entries are); one mainnet has and the fork doesn't (a trader active on mainnet only since the
// fork started) can't be added and is counted in `missing`.
//
// The layout is the SDK's own (`decodeMultiArenaTree` in @ellipsis-labs/rise): a 96-byte header,
// then nodes of [left u32, right u32, parent u32, color u32, traderId u32, assetId u32, value 64 B].
// Every entry is checked against the SDK's decode before anything is written; any mismatch, or an
// account in more than one arena, and nothing is synced (`MakerSyncError`).
import { decodeActiveTraderBuffer, decodeGlobalTraderIndex } from "@ellipsis-labs/rise";

/** The active trader buffer's header account (Phoenix's API lists no overflow arenas). In PHOENIX_LOOKUP_ADDRESSES. */
export const ACTIVE_TRADER_BUFFER = "2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok";
/** The global trader index's header account. In PHOENIX_LOOKUP_ADDRESSES. */
export const GLOBAL_TRADER_INDEX = "HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK";

const HEADER_BYTES = 96;
const NODE_BYTES = 88;
const ID_AT = 16;
const VALUE_AT = 24;
const VALUE_BYTES = 64;

export class MakerSyncError extends Error {}

export type MakerSync = {
  /** The fork's buffer with every mainnet trader's entries as mainnet has them. */
  data: Buffer;
  /** Entries whose value changed. */
  synced: number;
  /** Entries set flat: mainnet no longer has them. */
  cleared: number;
  /** Mainnet entries of traders the fork knows that the fork's buffer has no node for. */
  missing: number;
  /** Fork-only traders (our users' accounts) left alone. */
  forkOnly: number;
};

type Accounts = { gti: Uint8Array; atb: Uint8Array };

/** Byte offset of node `pointer` in a one-arena buffer. */
const nodeAt = (pointer: number) => HEADER_BYTES + (pointer - 1) * NODE_BYTES;

/** Trader address (base58) by global trader index node, from the SDK's decode. */
function traders(gti: Uint8Array): Map<number, string> {
  const decoded = decodeGlobalTraderIndex([gti]);
  if (decoded.header.numArenas !== 1) throw new MakerSyncError(`global trader index has ${decoded.header.numArenas} arenas`);
  return new Map(decoded.entries.map((e) => [e.nodeIndex, String(e.trader)]));
}

/** Each buffer entry, keyed by trader address and asset id, with its node's byte offset, checked against the raw bytes. */
function entries(acc: Accounts): { byKey: Map<string, number>; traderOf: Map<string, string> } {
  const names = traders(acc.gti);
  const decoded = decodeActiveTraderBuffer([acc.atb]);
  if (decoded.header.numArenas !== 1) throw new MakerSyncError(`active trader buffer has ${decoded.header.numArenas} arenas`);
  const raw = Buffer.from(acc.atb.buffer, acc.atb.byteOffset, acc.atb.byteLength);
  const byKey = new Map<string, number>();
  const traderOf = new Map<string, string>();
  for (const e of decoded.entries) {
    const at = nodeAt(e.nodeIndex);
    if (at + NODE_BYTES > raw.length) throw new MakerSyncError(`node ${e.nodeIndex} is past the account's end`);
    const traderId = e.id.traderId ?? -1;
    if (raw.readUInt32LE(at + ID_AT) !== traderId || raw.readUInt32LE(at + ID_AT + 4) !== Number(e.id.assetId)) {
      throw new MakerSyncError(`node ${e.nodeIndex}'s id isn't where the layout says`);
    }
    if (e.value.kind === "position" && raw.readBigInt64LE(at + VALUE_AT) !== BigInt(e.value.value.position.baseLotPosition)) {
      throw new MakerSyncError(`node ${e.nodeIndex}'s position isn't where the layout says`);
    }
    const trader = names.get(traderId);
    if (!trader) throw new MakerSyncError(`node ${e.nodeIndex} names trader node ${traderId}, which the index doesn't have`);
    const key = `${trader}:${e.id.assetId}`;
    byKey.set(key, at);
    traderOf.set(key, trader);
  }
  return { byKey, traderOf };
}

/**
 * The fork's active trader buffer with every mainnet trader's entries copied from mainnet's (see
 * the header), or null when nothing differs. Throws MakerSyncError when either side's bytes don't
 * match the layout.
 */
export function syncMakers(fork: Accounts, mainnet: Accounts): MakerSync | null {
  const onMainnet = new Set(traders(mainnet.gti).values());
  const main = entries(mainnet);
  const local = entries(fork);
  const mainRaw = Buffer.from(mainnet.atb.buffer, mainnet.atb.byteOffset, mainnet.atb.byteLength);
  const data = Buffer.from(fork.atb);
  const flat = Buffer.alloc(VALUE_BYTES);
  const out: MakerSync = { data, synced: 0, cleared: 0, missing: 0, forkOnly: 0 };
  const forkTraders = new Set(local.traderOf.values());
  for (const [key, at] of local.byKey) {
    if (!onMainnet.has(local.traderOf.get(key)!)) {
      out.forkOnly++;
      continue;
    }
    const from = main.byKey.get(key);
    const value = from === undefined ? flat : mainRaw.subarray(from + VALUE_AT, from + VALUE_AT + VALUE_BYTES);
    const current = data.subarray(at + VALUE_AT, at + VALUE_AT + VALUE_BYTES);
    if (current.equals(value)) continue;
    value.copy(data, at + VALUE_AT);
    if (from === undefined) out.cleared++;
    else out.synced++;
  }
  for (const [key, trader] of main.traderOf) if (forkTraders.has(trader) && !local.byKey.has(key)) out.missing++;
  return out.synced || out.cleared ? out : null;
}
