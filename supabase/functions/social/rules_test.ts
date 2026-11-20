// deno test --allow-env .
import { assertEquals } from "jsr:@std/assert@1";
import { legsFadeable, takeInverted, takeStatus } from "./rules.ts";

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

Deno.test("inverted is a strict boolean, false when left out", () => {
  assertEquals(takeInverted(true), true);
  assertEquals(takeInverted(false), false);
  assertEquals(takeInverted(undefined), false);
  assertEquals(takeInverted(null), false);
  for (const v of ["true", 1, 0, "", {}, []]) assertEquals(takeInverted(v), null);
});

Deno.test("an inverted take needs every leg fadeable", () => {
  assertEquals(legsFadeable([{ fade_how: "Bets it falls" }, { fade_how: "Bets No" }]), true);
  assertEquals(legsFadeable([{ fade_how: "Bets it falls" }, { fade_how: null }]), false);
  assertEquals(legsFadeable([{ fade_how: "" }]), false);
});
