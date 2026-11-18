// deno test --allow-env .
import { assertEquals } from "jsr:@std/assert@1";
import { takeStatus, validHorizon } from "./rules.ts";

Deno.test("horizons: 1 week up to 60 months", () => {
  for (const ok of ["1wk", "2wk", "99wk", "1mo", "3mo", "6mo", "60mo"]) assertEquals(validHorizon(ok), true, ok);
  for (const bad of ["0wk", "0mo", "61mo", "99mo", "100wk", "3m", "mo", "", "3mo ", "-1mo", "1yr"]) assertEquals(validHorizon(bad), false, bad);
});

Deno.test("a take is posting unless the project allows live posts", () => {
  // Fork mode (the default): whatever the client sends.
  for (const awaitChain of [true, false, undefined, null, "true"]) assertEquals(takeStatus(awaitChain, false), "posting");
  // TAKES_LIVE_WITHOUT_CHAIN=on: the client's choice, as before.
  assertEquals(takeStatus(true, true), "posting");
  assertEquals(takeStatus(false, true), "live");
  assertEquals(takeStatus(undefined, true), "live");
});

Deno.test("the setting is off unless it says on", () => {
  // Read once at import; this test runs without TAKES_LIVE_WITHOUT_CHAIN set.
  if (Deno.env.get("TAKES_LIVE_WITHOUT_CHAIN") === undefined) assertEquals(takeStatus(false), "posting");
});
