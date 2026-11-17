// QuickNode Streams filter for Thesis program activity.
//
// Paste this whole file into the Stream Filter Editor (JavaScript). It runs in QuickNode's
// sandbox: no imports, no network, entry point `main(stream)`, return `null` to deliver nothing.
// https://www.quicknode.com/docs/streams/filters
//
// Works with both Solana datasets:
//   - "Block" (`block`): `stream.data` is an array of `getBlock` results.
//   - "Programs with Logs" (`programs_with_logs`): `stream.data` is an array of arrays of
//     per-transaction objects ({ signature, slot, blockTime, programInvocations, logs, success }).
//
// For each successful transaction that invokes Thesis (top-level or through CPI) it returns:
//   { signature, slot, blockTime, instructions: ["create_take", ...], events: [...], logs: [...] }
// `events` are the program's Anchor events, base64 (discriminator ++ borsh). The program emits
// them as self-CPIs (`emit_cpi!`): inner Thesis instructions whose data starts with Anchor's
// event tag, which the validator's 10 KB log limit can't cut. `logs` keeps every "invoke" /
// "success" / "failed" line plus every line Thesis itself wrote: transactions from before
// `emit_cpi!` carry their events there, as "Program data:" lines. Decode with
// `decodeThesisStream` from @thesis/chain (packages/chain/src/stream.ts).

const THESIS_PROGRAM_ID = "HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe";

// Anchor instruction discriminators (first 8 bytes of instruction data), from
// packages/chain/idl/thesis.json. A test checks this table against the IDL.
const THESIS_INSTRUCTIONS = {
  "112,42,45,90,116,181,13,170": "accept_admin",
  "30,226,54,182,255,86,241,48": "accept_allowlist_admin",
  "1,144,109,177,110,131,124,0": "back",
  "5,41,101,236,176,37,195,107": "begin_trade",
  "124,66,91,59,175,107,208,120": "cancel_trade",
  "0,23,125,234,156,118,134,89": "claim_creator_fees",
  "106,212,101,112,158,72,86,215": "create_take",
  "130,193,80,25,78,132,189,111": "exit_position",
  "122,137,112,66,88,205,187,173": "fade",
  "23,235,115,232,168,96,1,231": "init_config",
  "242,234,237,183,232,245,146,1": "mint_badge",
  "87,58,210,161,200,245,149,56": "record_entry_prices",
  "25,176,170,252,64,76,221,148": "record_exit_prices",
  "154,134,75,192,136,117,89,102": "record_sale_prices",
  "33,156,74,218,215,42,112,175": "settle_position",
  "1,236,108,177,89,190,166,102": "settle_take",
  "117,90,208,119,122,90,110,197": "trade_step",
  "138,59,153,23,244,206,40,245": "update_allowlist",
  "29,158,252,191,10,83,219,99": "update_config",
  "198,212,171,109,144,215,174,89": "withdraw_fees",
};

// Anchor's self-CPI event tag (EVENT_IX_TAG_LE): the first 8 bytes of an event's inner instruction.
const EVENT_IX_TAG = "228,69,165,46,81,203,154,29";

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed)/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function main(stream) {
  const data = (stream && stream.data) || [];
  const meta = (stream && stream.metadata) || {};
  const transactions = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item) continue;
    if (Array.isArray(item)) {
      // programs_with_logs: one array of transactions per block.
      for (const tx of item) {
        const match = fromProgramsWithLogs(tx);
        if (match) transactions.push(match);
      }
    } else if (Array.isArray(item.transactions)) {
      // block: a getBlock result.
      const slot = blockSlot(item, i, data.length, meta);
      for (const tx of item.transactions) {
        const match = fromBlockTx(tx, slot, item.blockTime);
        if (match) transactions.push(match);
      }
    }
  }

  if (transactions.length === 0) return null;
  return {
    programId: THESIS_PROGRAM_ID,
    network: meta.network || null,
    batchStart: meta.batch_start_range == null ? null : meta.batch_start_range,
    batchEnd: meta.batch_end_range == null ? null : meta.batch_end_range,
    blocksReorged: meta.blocks_reorged || null,
    transactions,
  };
}

// --- "Block" dataset ---------------------------------------------------------------------

function fromBlockTx(tx, slot, blockTime) {
  if (!tx || !tx.meta || tx.meta.err) return null; // drop failed transactions
  const logs = tx.meta.logMessages || [];
  const message = (tx.transaction && tx.transaction.message) || {};
  const keys = accountKeys(message, tx.meta);

  const names = [];
  const events = [];
  for (const ix of message.instructions || []) addName(names, events, ix, keys);
  for (const group of tx.meta.innerInstructions || []) {
    for (const ix of group.instructions || []) addName(names, events, ix, keys);
  }

  if (names.length === 0 && events.length === 0 && !invokesThesis(logs)) return null;
  return result(tx.transaction.signatures[0], slot, blockTime, names, events, logs);
}

