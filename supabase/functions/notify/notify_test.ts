// deno test --config ../quicknode-stream/deno.json supabase/functions/notify
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "./index.ts";

Deno.test("accepts a day of digests", () => {
  const p = parse({ network: "solana-mainnet-fork", day: "2026-12-07", digests: [{ wallet: "W", title: "Up 1.2% today", body: "3 positions" }] });
  assert(p?.kind === "digests");
  assertEquals(p.digests.length, 1);
  assertEquals(p.digests[0].data, {});
});

Deno.test("refuses malformed payloads", () => {
  assert(parse(null) === null);
  assert(parse({ network: "x", day: "today", digests: [] }) === null);
  assert(parse({ network: "x", day: "2026-12-07", digests: [{ wallet: "W" }] }) === null);
  assert(parse({ day: "2026-12-07", digests: [] }) === null);
});

Deno.test("accepts liquidation alerts, one per key, and drops a malformed take id", () => {
  const p = parse({
    network: "solana-mainnet-fork",
    alerts: [
      { wallet: "W", key: "POS:1:near", take_id: "00000000-0000-4000-8000-00000000e001", title: "NVIDIA perp is getting near liquidation", body: "NVDA is $150.00." },
      { wallet: "W", key: "POS:1:close", take_id: "not-a-uuid", title: "NVIDIA perp is close to liquidation" },
    ],
  });
  assert(p?.kind === "alerts");
  assertEquals(p.alerts.map((a) => a.takeId), ["00000000-0000-4000-8000-00000000e001", null]);
  assertEquals(p.alerts[1].body, "");
});

Deno.test("refuses alerts without a key or a title", () => {
  assert(parse({ network: "x", alerts: [{ wallet: "W", title: "t" }] }) === null);
  assert(parse({ network: "x", alerts: [{ wallet: "W", key: "k" }] }) === null);
});
