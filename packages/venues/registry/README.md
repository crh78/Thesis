# Liquidity registry

One source of truth for every asset Thesis could put in a basket, with liquidity measured live. A script regenerates two files:

- [`assets.json`](assets.json): for the AI take builder.
- [`docs/liquidity.md`](../../../docs/liquidity.md): for people. One table per category, tradeable first, then basket candidates by theme.

## Run it

From the repo root, with Node 24 or newer (it runs the TypeScript directly; no install step, no dependencies):

```sh
node packages/venues/registry/src/build.ts
```

Or `pnpm --filter @thesis/venues registry`. A full run takes about 20 minutes on the free Jupiter tier, because of its rate limit, and a few minutes with `JUPITER_API_KEY`.

| Flag | What it does |
|---|---|
| `--quote-floor=<usd>` | Only quote tokens with at least this much pooled liquidity in Jupiter's token API (default `100`). `0` quotes everything with any pool. |
| `--max-quotes=<n>` | Quote at most n tokens, largest pools first (quick test runs). |
| `--skip=phoenix,yield,cards,gemini,quotes` | Skip sections. |
| `--render-only` | Regenerate `docs/liquidity.md` from the existing `assets.json`, with no API calls (for changes to `render.ts`). |

### Keys

The script reads `QUICKNODE_RPC_URL`, `JUPITER_API_KEY` and `PYTH_API_KEY` from the repo-root `.env`. It walks up from its own folder, so it also finds the main checkout's `.env` from a worktree; `THESIS_ENV_FILE` overrides the path. It logs only whether each key is set, never the value. Every key is optional:

| Key | Without it |
|---|---|
| `QUICKNODE_RPC_URL` | Uses the public `api.mainnet-beta.solana.com`. A configured URL that returns 401 or 403 also falls back to it, and the run records a gap. |
| `JUPITER_API_KEY` | Uses `lite-api.jup.ag` (about 5 requests per window) and quotes only tokens above the floor. |
| `PYTH_API_KEY` | Not used yet. Feed IDs come from the keyless Hermes catalog, and on-chain availability from reading the sponsored push accounts. |

## What it measures

| Section | Source | Live data |
|---|---|---|
| Tokenized stocks and ETFs (xStocks, Ondo Global Markets, Backpack Securities, Remora rStocks), pre-IPO (PreStocks, Tessera), leveraged (SHIFT), commodities, yield tokens, other RWAs | Jupiter verified token list by tag, plus a token search for rStocks | Mint account (token program, Token-2022 extensions, transfer fee, permanent delegate, pause state, UI multiplier), Pyth feed and whether it is pushed on-chain, Jupiter quotes for $10 / $100 / $1,000 USDC buys at `maxAccounts=30` |
| Phoenix perps | `perp-api.phoenix.trade` | Every active market, max leverage, open interest, order-book depth within 1%, simulated buy impact |
| USDC yield | Kamino `kvaults` API, Jupiter Lend Earn API | TVL and current, 7-day and 30-day APY |
| Collector Crypt | `api.collectorcrypt.com/marketplace` | Listings by category, token standard, USDC price ranges |
| Gemini prediction markets | `api.gemini.com/v1/prediction-markets`, read through the Supabase `gemini` function (needs `GEMINI_PROXY_TOKEN`; see `packages/venues/README.md`) | Active events and volume by category |

Hand-kept facts (issuers, restrictions, themes, permissioned exclusions) are in [`src/curated.ts`](src/curated.ts), each with a source URL or marked unverified.

### Classes

- **tradeable:** a $100 USDC buy routes on Jupiter at `maxAccounts=30` and costs under 1%. (This one-off build's rule. The live rule, which the asset-bank poller syncs into the catalog, also needs $50k pooled: `packages/take-builder/src/liquidity-sync.ts`.) Cost is the larger of Jupiter's `priceImpactPct` and the slippage against the $10 quote's rate, plus any Token-2022 transfer fee.
- **thin:** it routes, but costs more than that, or only $10 routes.
- **price-only:** no usable route, but a Jupiter or Pyth price exists. Usable as a price-tracked leg.
- **no-market:** no route and no price. Listed compactly in `assets.json` under `noMarket`.
- **excluded:** permissioned (KYC or allowlist).

For Phoenix perps, tradeable means a $1,000 taker buy fills within 1% of mid.

## `assets.json` shape

- `spot[]`: one object per token, one line each. Join `issuerTag` to `issuers` for issuer-wide restrictions and sources. Empty, false and null fields are dropped; a missing `liquidity.quotes` means the token was not quoted.
- `noMarket[]`: `[symbol, mint, issuerTag, category]`.
- `permissioned[]`, `phoenix`, `usdcYield`, `cards`, `gemini`, `gaps`, `counts`.

## Files

```
src/build.ts          orchestration, classification, JSON output
src/render.ts         docs/liquidity.md
src/curated.ts        issuers, restrictions, themes, exclusions, source URLs
src/sources/*.ts      jupiter, pyth, phoenix, yield (Kamino, Jupiter Lend), cards, gemini
src/lib/*.ts          env loading, rate-limited fetch, base58 / PDA / RPC helpers
```
