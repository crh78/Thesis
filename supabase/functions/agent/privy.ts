// Privy's server API for the agent: who a user is, their embedded Solana wallet, whether our
// session signer is on it, and signing a transaction with that signer.
//
// A session signer is an authorization key (PRIVY_AUTHORIZATION_KEY, "wallet-auth:<base64 PKCS8>")
// that the user added to their wallet on the limits screen. Every request it authorizes carries
// `privy-authorization-signature`: ECDSA P-256 / SHA-256 over the canonical JSON (RFC 8785) of
// { version: 1, method, url, body, headers: { "privy-app-id" } }, base64 DER.
// https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation

import { createPrivateKey, sign as nodeSign } from "node:crypto";

const API = "https://api.privy.io";

/** RFC 8785 canonical JSON: object keys sorted by UTF-16 code units, no whitespace. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
}

/** The authorization key as a PEM private key (accepts it with or without the "wallet-auth:" prefix). */
export function authorizationPem(key: string): string {
  const b64 = key.trim().replace(/^wallet-auth:/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error("PRIVY_AUTHORIZATION_KEY is not base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

/** `privy-authorization-signature` for one request. */
export function authorizationSignature(key: string, appId: string, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body: unknown): string {
  const payload = canonicalize({ version: 1, method, url, body, headers: { "privy-app-id": appId } });
  const pk = createPrivateKey({ key: authorizationPem(key), format: "pem" });
  return nodeSign("sha256", new TextEncoder().encode(payload), pk).toString("base64");
}

export type PrivyConfig = { appId: string; appSecret: string; authorizationKey: string | null; signerId: string | null };

type LinkedAccount = {
  type?: string; address?: string; chain_type?: string; wallet_client_type?: string; connector_type?: string;
  id?: string | null; username?: string; subject?: string;
};
export type PrivyUser = { id: string; linked_accounts?: LinkedAccount[] };
export type PrivyWallet = { id: string; address: string; chain_type: string; additional_signers?: { signer_id: string; override_policy_ids?: string[] }[] };

/** The user's Privy embedded Solana wallet (the one the apps use): its address and wallet id. */
export function embeddedSolana(user: PrivyUser): { address: string; walletId: string | null } | null {
  const w = (user.linked_accounts ?? []).find((a) =>
    a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy" && typeof a.address === "string"
  );
  return w ? { address: w.address!, walletId: typeof w.id === "string" && w.id ? w.id : null } : null;
}

/** The X account a user linked: its numeric id and username, lowercased. */
export function linkedX(user: PrivyUser): { id: string; username: string } | null {
  const x = (user.linked_accounts ?? []).find((a) => a.type === "twitter_oauth");
  const username = x?.username?.toLowerCase() ?? "";
  if (!x?.subject || !/^[0-9]{1,25}$/.test(x.subject) || !/^[a-z0-9_]{1,15}$/.test(username)) return null;
  return { id: x.subject, username };
}

/** Whether our session signer is on the wallet. */
export const hasSigner = (w: PrivyWallet, signerId: string) => (w.additional_signers ?? []).some((s) => s.signer_id === signerId);

export class PrivyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function privyClient(cfg: PrivyConfig, f: typeof fetch = fetch) {
  const basic = `Basic ${btoa(`${cfg.appId}:${cfg.appSecret}`)}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, signed = false): Promise<T> {
    const url = `${API}${path}`;
    const headers: Record<string, string> = { "privy-app-id": cfg.appId, authorization: basic };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (signed) {
      if (!cfg.authorizationKey) throw new PrivyError(500, "PRIVY_AUTHORIZATION_KEY is not set");
      headers["privy-authorization-signature"] = authorizationSignature(cfg.authorizationKey, cfg.appId, "POST", url, body);
    }
    const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new PrivyError(res.status, `privy ${method} ${path.replace(/\/[^/]{20,}/g, "/…")} ${res.status}: ${text.slice(0, 160)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    user: (did: string) => call<PrivyUser>("GET", `/v1/users/${encodeURIComponent(did)}`),
    /** The Privy user who linked this X username, or null (none; 404 / 400). Throws when Privy didn't answer. */
    async userByXUsername(username: string): Promise<PrivyUser | null> {
      try {
        return await call<PrivyUser>("POST", "/v1/users/twitter/username", { username });
      } catch (e) {
        if (e instanceof PrivyError && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }
    },
    /** Whether a Thesis (Privy) user has this X account linked: true, false, or null when Privy didn't answer. */
    async hasXAccount(subject: string): Promise<boolean | null> {
      try {
        await call<PrivyUser>("POST", "/v1/users/twitter/subject", { subject });
        return true;
      } catch (e) {
        if (e instanceof PrivyError && (e.status === 404 || e.status === 400)) return false;
        return null;
      }
    },
    wallet: (walletId: string) => call<PrivyWallet>("GET", `/v1/wallets/${encodeURIComponent(walletId)}`),
    /** The wallet id for an address, when the user's linked account doesn't carry one. */
    async walletIdFor(did: string, address: string): Promise<string | null> {
      const r = await call<{ data?: PrivyWallet[] }>("GET", `/v1/wallets?chain_type=solana&user_id=${encodeURIComponent(did)}`);
      return r.data?.find((w) => w.address === address)?.id ?? null;
    },
    /** Signs one serialized transaction (base64) with our session signer; returns it signed (base64). */
    async signTransaction(walletId: string, transaction: string): Promise<string> {
      const body = { method: "signTransaction", params: { transaction, encoding: "base64" } };
      const r = await call<{ data?: { signed_transaction?: string } }>("POST", `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body, true);
      const signed = r.data?.signed_transaction;
      if (!signed) throw new PrivyError(502, "privy signTransaction returned no transaction");
      return signed;
    },
  };
}

export type Privy = ReturnType<typeof privyClient>;
