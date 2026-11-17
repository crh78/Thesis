# @thesis/chain

TypeScript client for the Thesis Anchor program (`anchor/`). Every surface (web app, iMessage agent, executor, Blink routes) builds Thesis instructions and reads Thesis accounts through this package.

- `idl/`: the program's IDL and generated types. Never edit by hand: run `anchor build` in `anchor/`, then copy `anchor/target/idl/thesis.json` and `anchor/target/types/*.ts` here. CI fails if they're stale.
- `src/pda.ts`: account addresses (config, fee vault, profile, take, position, a trade's ticket, a sold position's exit, badge mint)
- `src/instructions.ts`: one builder per instruction. Each returns a single instruction to put in a transaction next to the user's own venue instructions (Jupiter, Phoenix, ...). `payer` pays rent and gets position rent back at settlement; pass the app's fee payer for Privy users. A sale is `exitPositionIx` next to the user's swaps back to USDC; the settler then calls `recordSalePricesIx`, and `settlePositionIx` takes the exit's rent payer (`exitRentPayer`) so the exit account closes with the position.
- **Proof of trade:** every `createTakeIx`, `backIx` and `fadeIx` needs a real trade around it.
  - `beginTradeIx` goes first. Its payer pays the trade ticket's rent and must be the receipt's payer, who gets it back.
  - The receipt goes last, with `outputs`: the output token accounts of the legs bought in its transaction, in leg order.
  - A trade split over several transactions uses `tradeStepIx`: `open: false` closes each transaction but the last, and `open: true` opens each one but the first.
  - `tradeOutputs` turns leg → account into the mask and account list these take.
  - `cancelTradeIx` closes the ticket of an abandoned trade.

  `composeTransactions({ proof })` does all of this for you. The rules are in [`docs/hardening-plan.md`](../../docs/hardening-plan.md) §1.
- `src/compose.ts`: `composeTransactions()` packs venue legs (Jupiter swaps, Jupiter Lend deposits, Phoenix deposits and orders) and the Thesis receipt into as few v0 transactions as fit (1,232 bytes).
  - Legs are never split, and the receipt always goes with the last leg, so a basket that fits in one transaction is atomic.
  - With `proof` (owner and position), each transaction is a proof-of-trade bracket: `begin_trade` or `trade_step` right after the compute budget, then the legs, then `trade_step` or the receipt. Each bracket names the output accounts (`ComposeLeg.output`) of the legs in its own transaction.
  - Each transaction's compute limit comes from a simulation, 15% over what it used. In a split trade, only the first transaction can be simulated before it lands, so later ones use the estimate.
- `src/lookup-table.ts`: the Thesis address lookup table (config, vaults, USDC, token programs, the Instructions sysvar). `fork:up` creates one on the fork, adds any Thesis account an older table lacks, and adds Jupiter Lend's jlUSDC accounts (`jupiterLendAccounts` in `@thesis/venues/jupiter`). Mainnet gets one at launch.
- `src/accounts.ts`: `fetchConfig`. Other accounts are read with the Anchor client (`program.account.<name>`), typed by `src/types.ts`
- `src/events.ts`: decodes program events. `thesisTransactionEvents` reads a fetched transaction's self-CPI events (`emit_cpi!`, in its inner instructions), or the log events of a transaction from before that change
- `src/math.ts`: USDC amounts, legs masks, claim hashes, and the fee split (mirrors the program)
- `src/constants.ts`: program ID, seeds, USDC mint, launch config values, the default trade allowlist (`DEFAULT_TRADE_PROGRAMS`: Jupiter, Jupiter Lend Earn, Compute Budget, Associated Token), and `THESIS_COMPUTE_UNITS`

Everything the program does is implemented here; the plan is `docs/onchain-plan.md`.

```sh
pnpm --filter @thesis/chain typecheck
pnpm --filter @thesis/chain test
```
