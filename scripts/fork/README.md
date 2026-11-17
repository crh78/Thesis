# Mainnet-fork dogfood environment

Nothing goes to real users until the whole product has run end to end on a **fork of mainnet with fake money**. This folder gives you that fork:

- [Surfpool](https://surfpool.run) forks mainnet. Every mainnet account (USDC, Jupiter, Phoenix, ...) is fetched on first use, so venues behave like the real ones.
- The Thesis program is deployed at its real `declare_id` address, and `init_config` runs with the launch values (`DEFAULT_CONFIG_PARAMS`) and the real USDC mint.
- Any wallet can be given fake SOL and USDC.
- A relay stands in for the QuickNode Stream, so the backend webhook gets the same payloads as on mainnet.

Everything here relies on `surfnet_*` cheatcodes, so pointing it at a real RPC fails rather than spending anything.

**The team runs one shared fork**, on the Oracle VM `thesis-executor` ([`infra/executor`](../../infra/executor/README.md)): Surfpool, the fork API (`https://<fork-host>`, public), the relay, the settler, the asset-bank poller and the marker, as systemd services (the closed Blink's listener is off: `FORK_BLINK_PORT=`). The apps point at it through `FORK_API_URL`, and the e2e suites run there. Don't start a second fork: two forks would report different state to the same Supabase. The commands below are what those services run.

### Resets

The shared fork will be public once the product opens up. A reset (a fresh fork) wipes every on-chain take, position and fake balance, so:

- **Only the fork's maintainer resets it.** While building, they reset whenever needed (a program change, or after a clock-moving suite). Once it's public, resets are scheduled and announced ahead of time.
- **Nobody else** runs `update.sh --fresh-fork`, `fork:down` / `fork:up` on the VM, or anything that changes the program, without the maintainer's OK.
- **No clock-moving suites without the maintainer's OK.** `fork:settler-e2e` jumps the clock days ahead (`surfnet_timeTravel`), after which swaps fail until the fork is reset; it refuses to start without `-- --move-clock`. Every other suite only adds throwaway wallets and test trades.
- **Clean up the old fork's data after every reset**. Supabase keeps the old fork's rows, so pre-reset takes stay `live` with a Trade button that only gets `409 take_missing`. Once the fresh fork is up, with the maintainer's OK:
  1. **Back up** the rows you're about to delete.
  2. **Delete** takes posted before the reset (with their legs, stats and comments), and the old fork's chain events, positions and notifications.
  3. **Check** the feeds show only takes posted since the reset, and every Trade button works.

  The cards reset did this first ([`docs/cards-reset.md`](../../docs/cards-reset.md)); reuse its backup and queries.

## Quick start

```sh
pnpm install
pnpm fork:up                      # start the fork, deploy, init_config
pnpm fork:fund <your wallet>      # 10 SOL + 1,000 USDC
pnpm fork:relay                   # second terminal: print Stream payloads
pnpm fork:smoke                   # a create_take and a back
pnpm fork:status
pnpm fork:down                    # stop the fork fork:up started
```

The fork listens on `http://127.0.0.1:18899` (websocket 18900), clear of a `solana-test-validator` on 8899.

**Prerequisites:** Node 24 and pnpm; Surfpool 1.7.0 (looked up at `$SURFPOOL_BIN`, `~/.local/bin/surfpool`, then `PATH`); and the built `thesis.so` (`--so <path>`, `$THESIS_SO`, then `anchor/target/deploy/thesis.so` here or in the main checkout). It must match the IDL in `packages/chain/idl/`. You don't need the program keypair, the Solana CLI or a funded wallet.

## Commands

**E2E suites stay out of the public product**: each trades only takes made up for the run (`startForkService({ takes })`, never written to Supabase), from throwaway wallets with no profile, with its own state file. Their trades reach the chain tables but match no app take or profile, so no feed or board shows them. New suites must do the same.

| Command | What it does |
| --- | --- |
| `pnpm fork:up [--so <path>] [--redeploy]` | Starts Surfpool unless something answers on the port, deploys `thesis.so` (skipped if unchanged), creates the fork admin, allowlist-admin and settler keys, runs `init_config`, and sets up the lookup table and Phoenix. Safe to rerun |
| `pnpm fork:fund <wallet> [--usdc N] [--sol N]` | Adds fake SOL (default 10) and USDC (default 1,000) to any wallet; `0` skips one |
| `pnpm fork:status` | RPC, program, upgrade authority, config values, vault balances |
| `pnpm fork:down` | Stops the Surfpool `fork:up` started |
| `pnpm fork:smoke` | One wallet posts a one-leg NVDA take, another backs it, each through Jupiter; prints the events. Needs the asset bank |
| `pnpm fork:relay` | The Stream relay (below) |
| `pnpm fork:api` | The fork API ([below](#fork-api-the-apps-fork-mode)) |
| `pnpm fork:settler [-- --once]` | The real settler against the fork ([`apps/executor`](../../apps/executor/README.md)) |
| `pnpm fork:scores-check <wallet>… \| --all` | Compares the backend's chain scores (`chain_wallet_stats`) with each wallet's `Profile` account. Run after an e2e with the relay delivering |
| `pnpm fork:api-e2e` | The apps' flow over HTTP: deposit, receipt, a $25 back signed as Privy would, a fade through Phoenix shorts, a refused tampered transaction, replay, withdrawal and over-cap deposit |
| `pnpm fork:jupiter-e2e` | A low-risk take (stocks plus a jlUSDC yield leg) posted and backed through real routes, then entry prices. Needs a fork clock at real time |
| `pnpm fork:exit-e2e [-- --settle]` | Sells a whole position in one transaction and checks a second sale is refused; `--settle` runs the settler until it settles |
| `pnpm fork:gemini-e2e` | Prediction legs: escrow on backs and fades, settler prices through the proxy, sales returning the escrow. Needs the bank's Gemini tier and `GEMINI_PROXY_TOKEN` |
| `pnpm fork:phoenix-e2e` | Phoenix through `@thesis/venues/phoenix` only: register, 2x long and short, close, sweep |
| `pnpm fork:phoenix-api-e2e [-- --settle]` | Phoenix legs through the API and program: a back with a 5x perp, its liquidation price and one alert, a fade of shorts, sales, cash-out; `--settle` prices and scores both |
| `node scripts/fork/cards-e2e.ts` | Card legs: a back escrows the card's share, a fade leaves it out, a sale returns the escrow. `CARDS_E2E_CARD` picks the card (one the take builder picked) |
| `pnpm fork:creator-fees-e2e` | Creator fees on backs and a fade, the signed read, claim one and Claim all |
| `pnpm fork:ticket-e2e` | An abandoned split-trade ticket is cancelled by the owner's next trade (security review L-4) |
| `pnpm fork:settler-e2e -- --move-clock` | The settler's whole cycle with a time jump past the horizon, plus proof-of-trade refusals. Moves the clock: see [Resets](#resets) |
| `pnpm fork:blink`, `pnpm fork:blink-size` | Blink tools (closed; [`apps/web`](../../apps/web/README.md)) |

Most suites need the asset bank (`pnpm --filter @thesis/executor asset-bank -- --once --tiers=discovery,prices`) and `JUPITER_API_KEY`.

Settings, all optional:

| Variable | Default | |
| --- | --- | --- |
| `FORK_RPC_PORT` / `FORK_WS_PORT` | `18899` / RPC + 1 | |
| `FORK_HOST` | `127.0.0.1` | `0.0.0.0` lets a phone on the same Wi-Fi reach it |
| `FORK_RPC_URL` / `FORK_WS_URL` | from host and ports | Use a fork elsewhere |
| `FORK_DATASOURCE_RPC_URL` | public mainnet | The mainnet RPC Surfpool forks from. Use a Helius/Alchemy free plan or paid QuickNode URL: public mainnet rate-limits heavy use (`Failed to fetch accounts`). **Not the free QuickNode plan**, which caps `getMultipleAccounts` at 5. Applies when Surfpool starts |
| `SURFPOOL_BIN`, `SURFPOOL_ARGS`, `THESIS_SO` | | Extra flags, e.g. `SURFPOOL_ARGS="--no-studio"` |

`fork:up` also creates a fork-only **app fee payer** (`.data/fork/app-payer.json`) and the **Thesis lookup table** (`.data/fork/thesis-alt.json`; with `JUPITER_API_KEY` it adds Jupiter Lend's accounts, so a sale with a yield leg fits one transaction). Surfpool keeps state in memory (`--no-tui --no-deploy --airdrop-amount 0`, log in `.data/fork/surfpool.log`, Studio on 18488): after `fork:down`, a crash or a reboot the fork starts fresh.

**Swaps on the fork:** Surfpool keeps its first copy of each account, so pools go stale within minutes. Call `refreshMarkets(leg.marketAccounts)` from `lib.ts` before sending; it re-fetches them and brings the clock to real time. Prop AMMs (HumidiFi, SolFi, TesseraV, ...) price from quotes pushed every slot and fail on stale copies, so fork routes use only `FORK_DEXES` (state-based AMMs and books). Mainnet uses every venue.

## How the program is deployed without its keypair

Surfpool's `surfnet_writeProgram` writes the ELF straight into the program's accounts at `HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe`, leaving what a real deploy leaves. `fork:up` checks the bytes, sets the upgrade authority to the fork admin (`surfnet_setProgramAuthority`) and runs `init_config`. The fork admin, allowlist admin and settler are gitignored keypairs in `.data/fork/` that control the program only on this fork: never fund or reuse them on mainnet. Rerunning `fork:up` after `anchor build` redeploys only when the bytes changed. If it says the config exists with a different admin, `fork:down` then `fork:up`.

## Pointing surfaces at the fork

- **Apps** talk to the fork API, not the RPC: iOS through `FORK_API_URL` in `apps/ios/Config/Fork.local.xcconfig` ([`apps/ios/README.md`](../../apps/ios/README.md#fork-mode-dogfooding-on-the-mainnet-fork)), the web app through `FORK_API_URL` on its server.
- **Anything that reads Solana directly** should use `SOLANA_RPC_URL` / `SOLANA_WS_URL` (browser: `NEXT_PUBLIC_SOLANA_RPC_URL`), so one switch moves it. Local Supabase functions run in Docker: use `http://host.docker.internal:18899`. Program ID and USDC mint are the mainnet ones, so there are no fork-specific code paths.
- **Privy:** embedded wallets are ordinary addresses (`fork:fund` works). Sign with the embedded wallet (`signTransaction`, which doesn't send) and send through the fork API or fork RPC. Never broadcast through Privy's server-side `signAndSendTransaction` with a mainnet CAIP-2 ID: it sends to Privy's mainnet RPC.

## Fork API (the apps' fork mode)

`pnpm fork:api` serves what the apps need on `http://127.0.0.1:18901` (`FORK_API_PORT`). Run `pnpm fork:settler` beside it so positions get prices. On the shared fork it's public over HTTPS (Tailscale Funnel), behind [abuse limits](#abuse-limits).

Code is in `api/`: `server.ts` (HTTP), `service.ts` (`ForkService`: receipts, trades, sales, demo mirrors, portfolio), `store.ts` (state file, per-wallet serialization), `valuation.ts` (prices and marks), `routing.ts` (best-issuer quoting), `history.ts` (charts), `wallets.ts`, `digests.ts`, `legs.ts` (app legs → on-chain legs), `guard.ts` (abuse limits). Every back, publish and mirror is composed with proof of trade.

| Route | |
| --- | --- |
| `GET /config` | The program's rules: `feeBps`, `creatorFeeBps`, `feeRate`, `minStakeUsd`, `maxLegs`, horizons, `paused`. The apps' fee and minimum come from here |
| `GET /takes/:id?viewer=<wallet>` | A take's on-chain receipt: backers, faders, money in, status, the author's live return (signed entry prices vs live marks, scaled by each token's multiplier), each leg's entry and current price, tradability, and the viewer's positions |
| `POST /takes/:id/trades` `{ owner, side, usd }` | Builds a back or fade.<br>**Back:** best issuer per stock leg through Jupiter, Jupiter Lend for yield, Phoenix for perps, and the receipt. Prediction and card legs are paper: their share (`escrowUsd`) is escrowed, not traded.<br>**Fade:** the other side of prediction legs (escrowed) and a Phoenix short of each listed leg; other legs, cards included, are left out.<br>Returns unsigned v0 transactions (base64), included and left-out legs with reasons, the fee and the escrow. Minimum $10 |
| `POST /takes/:id/publish` `{ author, usd }` | Posts an app take on-chain with the author's buy-in. Once it lands, the API delivers its transactions to `THESIS_WEBHOOK_URL` itself so the take goes live (`FORK_API_RELAY=0` turns that off). `409 already_on_chain` / `already_live` |
| `POST /takes/:id/confirm` | `{ onChain, take?, relayed }`: whether the publish landed; if so, delivers it again (idempotent). The apps ask before showing "Didn't post" and on launch |
| `GET /wallets/:address/creator-fees` | Earned, claimed and unclaimed per take and in total. Needs `x-thesis-wallet-auth: <unix s>.<base64 signature of "Thesis creator fees <address> <unix s>">`, at most 5 minutes old |
| `POST /wallets/:address/creator-fees/claim` `{ takes? }` | Builds the claims, as many per transaction as fit, app paying. `409 nothing_to_claim` |
| `POST /takes/:id/positions/:address/exit` `{ owner }` | Builds a whole-position sale (see [Selling a position](#selling-a-position)). Returns the transaction, `expectedUsd` and `minimumUsd`. `409 already_exited`, `422 exit_too_large` |
| `POST /submit` `{ buildId, transactions }` | The signed transactions. Each must match what was built byte for byte; the API adds the fee payer's signature, refreshes pools and sends in order. Builds expire after 90 s and can't be sent twice |
| `GET /wallets/:address` | USDC, SOL, holdings, activity, `depositCapUsd` / `depositLeftUsd` |
| `GET /wallets/:address/portfolio` | Open positions (value, cost, score, pending note) and on-chain badges with images |
| `GET /wallets/:address/history?range=1D\|1W\|1M\|ALL` | The portfolio chart (≤120 points; snapshots every 5 minutes and after each trade; deposits don't move the line) |
| `GET /wallets/:addr/phoenix`, `POST /wallets/:addr/phoenix/cash-out` | Phoenix cash and leftover positions; cash-out closes and sweeps them back to USDC |
| `POST /digests` | Sends today's positions digests now (otherwise daily after 9 am New York, or `DIGEST_HOUR_UTC`) through `notify`. Service key only |
| `POST /wallets/:address/deposits` `{ usd }` | Fake USDC in, at most $1,000 per wallet ever (`403 deposit_cap`; `FORK_DEPOSIT_CAP_USD`, 0 for none) |
| `POST /wallets/:address/withdrawals` | Off: `403 withdrawals_off` |

### Abuse limits

[`api/guard.ts`](api/guard.ts) sits in front of the routes. Limits are in memory and reset on restart. E2E suites run their own API without the guard.

**Money routes** (trades, publish, exit, deposits, Phoenix cash-out, creator-fee claims) must prove they act for the wallet:
- **A user:** `Authorization: Bearer <Privy access token>`. The token must be valid for the Thesis Privy app, and its user's embedded Solana wallet (lowest index, cached 10 minutes) must be the wallet acted for; else `401 unauthorized` or `403 wrong_wallet`.
- **A server (the X agent):** `x-thesis-service-key: <secret>`, which may act for any wallet, so the caller checks consent and limits itself. Keys live in `FORK_API_SERVICE_KEYS` as `name=secret,…` (≥16 characters each). Ask the fork's maintainer for one; never commit it.

`POST /submit` needs nothing more: it only sends what was built and checks the owner's signature. `FORK_API_AUTH` is `report` (default: log and serve), `enforce` (needs `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`, `PRIVY_APP_SECRET`, the same as the Supabase `session` function) or `off`.

| What | Limit | Over it |
| --- | --- | --- |
| Money actions per wallet | 10 a minute, 100 a day | `429 rate_limited` with `Retry-After`, in every auth mode (unverified callers count per IP and wallet) |
| Reads per IP (GETs and `/confirm`) | 120 a minute | `FORK_API_READ_LIMIT=enforce`: `429`; `report` (default) logs. Service keys aren't counted |
| `POST /digests` | service key only | `401 service_key_required` |
| Builds that call Jupiter | 2 at once, 6 waiting | `503 busy` with `Retry-After` (the shared Jupiter key would otherwise hang) |

**The caller's IP:** Funnel appends what it saw to `X-Forwarded-For`, so only the last entry is used. The web app's Vercel proxy sends `x-thesis-proxy-key: <FORK_API_PROXY_KEY>` and `x-thesis-client-ip`, and only with that key is the visitor's IP used. Keep `FORK_API_READ_LIMIT=report` until the production web deploy is out and `FORK_API_PROXY_KEY` is set in Vercel and on the VM.

### How it behaves

- **Latency:** Jupiter's free key (10 requests per 10 s) is shared by this API, the settler and the bank. A back costs a quote and a swap-instructions call per leg; the winning issuer is cached 2 minutes. On a 429 the API waits for `x-ratelimit-reset`.
- **Signing:** build → the wallet signs each transaction without sending → submit. Users never need SOL. A trade build can end with a short transaction cancelling the owner's abandoned tickets; sign it too (it's sent after the trade lands).
- **Prediction legs:** `asset_id` `gemini:<instrumentSymbol>` maps to that contract on the pick's side. Tradable while open, resolving at least an hour out, two-sided on the side held. Live reads through the `gemini` proxy (`api/gemini-live.ts`, once per event per 30 s): a trade leaves the leg out without one; receipts and marks fall back to the bank's sweep. A sale returns the escrow.
- **Card legs:** a pick naming one Collector Crypt card trades as a Card-kind leg (escrowed, nothing bought, never faded), marked at the insured value the bank last read.
- **Takes:** read through `take_for_chain` (including posting takes), cached 15 s. Trades refuse a posting take (`409 take_posting`). A demo take (seeded authors have no wallets) is mirrored on-chain on its first trade with a fork-only author and a $10 buy-in (a past date gets a fresh 30-day horizon). A real user's take that isn't on this fork (reset since) reads `missing` and trades get `409 take_missing`: its author must post a new take.
- **Legs left out**, with the reason: prediction legs that fail the rules above; perps and shorts on names Phoenix doesn't list (a fade with nothing to short or escrow: `409 fade_unavailable`), or all Phoenix legs with `FORK_PHOENIX=0`; old card picks naming a category; names with no tokenized version liquid enough to price ($50k pool, under 1% impact). The author's buy-in records only the legs it bought (`legs_mask`), so left-out legs never hold up settlement.

## Stream relay → webhook

On mainnet a QuickNode Stream runs `infra/quicknode/thesis-filter.js` and POSTs to the webhook ([`infra/quicknode`](../../infra/quicknode/README.md)). On the fork, [`infra/quicknode/fork-relay.ts`](../../infra/quicknode/fork-relay.ts) subscribes to Thesis logs, fetches each transaction, runs **the real filter** in a sandbox, and POSTs to `THESIS_WEBHOOK_URL` (or prints).

To feed Supabase, set `THESIS_WEBHOOK_URL` to the `quicknode-stream` function and `THESIS_WEBHOOK_TOKEN` to its `QUICKNODE_STREAM_TOKEN` (environment or repo-root `.env`):

```sh
THESIS_WEBHOOK_URL=http://127.0.0.1:54321/functions/v1/quicknode-stream \
  THESIS_WEBHOOK_TOKEN=<QUICKNODE_STREAM_TOKEN> \
  THESIS_WEBHOOK_AUTH="Bearer <anon key>" pnpm fork:relay     # local Supabase function
```

- Requests are signed like QuickNode's (`X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`), so the webhook's check runs on the fork too. `THESIS_WEBHOOK_AUTH` is sent as `Authorization`.
- `network` is `"solana-mainnet-fork"`, so fork rows stay apart from real ones.
- Each delivery holds one transaction, and there's no backfill: anything that happens while the relay is down isn't delivered. Failed deliveries retry 3 times, then are skipped.
- `FORK_RELAY_RECORD=<file>` records raw notifications (how the relay's test fixture was made).

## Phoenix perps

Design: [`docs/phoenix-plan.md`](../../docs/phoenix-plan.md).

- **Registration:** `fork:up` writes a fork-only copy of Phoenix's onboarding permission naming `.data/fork/phoenix-onboarder.json`. The API registers the parent trader account and each leg's child before building, so the user signs only the trade; the app pays rent (~0.028 SOL per wallet, 0.0021 per child, reused).
- **Allowlist and lookup table:** `fork:up` adds Phoenix and Ember to the allowlist and Phoenix's fixed accounts to the lookup table, so a perp leg fits one transaction.
- **Prices:** before each send the API re-copies each market's book, makers and the PerpAssetMap from mainnet; Phoenix refuses orders on a stale mark.
- **Selling:** a sale closes each Phoenix position and returns `phoenixCashOut: true`; the app then calls `POST /wallets/:addr/phoenix/cash-out` until `done`.
- **Liquidation warnings:** receipts list each Phoenix leg's entry, mark, liquidation price, distance and level (`ok`, `near` within 25%, `close` within 10%). Every `LIQUIDATION_CHECK_SEC` (300) the API sends new `near` / `close` levels to `notify` (`NOTIFY_URL`, `NOTIFY_TOKEN`). The fork has no liquidators.
- **Leverage** comes from the take builder's pick (`Stock · 3x`); a perp pick without one is left out. `FORK_PHOENIX=0` turns Phoenix off.

## Selling a position

**Sell position** on a fork receipt sells a whole back or fade: spot legs swap back to USDC, yield legs redeem their jlUSDC, Phoenix positions close (then cash-out), and prediction and card legs get their escrow back. The sheet shows expected proceeds and the minimum after slippage. The transaction carries `exit_position`, so each position sells once, before its horizon. The settler signs prices at or after the sale and the position settles right away; an author's own sale scores for them, but the take's headline runs to the horizon.

Quantities come from the position's opening transaction. Spot swaps and redeems must fit one transaction (`422 exit_too_large`); Phoenix closes may take more. Sold positions stay on the receipt. No partial sales.

## The Blink (closed)

The Blink isn't pursued; the code stays, unmaintained. To run it anyway: `pnpm --filter @thesis/web build`, then `FORK_BLINK_PORT=18902 pnpm fork:api`, and `pnpm fork:blink http://127.0.0.1:18902/api/actions/back/<take-id>` acts as the wallet. Details: [`apps/web/README.md`](../../apps/web/README.md).

## Troubleshooting

- After `fork:settler-e2e`, swaps fail until the fork restarts (`sudo bash ~/thesis/infra/executor/update.sh --fresh-fork` on the VM, with the maintainer's OK; tell the team).
- `0xffff` or `0x1771` inside a Jupiter route: a venue priced from off-chain quotes. Keep fork routes on `FORK_DEXES`; drop a listed venue that keeps failing.
- `bigint: Failed to load bindings`: harmless.
- `No Surfpool fork at ...`: run `pnpm fork:up`, or set `FORK_RPC_URL`.
- `Something that isn't Surfpool is listening on ...`: change `FORK_RPC_PORT`.
- Surfpool exits at start: read `.data/fork/surfpool.log`; another Surfpool may hold Studio's port 18488 (`SURFPOOL_ARGS="--no-studio"`).
- IDL or account mismatch: the `.so` and `packages/chain/idl/thesis.json` come from different builds. Rebuild and rerun `pnpm fork:up`.
