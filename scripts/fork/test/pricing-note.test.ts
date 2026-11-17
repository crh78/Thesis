import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingNote, usMarketOpen } from "../api/service.ts";

// 2026-12-03 is a Thursday; New York is UTC-5 in December.
const ny = (hhmm: string, day = "2026-12-03") => new Date(`${day}T${hhmm}:00-05:00`);

test("US market hours: weekdays 9:30 to 16:00 New York time", () => {
  assert.equal(usMarketOpen(ny("09:29")), false);
  assert.equal(usMarketOpen(ny("09:30")), true);
  assert.equal(usMarketOpen(ny("15:59")), true);
  assert.equal(usMarketOpen(ny("16:00")), false);
  assert.equal(usMarketOpen(ny("12:00", "2026-12-05")), false, "Saturday");
});

test("pending entry prices say why they're waiting", () => {
  const legs = [{ name: "T-bills" }];
  const opened = ny("18:40").getTime() / 1000;
  assert.equal(pendingNote(legs, opened, ny("18:41")), "Recording the entry price for T-bills");
  assert.equal(pendingNote(legs, opened, ny("18:45")), "T-bills gets its entry price when the stock market opens");
  assert.equal(pendingNote(legs, ny("10:00").getTime() / 1000, ny("10:05")), "T-bills: waiting for the stock's next trade");
});
