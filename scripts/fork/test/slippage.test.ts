// Trades refused for slippage at submit (api/send.ts resendOnce, ForkService#stopped): the same
// signed bytes go once more after the markets are reset; a refusal that stands says `requote`
// when nothing went out, and the routes the trade reused are dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, base58 } from "../api/common.ts";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

const confirmed: Status = { err: null, confirmationStatus: "confirmed" };
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** Jupiter's route filled under its minimum out, as Surfpool's preflight reports it (exit-e2e on the VM). */
const slipped = () => Object.assign(new Error("Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1771"), {
  logs: [`Program ${JUPITER} invoke [1]`, "Program log: Instruction: Route", `Program ${JUPITER} failed: custom program error: 0x1771`],
});
const other = () => Object.assign(new Error("Transaction simulation failed"), { logs: ["Program log: Error Code: TicketMissing"] });

for (const until of [undefined, "accepted"] as const) {
  test(`a back refused for slippage goes through on the resend after the markets are reset (until ${until ?? "landed"})`, async (t) => {
    let refusals = 1;
    const f = await tradeFixture(t, {
      status: () => confirmed,
      send: async (tx) => {
        if (refusals-- > 0) throw slipped();
        return base58(tx.signatures[0]);
      },
    });
    const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
    const before = f.refreshed.length;
    const r = await f.service.submit(built.buildId, f.sign(built), until ? { until } : {});
    assert.equal(f.sent.length, 2, "the same signed transaction twice");
    assert.deepEqual(f.sigs()[0], f.sigs()[1]);
    assert.deepEqual(r.signatures, [f.sigs()[0]]);
    if (until) assert.equal((await f.service.submission(built.buildId, 5_000)).status, "landed");
    // The submit's own refresh, then the reset (no freshMs: every account copied again).
    assert.deepEqual(f.refreshed.slice(before).map((x) => x.freshMs), [60_000, undefined]);
    assert.ok(f.logs.some((l) => /refused transaction 1 of 1 for slippage/.test(l)));
  });
}

test("refused for slippage again after the reset: 502 send_failed with requote (nothing left the wallet); another refusal has none", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed, send: async () => Promise.reject(slipped()) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), (e: unknown) =>
    e instanceof ApiError && e.status === 502 && e.code === "send_failed" && e.body?.requote === true);
  assert.equal(f.sent.length, 2, "sent once more, then no more");

  // until accepted answers the same, and the submission says why.
  const a = await tradeFixture(t, { status: () => confirmed, send: async () => Promise.reject(slipped()) });
  const b = await a.service.buildTrade(TAKE_ID, a.wallet, "back", 20);
  await assert.rejects(a.service.submit(b.buildId, a.sign(b), { until: "accepted" }), (e: unknown) => e instanceof ApiError && e.code === "send_failed" && e.body?.requote === true);
  assert.equal((await a.service.submission(b.buildId)).status, "failed");

  const g = await tradeFixture(t, { status: () => confirmed, send: async () => Promise.reject(other()) });
  const c = await g.service.buildTrade(TAKE_ID, g.wallet, "back", 20);
  await assert.rejects(g.service.submit(c.buildId, g.sign(c)), (e: unknown) => e instanceof ApiError && e.code === "send_failed" && e.body?.requote === undefined);
  assert.equal(g.sent.length, 1, "not slippage, and no market left stale: not sent again");
});

/** A Meteora DLMM pool the kept route no longer fits (its bins moved), as the fork's preflight reported it (phoenix-makers-e2e). */
const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const binsMoved = () => Object.assign(new Error("Transaction simulation failed: Error processing Instruction 5: custom program error: 0x1795"), {
  logs: [
    `Program ${JUPITER} invoke [1]`, "Program log: Instruction: Route", `Program ${METEORA} invoke [2]`,
    "Program log: AnchorError occurred. Error Code: CannotFindNonZeroLiquidityBinArrayId. Error Number: 6037. Error Message: Cannot find non-zero liquidity binArrayId.",
    `Program ${METEORA} failed: custom program error: 0x1795`, `Program ${JUPITER} failed: custom program error: 0x1795`,
  ],
});

test("a swap that fails inside its pool (not slippage): requote, and the routes it reused are dropped so the rebuild quotes afresh", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed, send: async () => Promise.reject(binsMoved()) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), (e: unknown) =>
    e instanceof ApiError && e.code === "send_failed" && e.body?.requote === true && /CannotFindNonZeroLiquidityBinArrayId/.test(e.message));
  assert.equal(f.sent.length, 1, "the same bytes aren't sent again: only a fresh quote gets past it");
  // What makes ForkService drop the trade's kept buy routes (dropBuys, covered in scaled-routing.test.ts).
  const { SendFailed, routeRefusal } = await import("../api/send.ts");
  const { refusedError } = await import("../api/common.ts");
  assert.equal(routeRefusal(new SendFailed(refusedError(binsMoved()), [], false, true)), true);
  assert.equal(routeRefusal(new SendFailed(refusedError(other()), [], false, true)), false);
});

test("failedInSwap: only a failure under a top-level Jupiter instruction", async () => {
  const { failedInSwap } = await import("../api/common.ts");
  assert.equal(failedInSwap(binsMoved()), true);
  assert.equal(failedInSwap(slipped()), true);
  assert.equal(failedInSwap(other()), false, "no program failed in the logs");
  const thesis = Object.assign(new Error("x"), { logs: [`Program ${JUPITER} invoke [1]`, `Program ${JUPITER} success`, "Program Thes1s invoke [1]", "Program Thes1s failed: custom program error: 0x1770"] });
  assert.equal(failedInSwap(thesis), false, "the receipt failed after the swap went through");
});