// Account keys as base58 strings, in the order instructions index them: static keys, then
// address-table writable, then readonly. Handles "json" (strings) and "jsonParsed" ({ pubkey }).
function accountKeys(message, txMeta) {
  const keys = (message.accountKeys || []).map((k) => (typeof k === "string" ? k : k && k.pubkey));
  const loaded = txMeta.loadedAddresses;
  if (loaded && !(message.accountKeys || []).some((k) => k && k.source === "lookupTable")) {
    for (const k of loaded.writable || []) keys.push(k);
    for (const k of loaded.readonly || []) keys.push(k);
  }
  return keys;
}

function programIdOf(ix, keys) {
  if (typeof ix.programId === "string") return ix.programId;
  if (typeof ix.programIdIndex === "number") return keys[ix.programIdIndex];
  return null;
}

// A Thesis instruction: its name, or, for a self-CPI event, the event (base64).
function addName(names, events, ix, keys) {
  if (!ix || programIdOf(ix, keys) !== THESIS_PROGRAM_ID) return;
  addThesis(names, events, ix.data);
}

function addThesis(names, events, data) {
  const event = eventData(data);
  if (event) events.push(event);
  else names.push(instructionName(data));
}

// --- "Programs with Logs" dataset --------------------------------------------------------

function fromProgramsWithLogs(tx) {
  if (!tx || tx.success === false || tx.err) return null; // drop failed transactions
  const logs = tx.logs || [];
  const names = [];
  const events = [];
  for (const inv of tx.programInvocations || []) {
    if (inv && inv.programId === THESIS_PROGRAM_ID) {
      addThesis(names, events, inv.instruction && inv.instruction.data);
    }
  }
  if (names.length === 0 && events.length === 0 && !invokesThesis(logs)) return null;
  return result(tx.signature, tx.slot, tx.blockTime, names, events, logs);
}

// --- Shared -------------------------------------------------------------------------------

function result(signature, slot, blockTime, names, events, logs) {
  const out = {
    signature,
    slot: slot == null ? null : slot,
    blockTime: blockTime == null ? null : blockTime,
    instructions: names,
    events,
    logs: thesisLogs(logs),
  };
  if (logs.some((l) => l === "Log truncated")) out.logsTruncated = true;
  return out;
}

function invokesThesis(logs) {
  const prefix = "Program " + THESIS_PROGRAM_ID + " invoke [";
  return logs.some((l) => l.startsWith(prefix));
}

// Keeps what the Anchor event parser needs and drops other programs' chatter (swaps, token
// transfers, compute-unit lines): every invoke/exit line, and every line written while Thesis
// is the running program.
function thesisLogs(logs) {
  const stack = [];
  const kept = [];
  for (const line of logs) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      kept.push(line);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit) {
      kept.push(line);
      stack.pop();
      continue;
    }
    if (stack[stack.length - 1] === THESIS_PROGRAM_ID) kept.push(line);
  }
  return kept;
}

// Slot of a "Block" dataset entry. getBlock results carry no slot field, so fall back to the
// batch range when it lines up one-to-one with the delivered blocks.
function blockSlot(block, index, count, meta) {
  if (typeof block.slot === "number") return block.slot;
  const start = meta.batch_start_range;
  const end = meta.batch_end_range;
  if (typeof start === "number" && typeof end === "number" && end - start + 1 === count) {
    return start + index;
  }
  return null;
}

// A self-CPI event's discriminator ++ borsh as base64, or null if `data` (base58) isn't one.
function eventData(data) {
  if (typeof data !== "string") return null;
  const bytes = base58Decode(data);
  if (!bytes || bytes.length <= 8 || bytes.slice(0, 8).join(",") !== EVENT_IX_TAG) return null;
  return base64(bytes.slice(8));
}

function instructionName(data) {
  if (typeof data !== "string") return "unknown";
  const head = base58Prefix(data, 8);
  if (!head) return "unknown";
  return THESIS_INSTRUCTIONS[head.join(",")] || "unknown";
}

// First `n` bytes of a base58 string, or null if it isn't valid base58.
function base58Prefix(str, n) {
  const bytes = base58Decode(str);
  return bytes && bytes.length >= n ? bytes.slice(0, n) : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

// All bytes of a base58 string, or null if it isn't valid base58.
function base58Decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  bytes.reverse();
  return bytes;
}
