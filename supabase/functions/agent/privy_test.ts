import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { generateKeyPairSync, verify } from "node:crypto";
import { authorizationPem, authorizationSignature, canonicalize, embeddedSolana, hasSigner, linkedX, privyClient } from "./privy.ts";

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Uint8Array;
  return { key: `wallet-auth:${btoa(String.fromCharCode(...der))}`, publicKey };
}

Deno.test("canonicalize sorts keys at every level and drops undefined", () => {
  assertEquals(canonicalize({ b: 1, a: { d: [1, "x", null], c: true }, e: undefined }), '{"a":{"c":true,"d":[1,"x",null]},"b":1}');
  assertEquals(canonicalize("é\n"), '"é\\n"');
});

Deno.test("the authorization signature verifies against the key's public half over the canonical payload", () => {
  const { key, publicKey } = keypair();
  const body = { method: "signTransaction", params: { transaction: "AQID", encoding: "base64" } };
  const url = "https://api.privy.io/v1/wallets/w1/rpc";
  const sig = authorizationSignature(key, "app-1", "POST", url, body);
  const payload = canonicalize({ version: 1, method: "POST", url, body, headers: { "privy-app-id": "app-1" } });
  assert(verify("sha256", new TextEncoder().encode(payload), publicKey, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0))));
  // The prefix is optional.
  assert(authorizationPem(key.replace("wallet-auth:", "")).startsWith("-----BEGIN PRIVATE KEY-----\n"));
});

Deno.test("linked accounts: the embedded Solana wallet, the X account, and our signer", () => {
  const user = { id: "did:privy:1", linked_accounts: [
    { type: "wallet", chain_type: "ethereum", wallet_client_type: "privy", address: "0xabc", id: "e1" },
    { type: "wallet", chain_type: "solana", wallet_client_type: "phantom", address: "Ext111" },
    { type: "wallet", chain_type: "solana", wallet_client_type: "privy", address: "Sol111", id: "w-sol" },
    { type: "twitter_oauth", subject: "998877", username: "Jake_Trades" },
  ] };
  assertEquals(embeddedSolana(user), { address: "Sol111", walletId: "w-sol" });
  assertEquals(linkedX(user), { id: "998877", username: "jake_trades" });
  assertEquals(linkedX({ id: "x", linked_accounts: [{ type: "twitter_oauth", subject: "not-a-number", username: "a" }] }), null);
  assertEquals(embeddedSolana({ id: "x" }), null);
  const wallet = { id: "w-sol", address: "Sol111", chain_type: "solana", additional_signers: [{ signer_id: "s1" }] };
  assert(hasSigner(wallet, "s1"));
  assert(!hasSigner(wallet, "s2"));
  assert(!hasSigner({ ...wallet, additional_signers: undefined }, "s1"));
});

Deno.test("signTransaction posts the rpc call with app auth and an authorization signature", async () => {
  const { key } = keypair();
  let seen: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ method: "signTransaction", data: { signed_transaction: "U0lHTkVE", encoding: "base64" } }));
  }) as unknown as typeof fetch;
  const p = privyClient({ appId: "app-1", appSecret: "secret", authorizationKey: key, signerId: "s1" }, f);
  assertEquals(await p.signTransaction("w-sol", "VFg="), "U0lHTkVE");
  const h = seen!.init.headers as Record<string, string>;
  assertEquals(seen!.url, "https://api.privy.io/v1/wallets/w-sol/rpc");
  assertEquals(h["privy-app-id"], "app-1");
  assertEquals(h.authorization, `Basic ${btoa("app-1:secret")}`);
  assert(h["privy-authorization-signature"].length > 60);
  assertEquals(JSON.parse(String(seen!.init.body)), { method: "signTransaction", params: { transaction: "VFg=", encoding: "base64" } });
});

Deno.test("signing without the authorization key fails before calling Privy", async () => {
  const p = privyClient({ appId: "a", appSecret: "s", authorizationKey: null, signerId: null }, (() => { throw new Error("no call"); }) as unknown as typeof fetch);
  await assertRejects(() => p.signTransaction("w", "VFg="), Error, "PRIVY_AUTHORIZATION_KEY");
});
