// deno test --allow-read supabase/functions/quicknode-stream
//
// The fixture is the webhook body for infra/quicknode/fixtures/block.json; expected.json holds
// what packages/chain's decodeThesisStream + thesisEventToJson produce for it (written by
// packages/chain/test/stream.test.ts), so the edge function and the TypeScript client agree.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeStream, PROGRAM_ID, verifySignature } from "./decode.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("decodes the fixture the same way as @thesis/chain", async () => {
  const body = await read("infra/quicknode/fixtures/webhook-payload.example.json");
  const expected = JSON.parse(await read("infra/quicknode/fixtures/webhook-events.expected.json"));
  const out = decodeStream(body);
  assertEquals([...out.keys()], ["solana-mainnet"]);
  assertEquals(out.get("solana-mainnet"), expected);
});

Deno.test("refuses another program's payload", () => {
  let threw = false;
  try {
    decodeStream({ programId: "11111111111111111111111111111111", network: null, transactions: [] });
  } catch {
    threw = true;
  }
  assert(threw);
  assert(PROGRAM_ID.length > 30);
});

async function sign(token: string, nonce: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce + ts + body)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("checks QuickNode's signature and its age", async () => {
  const now = 1_800_000_000;
  const ts = String(now);
  const good = new Headers({ "x-qn-nonce": "n1", "x-qn-timestamp": ts, "x-qn-signature": await sign("secret", "n1", ts, "{}") });
  assert(await verifySignature(good, "{}", "secret", now));
  assert(!(await verifySignature(good, "{ }", "secret", now)), "body changed");
  assert(!(await verifySignature(good, "{}", "other", now)), "wrong token");
  assert(!(await verifySignature(good, "{}", "secret", now + 301)), "too old");
  assert(!(await verifySignature(new Headers(), "{}", "secret", now)), "unsigned");
});
