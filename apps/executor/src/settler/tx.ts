// Packs instructions into as few transactions as fit (1,232 bytes each), with a compute limit
// sized to what's inside instead of the 200k-per-instruction default.
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

export const MAX_TX_BYTES = 1_232;

export type Item = { ix: TransactionInstruction; cu: number; label: string };

const PLACEHOLDER_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

function build(items: Item[], payer: PublicKey, blockhash: string): Transaction {
  const units = items.reduce((n, i) => n + i.cu, 0);
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(units, 1_400_000) }));
  for (const i of items) tx.add(i.ix);
  return tx;
}

function size(items: Item[], payer: PublicKey): number {
  const tx = build(items, payer, PLACEHOLDER_BLOCKHASH);
  const signers = new Set(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map(String));
  return tx.serializeMessage().length + 1 + 64 * signers.size;
}

/** Greedy packing in order. An item that doesn't fit alone still gets its own batch (and will fail loudly). */
export function pack(items: Item[], payer: PublicKey, maxCu = 1_400_000): Item[][] {
  const batches: Item[][] = [];
  let cur: Item[] = [];
  for (const item of items) {
    const next = [...cur, item];
    const cu = next.reduce((n, i) => n + i.cu, 0);
    if (cur.length && (size(next, payer) > MAX_TX_BYTES || cu > maxCu)) {
      batches.push(cur);
      cur = [item];
    } else {
      cur = next;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export type SendResult = { sent: { labels: string[]; signature: string }[]; failed: { label: string; error: string }[] };

/** Sends each batch; a failed batch is retried one instruction at a time so one bad item can't block the rest. */
export async function sendAll(conn: Connection, payer: Keypair, items: Item[]): Promise<SendResult> {
  const out: SendResult = { sent: [], failed: [] };
  const send = async (batch: Item[]) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = build(batch, payer.publicKey, blockhash);
    tx.sign(payer);
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    out.sent.push({ labels: batch.map((i) => i.label), signature });
  };
  for (const batch of pack(items, payer.publicKey)) {
    try {
      await send(batch);
    } catch (e) {
      if (batch.length === 1) {
        out.failed.push({ label: batch[0].label, error: errorText(e) });
        continue;
      }
      for (const item of batch) {
        try {
          await send([item]);
        } catch (e2) {
          out.failed.push({ label: item.label, error: errorText(e2) });
        }
      }
    }
  }
  return out;
}

function errorText(e: unknown): string {
  const logs: string[] | undefined = (e as { logs?: string[] })?.logs;
  const anchor = logs?.find((l) => l.includes("Error Code:"));
  return anchor ?? (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
