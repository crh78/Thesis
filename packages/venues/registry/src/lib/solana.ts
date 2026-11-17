// Minimal Solana helpers with no dependencies: base58, PDA derivation, and
// JSON-RPC calls. Small enough to read; avoids pulling web3.js into the repo
// just for a data script.
import { createHash } from "node:crypto";
import { HttpError, fetchJson } from "./http.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// ed25519 point decompression check (RFC 8032 5.1.3), used to reject on-curve PDA candidates.
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);
function mod(a: bigint) {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint) {
  return modPow(a, P - 2n);
}
function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * modPow(v, 3n) * modPow(u * modPow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) {
    // ok
  } else if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
  } else return false;
  if (x === 0n && sign === 1n) return false;
  return true;
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const pid = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(pid);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error("no PDA");
}

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export class Rpc {
  url: string;
  label: string;
  fallbackReason: string | null = null;
  constructor(url: string | null) {
    this.url = url ?? PUBLIC_RPC;
    this.label = url ? "QuickNode (QUICKNODE_RPC_URL)" : "public api.mainnet-beta.solana.com";
  }
  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const url = this.url;
    let r;
    try {
      r = await fetchJson<any>(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch (e) {
      // A configured endpoint that rejects us (401/403): fall back to the public RPC once, and say so.
      if (e instanceof HttpError && (e.status === 401 || e.status === 403) && url !== PUBLIC_RPC) {
        this.fallbackReason = `QUICKNODE_RPC_URL returned HTTP ${e.status}; fell back to the public mainnet-beta RPC`;
        console.warn(`rpc: ${this.fallbackReason}`);
        this.url = PUBLIC_RPC;
        this.label = "public api.mainnet-beta.solana.com (QuickNode rejected the request)";
        return this.call<T>(method, params);
      }
      throw e;
    }
    if (!r.json || r.json.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(r.json?.error ?? r.text.slice(0, 200))}`);
    return r.json.result as T;
  }
  /** Accounts per getMultipleAccounts call. Starts at the Solana maximum (100) and shrinks if the endpoint refuses. */
  maxBatch = 100;
  calls = 0;

  /**
   * getMultipleAccounts in chunks of `maxBatch`. Returns a map from address to the account (or null).
   * QuickNode's free Discover plan allows only 5 accounts per call and answers larger ones with
   * HTTP 413; the batch then shrinks (100, 50, 20, 10, 5, 1) and the chunk is retried.
   */
  async getAccounts(addresses: string[], encoding: "jsonParsed" | "base64"): Promise<Map<string, any | null>> {
    const out = new Map<string, any | null>();
    const uniq = [...new Set(addresses)];
    for (let i = 0; i < uniq.length; ) {
      const chunk = uniq.slice(i, i + this.maxBatch);
      let res: { value: (any | null)[] };
      try {
        this.calls++;
        res = await this.call<{ value: (any | null)[] }>("getMultipleAccounts", [chunk, { encoding }]);
      } catch (e) {
        const smaller = [50, 20, 10, 5, 1].find((n) => n < chunk.length);
        if (e instanceof HttpError && e.status === 413 && smaller) {
          this.maxBatch = smaller;
          continue;
        }
        throw e;
      }
      chunk.forEach((a, j) => out.set(a, res.value[j]));
      i += chunk.length;
    }
    return out;
  }
}
