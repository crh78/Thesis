# Thesis on-chain plan

The direction for everything on Solana: the Thesis Anchor program, its TypeScript client (`packages/chain`), and the transactions that pair a user's trades with a Thesis receipt. A direction, not a spec.

## The idea

The user's own wallet does the trading (Jupiter swaps, Jupiter Lend, Phoenix). In the same transaction, the Thesis program writes a **receipt**: who backed or faded which take, with how much, and when. The program never holds user money except the escrowed share of paper legs (below). It collects the platform fee, credits creators their share, records settler-signed prices, settles a take when its author sells (or a year after posting), keeps everyone's track record, and mints "called it" badges.

## Principles

- **Non-custodial.** Users sign their own trades. The one exception is paper legs (Gemini predictions and Collector Crypt cards): the program's escrow vault holds their share of the stake and returns all of it at a sale or settlement.
- **Atomic composition.** Venue instructions and the receipt go in one transaction where they fit; split trades are proved per transaction.
- **Immutable takes.** No edit or delete.
- **Verify what we can, say what we can't.** Prices are signed by one settler key for now, each with its source document hashed into the receipt and published in `price_audit`. The program checks only the signer and timing, so Pyth can replace the source later.
- **Store ingredients, not formulas.** The program keeps raw stats (stake, P&L, wins). There's no score formula: the app shows two raw scores from these stats.
- **Everything tunable** in the on-chain config account.
- **Cheap to use.** Temporary accounts close and refund their rent.

## Decisions

