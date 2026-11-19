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
  2. **Delete** takes posted before the reset (with their legs, stats and comments), and the old fork's chain events, positions (`chain_positions` and their partial sales, `chain_position_parts`) and notifications.
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
| `pnpm fork:exit-e2e [-- --settle]` | Sells a quarter of a position (after a too-large part is refused), then the rest, each in one transaction, and checks a second sale is refused; the holding route; `--settle` runs the settler until the part and the position settle |
| `pnpm fork:gemini-e2e` | Prediction legs: escrow on backs and fades, settler prices through the proxy, sales returning the escrow. Needs the bank's Gemini tier and `GEMINI_PROXY_TOKEN` |
| `pnpm fork:phoenix-e2e` | Phoenix through `@thesis/venues/phoenix` only: register, 2x long and short, close, sweep |
| `pnpm fork:phoenix-api-e2e [-- --settle]` | Phoenix legs through the API and program: a back with a 5x perp, its liquidation price and one alert, a fade of shorts, sales, cash-out; `--settle` prices and scores both |
| `node scripts/fork/cards-e2e.ts` | Card legs: a back escrows the card's share, a fade leaves it out, a sale returns the escrow. `CARDS_E2E_CARD` picks the card (one the take builder picked) |
| `pnpm fork:creator-fees-e2e` | Creator fees on backs and a fade, the signed read, claim one and Claim all |
| `pnpm fork:ticket-e2e` | An abandoned split-trade ticket is cancelled by the owner's next trade (security review L-4) |
| `pnpm fork:latency-bench [-- --runs N --usd N]` | How long a back and a sale take, per step: build, submit, and the server's own steps from `Server-Timing`, as p50 and p90. Throwaway wallets, a take made up for the run, a service key it makes up; never moves the clock. Keep `--runs` small (default 5): each run spends Jupiter calls |
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

**Swaps on the fork:** Surfpool keeps its first copy of each account, so pools go stale within minutes. Call `refreshMarkets(leg.marketAccounts)` from `lib.ts` before sending; it re-fetches them and brings the clock to real time (`{ freshMs }` leaves accounts this process re-fetched that recently). Prop AMMs (HumidiFi, SolFi, TesseraV, ...) price from quotes pushed every slot and fail on stale copies, so fork routes use only `FORK_DEXES` (state-based AMMs and books). Mainnet uses every venue.

## How the program is deployed without its keypair

Surfpool's `surfnet_writeProgram` writes the ELF straight into the program's accounts at `HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe`, leaving what a real deploy leaves. `fork:up` checks the bytes, sets the upgrade authority to the fork admin (`surfnet_setProgramAuthority`) and runs `init_config`. The fork admin, allowlist admin and settler are gitignored keypairs in `.data/fork/` that control the program only on this fork: never fund or reuse them on mainnet. Rerunning `fork:up` after `anchor build` redeploys only when the bytes changed. If it says the config exists with a different admin, `fork:down` then `fork:up`.

## Pointing surfaces at the fork

