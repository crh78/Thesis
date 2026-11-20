# Asset bank

A live bank of tradeable assets for the AI take builder, refreshed every few minutes, plus best-issuer routing at trade time.

- **Grouped by underlying.** Every token and market is filed under what it tracks (`equity:US:NVDA`, `etf:US:SPY`, `commodity:XAU`, ...). A basket leg is the underlying, not a specific token: `underlyingId(key) = sha256("thesis:underlying:v1:" + key)` goes in the program's `LegSpec.asset` (see `src/identity.ts`).
- **Comparable units.** Each issuer token records how much underlying one token represents (the xStocks Token-2022 ScaledUiAmount multiplier, ounces or grams for gold, ...; see `src/ratios.ts`). Tokens with an unknown ratio are marked not comparable and never chosen.
- **`getAssetBank()`** returns only tradeable, non-stale assets, grouped by underlying and theme, with each one's current best issuer.
- **`bestIssuer(underlying, usd, { maxAccounts, excludeUs })`** quotes every comparable issuer live and returns the one that gives the most underlying per dollar, plus the runners-up. Tie-breaks are in `src/route.ts`.

## Run it

```sh
pnpm --filter @thesis/executor asset-bank          # keeps running
pnpm --filter @thesis/executor asset-bank --once   # every tier once, then exit
```

Reads `JUPITER_API_KEY` and `QUICKNODE_RPC_URL` from the repo-root `.env`. Writes `.data/asset-bank.json` by default, or Supabase (`supabase/migrations/0004_asset_bank.sql`).

## Cadences (defaults; each can be changed with an env var)

| Tier | Default | Env var |
|---|---|---|
| Discovery (new tokens, markets, cards) | 60 min | `ASSET_BANK_DISCOVERY_MIN` |
| Batched prices (up to 50 mints per call) | 90 s | `ASSET_BANK_PRICES_SEC` |
| Liquidity probes ($100, then $1,000 if $100 routes) for routed tokens | each re-probed after 7.5 min | `ASSET_BANK_PROBE_TTL_MIN` |
| Probes for tokens with no route | hourly | `ASSET_BANK_UNROUTED_TTL_MIN` |
| Phoenix markets and depth | 10 min, one order book every 4 s (`ASSET_BANK_PHOENIX_GAP_SEC`) so the sweep stays under Phoenix's rate limit and trades from the same address can still read prices | `ASSET_BANK_PHOENIX_MIN` |
| Gemini markets: every contract, through the `gemini` proxy (expired ones kept a week; current for 13 hours, `ASSET_BANK_MAX_GEMINI_AGE_MIN`) | 6 hours | `ASSET_BANK_GEMINI_MIN` |
| Collector Crypt listings / yield APYs | 15 min | `ASSET_BANK_CARDS_MIN` / `ASSET_BANK_YIELD_MIN` |
| Picked cards (card legs): every card a basket picked (the catalog's `card:<cardId>` rows), new ones first, then any older than an hour, so the settler can price card legs (`cardLeg`, `src/cards.ts`) | each cards run, up to 60 cards | `ASSET_BANK_CARDS_MAX_READS` |
| Jupiter request budget | 25 per minute | `ASSET_BANK_JUPITER_RPM` |

Probes go stalest first, and each batch is sized to whatever the Jupiter budget leaves after prices. A tier that fails retries after 30 s, and a run that overruns is never started twice.

**Probe venues (`ASSET_BANK_DEXES`).** Comma-separated Jupiter DEX labels, sent as the quote's `dexes` parameter, so a token counts as tradeable only if it routes through those venues. Unset (mainnet): every venue. On the fork it must be the fork router's list, `FORK_DEXES` in `scripts/fork/lib.ts` (the value is in `infra/executor/executor.env.example`): otherwise a token whose only route runs through a venue the fork can't use (URA via ZeroFi, for example) is offered by the take builder and the receipt can't buy it. Each probe records the list it used (`probe.dexes`); a probe taken with a different list is re-probed first, so a changed setting takes effect within a few probe runs of a restart, and the catalog's flags follow at the next liquidity sync (every 15 minutes).

Next to the file sink's `asset-bank.json` (`src/side-files.ts`):

- `asset-bank.prices.json`: the token prices and pooled liquidity alone, rewritten on every flush. The fork API's live display values read it before asking Jupiter (the main file is ~25 MB).
- `trade-builds.busy`: when the fork API touches it while user trade builds run or wait (`markBuildsBusy`), probes pause until it's 15 s old, so the shared Jupiter key goes to trades first. No file: never paused.

## Request volume and cost

At these defaults the poller stays small: Jupiter stays inside its budget (the VM runs `ASSET_BANK_JUPITER_RPM=25`, the default, on the same `JUPITER_API_KEY` as the fork API, settler and marker: the Developer plan, 10 a second per organisation, most of it given to the fork API's trades; a full probe cycle takes about 11 minutes at 45), QuickNode mint reads are cached after a cold start (~460 calls, 5 accounts per call on the free plan), the public Phoenix, Collector Crypt, Kamino and Jupiter Lend APIs cost about 30 requests an hour, and Gemini about 5 (one sweep every 6 hours; budget in `docs/gemini-plan.md`). Raise `ASSET_BANK_JUPITER_RPM` only with room left under the fork API's `FORK_API_JUPITER_RPM`.
