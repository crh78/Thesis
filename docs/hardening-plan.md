# Hardening (done)

Every item here is built and on the fork. This file stays as the reference for how each piece works; code comments point at its section numbers. Open items live in [`roadmap.md`](roadmap.md) and [`security-review.md`](security-review.md) (M-3).

## Working on the program

- Test on LiteSVM (`cargo test` in `anchor/`) and on the one shared fork ([`infra/executor`](../infra/executor/README.md), "Running it"). A PR that touches the program, client, settler or fork API reruns `pnpm fork:api-e2e`, `pnpm fork:jupiter-e2e` and `pnpm fork:exit-e2e -- --settle` there. `fork:settler-e2e` moves the fork's clock: only with the fork maintainer's OK, then reset the fork. A program change reaches the fork only through a fresh-fork reset ([`cards-reset.md`](cards-reset.md)).
- After an interface change: `anchor build`, then copy `anchor/target/idl/thesis.json` and `anchor/target/types/*.ts` to `packages/chain/idl/`, and the IDL to `supabase/functions/_shared/thesis-idl.json`. Regenerate the Stream fixtures (`node packages/chain/test/stream-fixtures.ts`), add new instructions to the table in `infra/quicknode/thesis-filter.js`, and keep `THESIS_COMPUTE_UNITS` in step with `test_compute.rs`.

## 1. Proof of trade

A receipt (`create_take`, `back`, `fade`) must show its stake was really traded. `begin_trade` opens a bracket and saves balances in a short-lived trade ticket (`[ticket, owner, position]`, 641 bytes, refunded by the receipt); `trade_step` closes and opens brackets in the middle transactions of a split trade; the receipt closes the last one. `test_trade.rs` has a failing test for every attack below.

| Attack | Stopped by |
|---|---|
| 1. A receipt with no swaps | The owner's USDC must drop by at least the stake (minus any escrowed share), exactly, inside the brackets. No ticket, no receipt. |
| 2. USDC spent somewhere else | Every instruction inside a bracket must be on the config's `trade_programs` (at most 8, changed only by the allowlist admin). Token, Token-2022, System and Thesis can never be added. Associated Token may only `Create` / `CreateIdempotent` (H-2). |
| 3. Swap output sent to another wallet | Each bought leg names an output account: the owner's, not USDC, one leg only, and it must grow inside the brackets. Phoenix legs name the owner's Phoenix trader account, whose position must grow. |
| 4. A different asset than the leg's | The settler prices a spot leg only on a delivered token of the leg's underlying (no stock fallback); otherwise it settles at 0%, unscored. |
| 5. Trades split across transactions | Each transaction is its own bracket and measures only itself. |
| 6. USDC moved out between transactions | Same as 5: transfers between brackets never count. |
| 7. Tokens moved in from elsewhere | Only growth inside the brackets counts, emitted as `TradeProved`; the settler values legs on that. |
| 8. A self-made pool at an absurd price | The settler's value check: a leg's tokens at entry must be worth at least 90% of its part of the stake (`SETTLER_MIN_RECEIVED_RATIO`). |
| Instruction-order tricks | A bracket closes in its own transaction with no other Thesis instruction inside; bracket instructions refuse CPI; the Instructions sysvar is checked by address. |
| Stale or foreign tickets | The receipt checks the ticket's owner, position, payer and USDC account; `begin_trade` restarts a stale ticket only for the same payer; `cancel_trade` refunds an abandoned one. |

Sales (`exit_position`, `sell_part`) need no proof: the score locks at the sale price either way. The Blink (closed) dropped its lightest leg when a 3-leg build didn't fit 1,232 bytes.

Measured on the fork: `begin_trade` ~15–18k CU, `trade_step` ~7.5k, `back` ~37–43k (plus ~2.7k per event since `emit_cpi!`). The settler budgets price records for 10-leg takes (10,200 / 14,800 / 14,800 CU for entry / exit / sale).

## 2. Fuzzing, review, events, verifiable build

- **Property tests** (`proptest`, 256 cases in `cargo test`; `PROPTEST_CASES=50000 cargo test --lib --release` to go deeper) in `utils.rs`, `instructions/prices.rs` and `proof.rs`: the fee split, returns (never below −100%, leverage multiplies, fades mirror backs, a sale scores like an exit), `check_prices`, and the Instructions sysvar parser on arbitrary bytes.
- **Security review:** [`security-review.md`](security-review.md).
- **Events are self-CPI** (`emit_cpi!`), so the validator's 10 KB log limit can't cut them off a big multi-leg trade. Readers (`thesisTransactionEvents` in `@thesis/chain`, the QuickNode filter, the webhook) still parse log events for older transactions.
- **Verifiable build:** `solana-verify` in CI on every push to `main` and on demand (`.github/workflows/verifiable-build.yml`); commands in the root README.

## 3. Creator fees

Claim per take and Claim all, on the creator's own profile only, hidden until something's earned. The fork API's `GET /wallets/:address/creator-fees` answers only to the wallet's own signature (`x-thesis-wallet-auth`); unclaimed is read from the take account, claimed from `creatorFeesClaimed` events. `POST …/creator-fees/claim` packs as many claims per transaction as fit, the app paying. `pnpm fork:creator-fees-e2e` checks it.

## 4. Scores from the chain

`migrations/0027_chain_scores.sql`: `chain_positions` (one row per on-chain position, kept from `chain_events`) and `chain_wallet_stats(network, since)`, by the program's `Profile` rules. Two scores (own P&L, made for backers) plus a faders board, each by dollars or percent (`*_two_scores.sql`, `*_fader_board.sql`). With the `x-thesis-network` header, `leaderboard()` and `person_json()` use chain numbers, and only profiles with on-chain activity are on the board. Only settled, scored positions count (sales and settled partial sales included, `*_partial_sales.sql`); periods go by settlement time. `pnpm fork:scores-check` compares the backend with the `Profile` accounts.

## 5. Badge metadata

Badges point at `{badge_uri_base}{slug}.json`; `badge_uri_base` is a config field the fee admin sets with `update_config`. Images and metadata live in the public `badges` bucket ([`infra/badges`](../infra/badges/README.md)). On mainnet, set the base before the first badge mint.

## 6. Post only after the chain confirms

Takes have `status` `posting` / `live` (`migrations/0026_post_after_chain.sql`). A fork-mode take stays visible only to its author until a `takeCreated` with the same author wallet, claim hash and `horizonEnd` makes it live (one posting take per author and claim). After a publish lands, the fork API delivers it to the webhook itself. The apps show "Posting…", then "Didn't post" with Retry or Discard after about 2 minutes; pg_cron deletes posting takes older than 24 hours.

## 7. Settler at scale and hosting

The settler reads open positions from `chain_positions`, with a full scan on start and every 10 minutes (`apps/executor/src/settler/open-set.ts`). Everything runs on the Oracle VM ([`infra/executor`](../infra/executor/README.md)).

## 8. CI

iOS `build-for-testing` on PRs touching `apps/ios/**` (UI tests stay local); Supabase SQL tests on PRs touching `supabase/**`. The apps' fee rate comes from the program (`GET /config`).