- **Apps** talk to the fork API, not the RPC: iOS through `FORK_API_URL` in `apps/ios/Config/Fork.local.xcconfig` ([`apps/ios/README.md`](../../apps/ios/README.md#the-fork)), the web app through `FORK_API_URL` on its server.
- **Anything that reads Solana directly** should use `SOLANA_RPC_URL` / `SOLANA_WS_URL` (browser: `NEXT_PUBLIC_SOLANA_RPC_URL`), so one switch moves it. Local Supabase functions run in Docker: use `http://host.docker.internal:18899`. Program ID and USDC mint are the mainnet ones, so there are no fork-specific code paths.
- **Privy:** embedded wallets are ordinary addresses (`fork:fund` works). Sign with the embedded wallet (`signTransaction`, which doesn't send) and send through the fork API or fork RPC. Never broadcast through Privy's server-side `signAndSendTransaction` with a mainnet CAIP-2 ID: it sends to Privy's mainnet RPC.

## Fork API (the apps' fork mode)

`pnpm fork:api` serves what the apps need on `http://127.0.0.1:18901` (`FORK_API_PORT`). Run `pnpm fork:settler` beside it so positions get prices. On the shared fork it's public over HTTPS (Tailscale Funnel), behind [abuse limits](#abuse-limits).

Code is in `api/`: `server.ts` (HTTP), `service.ts` (`ForkService`: receipts, trades, sales, demo mirrors, portfolio), `store.ts` (state file, per-wallet serialization), `valuation.ts` (prices and marks), `routing.ts` (best-issuer quoting), `history.ts` (charts), `wallets.ts`, `digests.ts`, `legs.ts` (app legs → on-chain legs), `guard.ts` (abuse limits), `split.ts` (split trades that stop partway). Every back, publish and mirror is composed with proof of trade.

Keeping load down (every RPC read of an account the fork doesn't have goes to Helius): the state file is written as compact JSON at most every 3 s (a deposit at once) and on shutdown (SIGTERM / SIGINT), never on a read, and a failed write is logged as `STATE NOT SAVED` and retried; the portfolio builds receipts only for takes the wallet holds (an owner index kept from position reads); a take's positions are rescanned every 5 minutes (every 30 s for 5 minutes after a trade on it); creator fees are cached 60 s per wallet (the author's takes are rescanned at most every 10 minutes); route checks run once per underlying at a time. Outside calls time out: Jupiter after 15 s (and at most 20 s of 429 waits per call), Supabase, Gemini and Alpaca after 10 s; Alpaca's latest trades are cached 15 s. Every 10 minutes the API tops the app fee payer and the settler key back up to 10 fake SOL when either drops below 5 (`surfnet_setAccount`, logged); it checks first that the RPC is Surfpool, so it never runs against mainnet.

| Route | |
| --- | --- |
| `GET /config` | The program's rules: `feeBps`, `creatorFeeBps`, `feeRate`, `minStakeUsd`, `maxLegs`, horizons, `takeLifetimeSecs` (365 days), `paused`. The apps' fee and minimum come from here |
| `GET /takes/:id?viewer=<wallet>` | A take's on-chain receipt: backers, faders, money in, status, the author's live return (signed entry prices vs live marks, scaled by each token's multiplier), each leg's entry and current price, tradability, and the viewer's positions |
| `POST /takes/:id/trades` `{ owner, side, usd, prebuild? }` | Builds a back or fade (`prebuild`: see [Building ahead of the tap](#building-ahead-of-the-tap)).<br>**Back:** best issuer per stock leg through Jupiter, Jupiter Lend for yield, Phoenix for perps, and the receipt. Prediction and card legs are paper: their share (`escrowUsd`) is escrowed, not traded.<br>**Fade:** the other side of prediction legs (escrowed) and a Phoenix short of each listed leg; other legs, cards included, are left out.<br>Returns `buildId`, unsigned v0 transactions (base64), included and left-out legs with reasons, the fee and the escrow, `expiresAt` (unix ms, before the blockhash expires) and `quotedAt` (unix ms); `prebuilt: true` when it was served as a prebuild. Minimum $10 |
| `POST /builds/:buildId/refresh` | The same build with a fresh blockhash: the same answer with new `transactions` and `expiresAt`, the same `buildId` and `quotedAt`. No Jupiter call. Until the build's first submit, the transactions answered just before still submit too (signed while the refresh ran); anything else is `400 transaction_changed`. `prebuilt` as built. `409 quote_stale` once its quotes are over 45 s old, `410 build_gone` once it expired or was submitted: build again. Counted as a read |
| `POST /takes/:id/publish` `{ author, usd, prebuild? }` | Posts an app take on-chain with the author's buy-in; `author` must be the take's `author_wallet` (`403 not_author`; `409 no_author_wallet` when it has none yet). Once it lands, the API delivers its transactions to `THESIS_WEBHOOK_URL` itself so the take goes live (`FORK_API_RELAY=0` turns that off). `409 already_on_chain` / `already_live` |
| `POST /takes/:id/confirm` | `{ onChain, take?, relayed }`: whether the publish landed; if so, delivers it again (idempotent). The apps ask before showing "Didn't post" and on launch |
| `GET /wallets/:address/creator-fees` | Earned, claimed and unclaimed per take and in total. Needs `x-thesis-wallet-auth: <unix s>.<base64 signature of "Thesis creator fees <address> <unix s>">`, at most 5 minutes old |
| `POST /wallets/:address/creator-fees/claim` `{ takes? }` | Builds the claims, as many per transaction as fit, app paying. `409 nothing_to_claim` |
| `POST /takes/:id/positions/:address/exit` `{ owner, bps?, usd?, prebuild? }` | Builds a sale of the position, or of part of it (see [Selling a position](#selling-a-position)). Returns the transaction, `expectedUsd`, `minimumUsd`, `expiresAt`, `quotedAt`, `bps`, `full` and `sale`; `prebuild` and refresh work as for trades. `409 already_exited`, `409 insufficient_tokens`, `422 exit_too_large` (one swap too big for a transaction on its own), `422 remainder_below_minimum`, `422 part_too_small`, `409 too_many_open_sales`, `400 invalid_amount`; for a sale that stopped partway, see [Sales over several transactions](#sales-over-several-transactions) |
| `POST /takes/:id/sell` `{ owner, side, bps?, usd?, prebuild? }` | The same for a share of the wallet's whole holding on one side of the take, plus `positions` |
| `POST /submit` `{ buildId, transactions, until?, timings? }` | The signed transactions (the body may be sent as `text/plain`: a CORS simple request, no preflight). Each must match what was built byte for byte; the API adds the fee payer's signature, refreshes pools and sends in order. Builds expire after 55 s (before their blockhash does). By default it answers `{ signatures }` once every transaction confirmed. **`until: "accepted"`**: `202 { status: "pending", buildId, signatures }` as soon as the fork accepted every transaction (see [Accept, then confirm](#accept-then-confirm)). **Repeats:** the same build with the same signed bytes is the same submit and gets its status (nothing is sent twice); other bytes `409 build_used`. `timings`: the client's marks (`{ name: ms from the tap }`), logged with the build id, repeats included. A split trade that stops partway answers `422 trade_incomplete` (see [Split trades](#split-trades)), a sale `422 sale_incomplete` (see [Sales over several transactions](#sales-over-several-transactions)) |
| `GET /submissions/:buildId?wait=<ms ≤ 10000>` | A submit's status: `{ buildId, status: "pending" \| "landed" \| "failed" \| "incomplete", signatures, error?: { code, message }, incomplete? }` (`incomplete`: the `trade_incomplete` view). Waits up to `wait` while pending. Counted as a read; `404 no_such_submission` after 10 minutes |
| `GET /wallets/:address/incomplete` | `{ trades: [...] }`: split trades that stopped partway, newest first (see [Split trades](#split-trades)) |
| `POST /wallets/:address/retry` `{ position? }` | Builds the rest of a split trade once more (a money route). Same shape as a trade build |
| `POST /wallets/:address/sweep` `{ position? }` | Builds the sale of what a stopped split trade bought back to USDC, cancelling its ticket (a money route), or `{ done: true }` |
| `GET /wallets/:address` | USDC, holdings, activity, `depositCapUsd` / `depositLeftUsd` (cached 8 s; a trade or deposit clears it) |
| `GET /wallets/:address/portfolio` | Open positions (value, cost, score, pending note) and on-chain badges with images |
| `GET /wallets/:address/history?range=1D\|1W\|1M\|ALL` | The portfolio chart (≤120 points; deposits don't move the line). Kept only for wallets with a deposit or an open position: snapshots every 5 minutes and after each trade, full resolution for 7 days, hourly before that. Any other wallet gets its value now, and nothing is saved |
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
| Reads (GETs and `/confirm`) per signed-in user, else per IP | 120 a minute | `FORK_API_READ_LIMIT=enforce`: `429`; `report` (default) logs. Service keys aren't counted |
| `POST /digests` | service key only | `401 service_key_required` |
| Jupiter calls (builds, sales, sweeps, route checks) | 30 a minute (`FORK_API_JUPITER_RPM`; bursts set by `FORK_API_JUPITER_BURST`; with a key of its own, `JUPITER_TRADE_API_KEY`, the fork API can take more of Jupiter's 60), bursts of 10; 8 in flight, 24 queued | Lanes: a tap-time build waits up to 8 s for its turn, then `503 busy` with `Retry-After`; route checks fail fast with `503 busy` when fewer than 6 are left; a prebuild short only of those spare requests waits up to 4 s for the bucket to refill, and fails fast after a 429 or behind a waiting tap. Once a prebuild's first call is let in, its other calls (a sale quotes its legs in parallel) go in a tap's turn, so it isn't refused halfway. A 429 in a prebuild or route check answers `503 busy` with `Retry-After`. While calls run or wait, the API touches the asset bank's `trade-builds.busy` every 5 s, so the poller's probes pause |

**Who a read counts against:** a read carrying a valid Privy token (`Authorization: Bearer <token>`, as on money routes) counts against that Privy user, so people sharing an IP don't share a limit. A valid token is trusted for a minute (never past its expiry) without checking its signature again; an invalid one is ignored and the read counts per IP.

**The caller's IP:** Funnel appends what it saw to `X-Forwarded-For`, so only the last entry is used (browsers calling directly are counted this way). The web app's Vercel proxy sends `x-thesis-proxy-key: <FORK_API_PROXY_KEY>` and `x-thesis-client-ip`, and only with that key is the visitor's IP used. Keep `FORK_API_READ_LIMIT=report` until the production web deploy is out and `FORK_API_PROXY_KEY` is set in Vercel and on the VM.

### Direct browser calls

To spare Vercel function invocations, the web app's browser can call the fork API directly (`https://<fork-host>`) instead of going through its `/api/fork` proxy. `FORK_API_CORS_ORIGINS` lists the origins allowed to, comma-separated, each just `scheme://host[:port]` (e.g. `https://yourthesis.xyz,https://www.yourthesis.xyz`; no paths, no `*`). Unset or empty: no CORS headers at all (only the proxy works).

- **Preflight** (`OPTIONS` from an allowed origin, any path): `204` with `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: authorization, content-type, x-thesis-wallet-auth`, `Access-Control-Max-Age: 600`, `Access-Control-Expose-Headers: retry-after, server-timing` and `Vary: Origin`. Preflights don't count as reads. From any other origin, `OPTIONS` is a `404` as before.
- **Every response** to an allowed origin, errors included, carries `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Expose-Headers: retry-after, server-timing` (so a `429` or `503`'s `Retry-After`, and a build's or submit's `Server-Timing`, are readable), `Timing-Allow-Origin: <that origin>` and `Vary: Origin`. Other origins get only `Vary: Origin`.
- **No credentials mode:** no cookies; send the Privy token as `Authorization: Bearer <token>` (it's what makes reads count per user and money routes act for the wallet). Creator fees take `x-thesis-wallet-auth`. Other headers aren't allowed, so the proxy-only `x-thesis-proxy-key` / `x-thesis-client-ip` can't be sent from a browser (and are ignored without the key anyway).
- The JSON shapes and status codes are the same as through the proxy.

### How it behaves

- **Timings:** every build, sale build, publish, refresh and submit logs one `timing …` line with each step's milliseconds (funds, take, mirror, legs, jupiter wait, markets, compose, lock, refresh, send, confirm, bookkeeping, cleanup, relay) and its Jupiter use (lane, calls, quotes, instructions, issuer-winner hits, shared template, 429s), whether it worked or not, and answers with a `Server-Timing` header carrying the same steps and a `total`. `pnpm fork:latency-bench` reads them.
- **Latency:** Jupiter's free key (10 requests per 10 s) is shared by this API, the settler and the bank. A back costs a quote and a swap-instructions call per leg; the winning issuer is cached 2 minutes. On a 429 the API waits for `x-ratelimit-reset`.
- **Signing:** build → the wallet signs each transaction without sending → submit. Users never need SOL. A trade build can end with a short transaction cancelling the owner's abandoned tickets; sign it too (it's sent after the trade lands).
- **Prediction legs:** `asset_id` `gemini:<instrumentSymbol>` maps to that contract on the pick's side. Tradable while open, resolving at least an hour out, two-sided on the side held. Live reads through the `gemini` proxy (`api/gemini-live.ts`, once per event per 30 s): a trade leaves the leg out without one; receipts and marks fall back to the bank's sweep. A sale returns the escrow.
- **Card legs:** a pick naming one Collector Crypt card trades as a Card-kind leg (escrowed, nothing bought, never faded), marked at the insured value the bank last read.
- **Takes:** read through `take_for_chain` (including posting takes), cached 15 s. Trades refuse a posting take (`409 take_posting`). A demo take (seeded authors have no wallets) is mirrored on-chain on its first trade with a fork-only author and a $10 buy-in (it auto-settles 365 days from then, like any take). A real user's take that isn't on this fork (reset since) reads `missing` and trades get `409 take_missing`: its author must post a new take.
- **Legs left out**, with the reason: prediction legs that fail the rules above; perps and shorts on names Phoenix doesn't list (a fade with nothing to short or escrow: `409 fade_unavailable`), or all Phoenix legs with `FORK_PHOENIX=0`; old card picks naming a category; names with no tokenized version liquid enough to price ($50k pool, under 1% impact). The author's buy-in records only the legs it bought (`legs_mask`), so left-out legs never hold up settlement.

### Building ahead of the tap

The apps build when the trade sheet opens and again as the amount changes, refresh a build that's about to expire, and only submit when the user taps.

- **`prebuild: true`** on a trade or publish build marks it as built ahead of the tap. Its Jupiter calls go in routing's prebuild lane (`lane: 2`; tap-time builds are lane 1). With a guard that can check the caller without counting (`checkAuth`, `countMoney` in `api/guard.ts`), a prebuild doesn't count as a money action. It has its own window of 30 a minute per wallet, and the money action counts at its submit (a 429 there leaves the build to submit again).
- **`prebuilt: true`** in a build's answer (and its refreshes) says the API served it as a prebuild. Without that guard support a `prebuild: true` request is served as a normal build: in the tap lane, counted as a money action now, and its answer has no `prebuilt`. The apps prebuild only once a build answered `prebuilt: true`; otherwise they build at the tap, as before.
- **Market accounts are refreshed at quote time** (before the build composes and simulates), skipping accounts this API refreshed in the last 30 s. The submit refreshes them again only past 60 s, except Phoenix's, which are always refreshed right before the send (Phoenix refuses an order on a stale mark). The fork's clock is brought up to wall time every 5 s instead of before each send.
- **Refresh** (`POST /builds/:id/refresh`) gives a build a fresh blockhash while its quotes are under 45 s old, re-copying its markets if they're over 30 s old. Sale builds take `prebuild` and refresh the same way. A client may have signed the transactions answered just before a refresh while it ran: until the build's first submit, those still submit (while their blockhash lasts), as do the refreshed ones. The first submit uses the build; other bytes after it are `409 build_used`, and anything else is `400 transaction_changed`.
- **Stale pools at submit:** when a submit left market accounts copied under a minute ago (not Phoenix's) and the first transaction's preflight is refused (nothing went out), the API resets all the build's market accounts and sends the same signed transactions once more.
- **Phoenix children across rebuilds:** a build of a trade with Phoenix legs reserves its children for 3 minutes, and the owner's next build reuses them (no new registration as the amount changes). At submit the trade claims them, and the owner's other unsubmitted builds using any of them are dropped (submitting one answers `409 build_stale`), so cash-out never takes the submitted trade's legs for strays; if another trade submitted since took one (two builds made at once), it answers `409 build_stale`: build again.

### Accept, then confirm

With `until: "accepted"` a submit sends every transaction back to back, each preflighted at "processed" (it sees the one before it), and answers `202` once the fork accepted all of them. Confirmation (polled from 100 ms, then every 500 ms), and the bookkeeping (opening transactions, sales) run after the answer, in the wallet's queue, so the next submit for that wallet waits for them; the abandoned-ticket cleanup and the publish relay follow once it landed. The app shows the trade as placed and watches `GET /submissions/:buildId`; a rare `failed` means nothing was traded ("didn't go through"), `incomplete` is a split trade that stopped (retry or sweep it).

- A refusal before everything was accepted answers as without `until`: a preflight refusal `502 send_failed`; a split trade whose later transaction is refused confirms the earlier ones first and answers `422 trade_incomplete`.
- A position with a sale submitted and not yet ended can't be sold again (`409 already_exited`, "being sold"). Sale, retry, sweep and Phoenix cash-out builds wait (up to 10 s) for the wallet's submits still confirming, so a sale right after a back sees the back.
- A trade's ticket counts as in use until its confirmation ends, so another build's cleanup never cancels it.
- Submits are kept 10 minutes, in memory and in the state file. After a restart, a submit still pending is answered from its transactions' statuses on-chain (a landed back or publish records its opening transactions then). A graceful stop waits up to 10 s for pending submits to confirm.

### Split trades

A back, fade or publish too big for one transaction is a short sequence the wallet signs at once; each transaction is a proof-of-trade bracket on the position's trade ticket, and the receipt in the last one closes it. If a later transaction fails after an earlier one landed, the wallet holds what the landed part bought, the ticket is still open and no position exists. The owner's decision: **retry once, then sweep.**

1. `POST /submit` answers `422 trade_incomplete`:
   ```json
   { "error": "trade_incomplete", "message": "...", "retry": true, "sweep": true,
     "incomplete": { "position": "<address>", "take": "<address>", "takeId": "<uuid>", "side": "back",
                     "usd": 50, "next": "retry", "landed": 1, "signatures": ["..."], "at": "<ISO time>" } }
   ```
   `retry` is true while the one retry is left (`incomplete.next` is `"retry"`); `sweep` is always true.
2. **Retry** (when `retry` is true): `POST /wallets/:address/retry` `{ position? }` (default: the newest retryable trade) builds the legs that didn't land again with fresh quotes and a fresh blockhash, stepping on the same ticket, with the same receipt last. It answers like a trade build (`{ buildId, transactions, steps, position, take, side, stakeUsd, legs }`); sign and `POST /submit` as usual. If that submit fails too, it answers `422 trade_incomplete` again with `retry: false`. A retry that can't be built answers `409 retry_used`, `409 retry_unavailable` (part of it landed after all, or a leg sits on both sides of the failure, like a Phoenix deposit without its order), `422 retry_unavailable` (a leg can't be bought now) or `409 take_closed`, each with the same `incomplete` body and `retry: false`. Any other error (`429`, `503 busy` when Jupiter couldn't quote, `502`) leaves the retry: wait and try again, or sweep. Building a retry doesn't use it up; sending one does. At submit the API checks again, in the wallet's queue, that the trade still waits for this retry (no other retry or sweep sent, no leg it buys on the ticket), and drops the trade's other open builds; a stale one answers `409 retry_used`, `409 trade_changed` or `410 build_expired`.
3. **Sweep:** `POST /wallets/:address/sweep` `{ position? }` (default: the newest) builds the sale of what the landed transactions bought (the ticket's per-leg `received`, at most what the wallet still holds) back to USDC through Jupiter, redeems Jupiter Lend shares, and cancels the ticket in the last transaction (its rent goes back to the app's fee payer). It answers `{ done: false, buildId, transactions, steps, position, tokens: [{ leg, mint, symbol, amount }], expectedUsd, minimumUsd, phoenixCashOut }`; sign and `POST /submit`. `{ done: true, phoenixCashOut: false }` means nothing is left to sweep: without `position`, the wallet has no stopped trade; with one, that trade was already swept, retried or finished. So call it again (with or without `position`) until it answers `done`: a sweep that landed answers `done` next time, and a wallet with several stopped trades sweeps them one per call. When `phoenixCashOut` is true, Phoenix legs landed: once the sweep lands, run `phoenix/cash-out` to close them and move their cash back. A sweep works whether or not the retry was used, but building one ends the retry (and a sweep that partly landed rules it out). A sweep's submit also checks the trade is still stopped (`409 trade_changed` otherwise).
4. `409 trade_complete` from either: the trade went through after all; `410 incomplete_gone` from a retry: its ticket was cancelled. Either way it's forgotten.
5. While a take's publish is stopped, `POST /takes/:id/publish` answers `409 trade_incomplete` with the same body: a fresh publish would start the ticket over. Retry or sweep it first.

**When a send's fate is unclear** (the RPC errors while sending or confirming), the API polls the transaction's status until it confirms, fails, or its blockhash passes; it never takes "unknown" for "didn't land". A transaction still unknown after 90 s ends a split trade's retry (only the sweep, which reads the ticket, is offered). Phoenix cash-out leaves a stopped trade's Phoenix legs alone until it's swept.

`GET /wallets/:address/incomplete` lists the wallet's stopped trades (the `incomplete` objects), so the app can offer a retry or a sweep after a reload. They're kept in the state file for a week; until then the abandoned-ticket cleanup leaves their tickets alone.

**Abandoned-ticket cleanup:** a trade build ends with a transaction cancelling the owner's other abandoned tickets when it finds any. Looking is a `getProgramAccounts`, so a build looks only when the wallet is known to have one (a cleanup that didn't land, a stopped trade dropped after a week) or at most every 30 minutes per wallet.

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
- Each delivery holds one transaction. The relay keeps the last transaction it handled in `.data/fork/relay-state.json` (`FORK_RELAY_STATE`) and, on start and on every reconnect, back-fills everything since it (`getSignaturesForAddress`, oldest first, up to 5,000), so restarts lose nothing. The first start with no state begins at the newest transaction. Failed deliveries are retried with backoff (1 s doubling to a minute) for as long as it takes and keep their place in the queue; 401/403/404 are retried too. Only a payload the webhook can't take (400, 413, 422), a back-filled transaction `getTransaction` never returns (5 minutes) or a relaying error is given up, with a loud log naming it, and the saved position then stays before it, so a restart retries it. A state file from another fork (its lookup table differs) is ignored, and `update.sh --fresh-fork` removes it. Past 10,000 queued transactions new ones wait for the next back-fill.
- `FORK_RELAY_RECORD=<file>` records raw notifications (how the relay's test fixture was made).

## Phoenix perps

Design: [`docs/phoenix-plan.md`](../../docs/phoenix-plan.md).

- **Registration:** `fork:up` writes a fork-only copy of Phoenix's onboarding permission naming `.data/fork/phoenix-onboarder.json`. The API registers the parent trader account and each leg's child before building, so the user signs only the trade; the app pays rent (~0.028 SOL per wallet, 0.0021 per child, reused).
- **Allowlist and lookup table:** `fork:up` adds Phoenix and Ember to the allowlist and Phoenix's fixed accounts to the lookup table, so a perp leg fits one transaction.
- **Prices:** before each send the API re-copies each market's book, makers and the PerpAssetMap from mainnet; Phoenix refuses orders on a stale mark.
- **Selling:** a sale closes each Phoenix position and returns `phoenixCashOut: true`; the app then calls `POST /wallets/:addr/phoenix/cash-out` until `done`. The cash-out isn't part of the sale: the app shows the sale as done once it's accepted, and builds the cash-out afterwards (the cash-out build waits for the sale to land).
- **Liquidation warnings:** receipts list each Phoenix leg's entry, mark, liquidation price, distance and level (`ok`, `near` within 25%, `close` within 10%). Every `LIQUIDATION_CHECK_SEC` (300) the API sends new `near` / `close` levels to `notify` (`NOTIFY_URL`, `NOTIFY_TOKEN`). The fork has no liquidators.
- **Leverage** comes from the take builder's pick (`Stock · 3x`); a perp pick without one is left out. `FORK_PHOENIX=0` turns Phoenix off.

## Selling a position

**Sell position** on a fork receipt sells a whole back or fade: spot legs swap back to USDC, yield legs redeem their jlUSDC, Phoenix positions close (then cash-out), and prediction and card legs get their escrow back. The sheet shows expected proceeds and the minimum after slippage. The transaction carries `exit_position`, so each position sells once, before the take's 365-day mark (`horizonEnd`), whether the take is open or closed. The settler signs prices at or after the sale and the position settles right away. The author's sale of their own buy-in also closes the take (the exit build answers `closesTake: true`): no new backs or fades (`409 take_closed`), and its headline result settles from the sale. Backers and faders keep their positions until they sell.

Quantities come from the position's opening transaction. A sale that doesn't fit in one transaction takes several (see below); only a single swap too big for a transaction on its own, even on simpler routes, is `422 exit_too_large`. Sold positions stay on the receipt.

**Partial sales.** The exit route takes `bps` (1–10,000 of what's left) or `usd` (converted from what the position is worth now: round(usd / value × 10⁴), all of it within 0.5% of the whole), at most one of them; neither sells all. Anything under 10,000 is the program's `sell_part`. Each leg shrinks by the same fraction: spot legs swap floor(bought × R_before / S) − floor(bought × R_after / S) tokens (R = remaining stake, S = stake; selling all sells what's left), yield legs redeem that share of their jlUSDC, Phoenix legs close that fraction of their lots (rounded toward zero: `422 part_too_small` when it rounds to nothing), and the program pays that fraction of the escrow back. What's left must stay at least the config's minimum stake: `422 remainder_below_minimum` with `{ maxPartialBps, maxPartialUsd, minStakeUsd }` otherwise (a $10 position can only sell all). At most 8 partial sales of a position wait to settle (`409 too_many_open_sales`); `400 invalid_amount` for a bad amount. The build answers the usual fields plus `bps`, `full` and `sale { stakeUsd, remainingStakeUsd, valueUsd, remainingValueUsd }` (`valueUsd` is the part's expected proceeds). Only selling all of the author's buy-in closes the take. A partial sale keeps each Phoenix leg's leverage: right after a child's close, in the same instruction set, Phoenix's `withdraw_to_target_leverage` moves the closed share's margin to the wallet's parent trader account at the leverage the child ran at before the sale (notional / equity at the mid, capped at the market's max; the target rounds down, so a hair less moves). The build answers `phoenixCashOut: true`, and the cash-out withdraws the parent's collateral to USDC once the sale has landed (the exact amount is only known then). `expectedUsd` counts the margin moved, not the child's whole value; a leg already above the market's max leverage that the close doesn't bring under it releases nothing (its freed margin stays with the rest) and counts nothing. Children still holding a position are never swept. Each part scores on its own sale prices and settles on its own (the settler, in order), before the position.

`POST /takes/:id/sell` `{ owner, side, bps?, usd?, prebuild? }` sells that share of everything the wallet holds in the take on one side: whole positions first, smallest first, then at most one partial sale, in one build; the author's buy-in comes last and sells whole only when all of the holding does. Each token is swapped once, for what all the positions sell of it together, and each position's sale instruction comes after every swap. Same answer and errors, plus `positions` (what it sells).

### Sales over several transactions

A sale's build is Phoenix closes, then one swap per token, then one redeem per vault token, then each position's record (`exit_position` or `sell_part`), the last one as the receipt. When that doesn't fit in one transaction it goes out as a sequence, like a split trade: the records ride in the last transaction(s), after every swap, sent back to back (`until: "accepted"` as usual). Neither record checks the swaps beside it, so this is fine on-chain; it just isn't atomic.

- **A sale that stops partway** (a later transaction refused or failed after an earlier one went out) answers `422 sale_incomplete` with `stoppedSale { position, take, takeId, positions, at }`, and the API keeps what each of its transactions carried (in the state file, a week).
- **Selling again finishes it:** any sale build (`/exit` or `/sell`) of one of its positions answers a build of what didn't land instead: the swaps and redeems at the same sizes (at most what the wallet still holds), Phoenix closes not yet landed, and the records still needed (the positions on-chain say which), with what the sale first answered (`bps`, `sale`, proceeds) and `finishing: true`. `409 sale_pending` while one of its transactions may still land (until its blockhash expires); `409 sale_complete` when every record landed after all (any tokens whose swap didn't land stay in the wallet). A finish that stops again is kept the same way.
- **Swaps back to USDC reuse kept routes:** like a back's routes, each token's sell route (the token in, USDC out) is kept for `FORK_API_ROUTE_TTL_MS` (default 10 minutes) and repriced at the token's price now (one batched Price v3 read, shared): `in_amount` exactly the tokens to sell, the expected USDC in proportion and at the price now, the same 1% slippage, impact, shortfall and 3% move limits. A sale whose tokens were all sold (or bought, see below) in that time costs at most one Jupiter call; any other token is quoted afresh and its route kept, with a price read in the build's own turn (a read left for later would be refused while trades queue). After a back or publish lands, each token it bought with no sell route kept gets one quote back to USDC in the route checks' lane (refused, never waited for, whenever the budget is short or trades queue; once per token per route lifetime), so the first sale after a back is repriced too. A wrong estimate fails at preflight, never mistrades, and the wallet's repeat of the same sale moments later quotes afresh. Sales use the build's Jupiter lane (a prebuild's fails fast with `503 busy`).

Receipts and the portfolio give each position `remainingStakeUsd` (cost basis still held), `soldStakeUsd`, `realizedPnlUsd` (settled partial sales; null before the first), `pendingSales [{ seq, bps, stakeUsd, soldAt, priced }]`, `valueUsd` (what's left), `minStakeUsd`, `maxPartialBps` (the largest partial sale allowed now; null: only selling all) and `closesTakeIfSoldAll`. `stakeUsd` and `costUsd` stay what was first paid: they aren't scaled down by partial sales.

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
