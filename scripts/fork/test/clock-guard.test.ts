import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_CLOCK_FLAG, requireClockMoveFlag } from "../lib.ts";

test("a clock-moving suite refuses to start without --move-clock", () => {
  assert.throws(() => requireClockMoveFlag("fork:settler-e2e", ["node", "settler-e2e.ts"]), /--move-clock/);
  assert.doesNotThrow(() => requireClockMoveFlag("fork:settler-e2e", ["node", "settler-e2e.ts", MOVE_CLOCK_FLAG]));
});