| Decision | Value |
|---|---|
| Platform fee | 10 bps (0.10%) of each back or fade, whole stake (paper shares included); capped at 1% in the program |
| Creator share | 5 bps of the fee to the take's author on every back and fade; the platform keeps 5 bps. On the author's own buy-in it goes to the platform. No performance boost |
| Minimum stake | $10. Smaller positions are recorded but don't score |
| Max legs per take | 10 |
| Take length | No timeline to pick: a take runs until its author sells their buy-in, at most 365 days after posting. `horizon_end` is fixed at posting + 365 days (the config's window is 364 to 366 days), and a take its author never sells settles then, as if sold at that day's prices |
| Closing a take | The author's sale of their own buy-in closes the take (`Closed`, event `takeClosed`): no new backs or fades, and its headline result settles from the sale's prices (`settle_take`). Backers and faders who haven't sold keep their positions; each settles when its owner sells, or at the 365-day mark. "Made for backers" counts positions as they settle. The program refuses a fade by the take's own author |
| Author buy-in | At least $10. Like a back, it records only the legs it bought, so a leg with no venue never holds up the take's result |
| Leverage | A perp leg's return × its leverage, each leg's loss capped at −100% |
| Yield legs | Count in the score: priced as one Jupiter Lend vault share's value in USDC (`totalAssets / totalSupply`) |
| Prices | Settler-signed. Token first, at any hour: the issuer token's Jupiter price when it has a $50k pool and a $100 buy moves it under 1%; the stock's Alpaca price only as a fallback. Prices are the first at or after the moment |
| Badges | Author only, each once per user: first take posted, first take at +50%, first at +100%, ten takes at +50%, a take at +1,000% |
| Selling | A sale exits the whole position; `exit_position` records it in the same transaction, while the take is open or closed and before the 365-day mark; the settler signs prices at or after the sale and the position settles right away. No fee. The author's sale also closes the take (above). No partial sales |
| Proof of trade | `begin_trade` / `trade_step` brackets, a program allowlist with its own key, exact USDC drop, output accounts that grow, settler-side asset and 90% value checks ([`hardening-plan.md`](hardening-plan.md) §1) |
| Paper legs | Gemini prediction legs ([`gemini-plan.md`](gemini-plan.md)) and Collector Crypt card legs ([`cards-plan.md`](cards-plan.md)): share escrowed and returned in full, P&L in the score only |
| Fades | Prediction legs (the other side) and Phoenix shorts ([`phoenix-plan.md`](phoenix-plan.md)); card legs and unlisted names are left out |
| Scores | Two raw scores, computed off-chain from events: own P&L, and what an account's takes made for backers. Ranked by dollars or percent, plus a faders board |
| Mainnet gate | A private mainnet program for the judges is allowed (phase 2); real users only after the whole product is dogfooded on the fork (phase 3) |

## Technology

| What | Used for |
|---|---|
| Anchor | The program and its IDL |
| Token-2022 | Non-transferable badges with on-chain metadata |
| Versioned transactions, address lookup tables | Fitting several legs and the receipt into one transaction |
| Instructions sysvar | Proof of trade |
| Jupiter (Swap API, Lend Earn) | Spot legs (xStocks, Ondo and other RWA tokens) and yield legs |
| Phoenix | Perp legs and fade shorts |
| Gemini Prediction Markets, Collector Crypt | Paper legs (market data only) |
| QuickNode Streams | Program events → Supabase webhook → feed, notifications, scores |
| Privy | Embedded wallets; the app pays gas |
| LiteSVM, Surfpool | Local tests and the mainnet fork |
| Verifiable builds | Explorers show the deployed program matches the repo |
| Later | Pyth (price source), CCTP (USDC in), Light Protocol ZK compression (near-zero rent for positions) |

Solana Actions/Blinks were step 9 until the Blink was closed; the code stays in `apps/web`, unmaintained.

## Where we test

- **LiteSVM:** most program logic, offline (`cargo test` in `anchor/`).
- **The shared mainnet fork (Surfpool)** on the Oracle VM ([`infra/executor`](../infra/executor/README.md)): real venues, routes and transaction sizes. Never start a second fork.
- **Mainnet:** phase 2 (a private program for the judges) and phase 3. No devnet: the venues aren't there.

## Roadmap

| Step | State |
|---|---|
| 0. Foundation: toolchain, Anchor workspace, CI (build, tests, fmt, clippy, IDL check) | Done |
| 1. Size check: how many swaps plus a receipt fit in 1,232 bytes | Done (3 legs; bytes bind, not compute) |
| 2. Interface first: accounts, instructions, IDL, `packages/chain` client | Done |
| 3. Core program: config, takes with the author's buy-in, backs and fades, fee split, profiles | Done |
| 4. Prices: settler-signed entry, exit and sale prices with audit hashes (`apps/executor`) | Done |
| 5. Settlement and scoring | Done |
| 6. Badges | Done |
| 7. Live data: events, the QuickNode filter and decoder, the fork relay | Done |
| 8. Asset bank and venues: best-issuer routing, Jupiter, Jupiter Lend, Gemini, Phoenix, Collector Crypt, the composer | Done on the fork |
| 9. The X Blink | Closed |
| 10. Dogfood on the fork | Ongoing: iOS fork mode and the web app run on the shared fork; iMessage trading and the X agent wait on Privy session signers |
| 11. Hardening: proof of trade, security review, property tests, verifiable build, self-CPI events | Done ([`hardening-plan.md`](hardening-plan.md)); M-3 open ([`security-review.md`](security-review.md)) |
| 12. Mainnet launch | Phase 2 (private program), then phase 3 (real users) |

### Mainnet launch checklist

- Deploy the verifiable build; publish the IDL on-chain; create the lookup table; put the program ID in the README and `anchor/Anchor.toml`.
- **Upgrade authority** on a separate safe key (multisig for phase 3), and `init_config` signed by it (H-1). A separate allowlist admin (M-2).
- **Badge metadata:** right after `init_config`, set `badge_uri_base` to the `badges` bucket (`supabaseBadgeUriBase(SUPABASE_URL)` in `@thesis/chain`) with `update_config`, before any badge is minted ([`infra/badges`](../infra/badges/README.md)).
- **Settler key** on a fresh key; in OCI Vault for phase 3 ([`infra/executor`](../infra/executor/README.md), "Settler key in OCI Vault"). Its public key goes in the config's `settler`.
- **QuickNode Stream** on the mainnet program, same filter, with `quicknode-stream` deployed from the program's commit ([`infra/quicknode`](../infra/quicknode/README.md)).
- **Paper legs:** decide how the app labels them before real users.

## Keeping it cheap

Accounts are sized to their basket: on a 3-leg take a position is 190 bytes (~0.0022 SOL) and the take 266 bytes (~0.0027 SOL); the app pays rent for Privy users. `test_compute.rs` prints every instruction's compute and every account's rent, and fails CI past its ceilings.

- **Positions are temporary:** `settle_position` folds the result into the owner's profile, closes the position and refunds the rent to whoever paid it.
- **Trade tickets** (641 bytes) live only while a trade runs; the receipt refunds them, `cancel_trade` refunds abandoned ones.
- **Exit accounts** (111 bytes on a 3-leg take) close with their position.
- **Takes and profiles stay:** they're the permanent record.
- **Later:** Light Protocol compressed positions (needs a compression-aware RPC such as Helius Photon).

## What the on-chain work gives

| Area | What it gives |
|---|---|
| Solana | Anchor, Token-2022 badges, atomic composition with Jupiter, Jupiter Lend and Phoenix, instruction introspection, verifiable build, rent reclaim |
| Consumer app | Gasless for app users, no custody, live receipts |
| Prediction markets | Prediction legs paper-filled at Gemini's live prices, recorded and scored on-chain, faded through the other side |
| Streams | Program events built for a Stream filter, decoded by the Supabase webhook |

## Risks

- Issuer tokens can be thin outside market hours; the settler falls back to the stock through the premium recorded at entry.
- The catalog's tradeable flags re-sync every 15 minutes, so a pick can thin out between syncs (trades check live).
- On the fork, prop AMMs and maker-quoted books reject stale copied quotes, so fork routes use only `FORK_DEXES`; fills there can be slightly worse than on mainnet.
- Phoenix lists 100+ markets, but not every name; the take builder offers only what the asset bank calls tradeable.

The product's to-do list is in the [README's "What's next"](../README.md#whats-next).
