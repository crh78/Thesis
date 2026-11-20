# @thesis/venues

One adapter per venue: each builds the user's own instructions for a leg, which `composeTransactions()` in `@thesis/chain` packs with the Thesis receipt.

Built: [`jupiter/`](#jupiter) (spot legs and Jupiter Lend yield legs), [`gemini/`](#gemini) (market data, contracts, leg ids and prices for paper-filled prediction legs), [`phoenix/`](#phoenix) (perp legs and shorts), and [`collector-crypt/`](#collector-crypt) (card data and prices for paper-filled card legs). Planned: `pyth/`. Yield picks deposit into Jupiter Lend only, so there's no Kamino adapter.

`registry/` holds the liquidity registry: a script that measures what's actually tradeable and writes `registry/assets.json` and `docs/liquidity.md`. See [`registry/README.md`](registry/README.md).

- [`bank/`](bank/README.md): the live asset bank (poller, `getAssetBank()`, best-issuer routing).

## Jupiter

`@thesis/venues/jupiter` buys one spot leg from the user's own wallet:

```ts
const best = await bestIssuer("equity:US:NVDA", 25);             // bank: most shares per dollar
const leg = await jupiterBuy({ quote: best.winner!.quote, user, payer, label: "NVDAx $25", apiKey });
// leg.instructions, leg.lookupTables -> composeTransactions() in @thesis/chain, with the receipt
```

- Jupiter's compute-budget instructions are dropped; the composer sets one tight limit per transaction.
- Token-account creation is paid by `payer` (the app's fee payer for Privy users), so users need no SOL. The user still owns the account.
- `leg.marketAccounts` lists the pools and oracles the swap reads, without the user's own accounts. The fork refreshes these from mainnet before sending (`refreshMarkets` in `scripts/fork/lib.ts`).
- `leg.outputAccount` is the user's token account the swap fills: their associated account for the output mint, under whichever token program the swap names (xStocks are Token-2022). For Jupiter Lend deposits it's the jlUSDC account. The Thesis receipt's proof of trade checks it grew (`ComposeLeg.output` in `@thesis/chain`).
- `splitStake(stake, weights)` splits a stake across legs and always adds up to the stake.
- Selling a spot leg is the same swap in reverse: `JupiterClient.quoteExactIn(tokenMint, USDC, rawAmount, route)` quotes the tokens a position bought back to USDC, and `jupiterBuy` builds it (it keeps the input token's account as the user's own, so the fork doesn't overwrite it).
- On a 429, `jupiterPost` (and `jupiterRequest`) waits until the rate-limit window resets (`x-ratelimit-reset`), up to `max429WaitMs` in all (20 s by default; 0 returns the 429 at once). Every Jupiter call takes `fetchFn` and `max429WaitMs`, so a caller can put them behind its own rate budget (the fork API's lanes, `scripts/fork/api/guard.ts`); `quoteFn({ apiKey, fetchFn, max429WaitMs })` is a quote function for `bestIssuer`'s `quote` option, and `jupiterQuote` an exact-in quote in any direction. `bestIssuer` takes `dexes` (Jupiter venue labels) to route only through those venues, which the fork uses to stay off prop AMMs, and re-reads each mint's multiplier at most once a minute.
- Shared swap templates (`jupiter/src/template.ts`): on the fork no wallet exists on mainnet, so two wallets' swap-instructions answers for one quote differ only in the wallet and its own token accounts. `swapTemplate({ res, quote }, owner)` replaces those with a placeholder (or returns null when the answer might depend on the wallet: another signer, an account the swap fills but doesn't create, the wallet's address in instruction data), `fromTemplate(t, user, payer, label)` builds the leg for another wallet, and `retarget(leg, from, to)` is the pure swap underneath. `legDiff` compares two legs byte for byte. Tested on recorded answers (`jupiter/test/fixtures/swap-instructions.json`); `scripts/fork/template-e2e.ts` checks live Jupiter.
- Scaling (`jupiter/src/scale.ts`): `scaleSwap(leg, inAmount, limits, priceFactor)` and `scaleTemplate(...)` rewrite a swap to spend exactly `inAmount` and expect a proportional output (times `priceFactor`, the price now over the price quoted), with the same slippage limit; `unscalable` says why one can't be. `SCALE_LIMITS` (0.1x–10x, quotes under 0.5% impact, 0.5% shortfall, 3% price move) and `SELL_SCALE_LIMITS` (down to 0.01x, quotes up to 2% impact) bound it. Prices: `jupiterPrices(mints)` reads Price v3 for a batch, and `PriceCache` keeps them `PRICE_TTL_MS` (10 s). How the fork API uses them: [`scripts/fork/README.md`](../../scripts/fork/README.md#quotes-and-routes).

**Yield legs (Jupiter Lend Earn):**
- `jupiterLendDeposit({ user, payer, amount, apiKey })` deposits USDC into the jlUSDC vault from the user's wallet (with an idempotent create of their jlUSDC account, paid by `payer`). Needs `JUPITER_API_KEY`.
- `jupiterLendShareValue(shareMint)` is one share's value in USDC (`totalAssets / totalSupply`, keyless), which the settler signs as the leg's price.
- `jupiterLendRedeem({ user, payer, shares, apiKey })` redeems on a sale (no slippage).
- `jupiterLendAccounts({ apiKey })` lists the vault accounts every deposit and redeem shares; `fork:up` puts them in the lookup table so a sale with a yield leg fits one transaction.

Tested on recorded responses (`pnpm --filter @thesis/venues test`) and for real on the fork (`pnpm fork:jupiter-e2e`).

## Gemini

`@thesis/venues/gemini` reads Gemini's public prediction-market data, always through the Thesis `gemini` edge function (`supabase/functions/gemini`). Every request leaves from Supabase's shared egress, so Gemini never sees a developer's or a server's own address. There's no direct mode, no Gemini key and no account.

```ts
const proxy = geminiProxy(envVar);                    // GEMINI_PROXY_TOKEN, and SUPABASE_URL or GEMINI_PROXY_URL
const { url, headers } = geminiRequest(proxy, "events", { status: "active", category: "Crypto", limit: 100 });
```

Paths: `categories`, `events`, `events/<ticker>` (Gemini's `/v1/prediction-markets/...`). The liquidity registry's Gemini section reads through it too.

Contracts (`gemini/src/markets.ts`; rules in `docs/gemini-plan.md`):
- `parseEvent` reads an event's contracts, each side's `ask` / `bid` from `bestAsk` / `bestBid` only (a missing one is no quote), and the resolution.
- `predictionIdHex(instrumentSymbol, side)` is the leg's 32-byte `LegSpec.asset`, `sha256("thesis:prediction:v1:gemini:<instrument>:<yes|no>")`.
- `ineligible(contract, side)` says why a contract can't go in a basket: it must be open, resolve at least an hour out, and be two-sided on that side.
- `legPrice(contract, legSide, "back" | "fade", "entry" | "exit")` is the price the settler signs. Entry is the held side's ask; exit is 1 or 0 once resolved, else the bid. A fade records `1 − (the other side's price)` for the program's "No" formula.
- `fetchGeminiEvent(proxy, eventTicker)` reads one event live (about 1.5 KB through the proxy).

The proxy returns only the fields these functions read (`slimEvent` in `supabase/functions/gemini/proxy.ts`): a field added here must be added there too.

The asset bank's Gemini tier keeps every contract it sees (`venues.gemini.contracts`, expired ones for a week), and `predictionLeg(state, idHex)` finds the contract and side a leg id names.


## Phoenix

`phoenix/` trades perp legs and fade shorts on Phoenix, on top of Phoenix's TypeScript SDK (`@ellipsis-labs/rise`, pinned; its `@solana/kit` instructions are converted to web3.js with `toWeb3`). Design: [`docs/phoenix-plan.md`](../../docs/phoenix-plan.md).

- **Accounts (`layout.ts`):** `traderAddress(owner, sub)`. Subaccount 0 is the parent, onboarded once; children 1–100 hold one perp leg each. `decodeTrader` reads collateral and positions straight from the bytes. `positionSize` is the number the Thesis program counts for proof of trade.
- **`PhoenixVenue`:**
  - `registration` builds the parent's register + onboard through Phoenix's API. Phoenix's onboarder co-signs on mainnet (`submitRegistration`); on the fork, a fork-only permission stands in (`forkOnboardingPermission`, used by `scripts/fork/phoenix.ts`).
  - `childRegistration` registers a child and syncs it from the parent.
  - `openLeg` returns two venue legs, collateral (USDC → PhUSD → the child) and a market order of collateral × leverage within 1% of the price. Both name the child as the leg's output.
  - `closeLeg` closes the child's position. `sweepLeg` then withdraws exactly what's left; Phoenix refuses more than that, so it runs after the close lands.
  - `marketAccounts(m)` is what the fork re-copies from mainnet before an order: the book, the makers' splines and the PerpAssetMap, which holds the mark prices.
  - Prices: `mid` (live order book) and `markAtOrAfter` (Phoenix's mark at the first one-minute bar at or after a moment).
- **The app pays.** Every instruction takes a separate payer for rent and fees; the wallet only signs.
- `pnpm fork:phoenix-e2e` runs register, long, short, close and sweep on the fork with no Thesis program involved.

## Collector Crypt

`collector-crypt/` reads Collector Crypt's public card data from `api.collectorcrypt.com`. It needs no key; an optional `ccsk_` key raises the limits. Card legs are paper-filled: no card is bought, the leg's share is escrowed like a prediction leg, and the leg is priced at the card's insured value. The decisions and research are in [`docs/cards-plan.md`](../../docs/cards-plan.md).

- `CollectorCryptClient`:
  - Sends one request at a time, 250 ms apart, with a `User-Agent` (CC refuses requests without one).
  - Waits out a 429 (`retryAfter` in the body) and retries 5xx errors.
  - `card(id)` reads one card, with its insured value and when its metadata changed.
  - `page()` and `allCards()` page through every card CC indexes, listed or not (about 197k, roughly 1,000 requests). `listedOnly` limits them to listed cards.
- `parseCard` reads a browse row or a single card. `cardPrice(card)` is the price the settler signs at entry, exit and sale: the insured value, or null when `cardUnpriceable` says why not (no insured value, no longer a live token, deleted or burned to bridge).
- `cardIdHex(cardId)` is the leg's 32-byte `LegSpec.asset`, `sha256("thesis:card:v1:collector-crypt:<cardId>")` (Card kind on-chain).
- `CC_MARKETPLACE_PROGRAM_ID` and `CC_COLLECTIONS` are there for when real purchases come back. The current proof of trade can't count a Core asset or a frozen pNFT account.

Tested on recorded responses (`pnpm --filter @thesis/venues test`).
