# @thesis/executor

Long-running worker that holds the Thesis settler key. It never holds user funds: users' own wallets sign their trades. Kept out of the web app's environment.

| Command | What it does |
| --- | --- |
| `pnpm --filter @thesis/executor settler [-- --once]` | The settler price service (below). On the shared fork it runs as the `thesis-settler` service on the VM ([`infra/executor`](../../infra/executor/README.md)); `pnpm fork:settler` runs it against a fork on this machine. |
| `pnpm --filter @thesis/executor asset-bank [-- --once]` | The asset bank poller ([`packages/venues/bank/README.md`](../../packages/venues/bank/README.md)). The settler reads the bank to map legs and mints to underlyings. |
| `pnpm --filter @thesis/executor marker [-- --once] [--dry-run]` | Live returns (below). On the VM it runs as `thesis-marker`. |

After each Gemini sweep the poller also keeps the take builder's Gemini contracts current (new ones indexed, ones expired a day ago taken out of search), and every 15 minutes it syncs the catalog's tradeable flags with what can be bought and priced (a $25k pool and a $100 buy under 1%; `packages/take-builder/src/liquidity-sync.ts`). Both need `SECURITIES_INDEX_SECRET`; `--no-index` turns them off.

## Marker

Every 5 minutes (`MARKER_INTERVAL_SEC`) the marker prices every pick of every open take with the settler's rules and writes, through the `marks` edge function (`MARKS_TOKEN`):

- each open on-chain position's live return, from the entry prices the settler signed into its account;
- each take's live return: its author's buy-in's live return once the settler has signed the author's entry prices (what the take settles on), and until then an index of its picks since it was posted;
- each pick's base and mark (`take_legs`), and the take's hourly history (`take_stats`), which `take_price()` and paper positions read.

It reads positions and takes from the chain 100 at a time (`getMultipleAccounts`), and skips an address the chain doesn't have until the hourly full check, so deleted positions don't cost an RPC call each run. It signs nothing and needs no key.

## Settler price service

Every tick (20 s by default) it:

1. **Signs entry prices** for positions that lack them, **sale prices** for positions their owners sold (at or after the sale, the same way as exits), and **exit prices** for positions still held once the take's 365-day mark (`horizonEnd`) has passed (`record_entry_prices` / `record_sale_prices` / `record_exit_prices`). A sold position, the author's buy-in included, scores on its sale and takes no exit prices. Each partial sale (`sell_part`) gets its own sale prices at or after it, on the entry's basis (`record_part_prices`; its audit document has `moment: "part"` and `partSeq`).
2. **Settles takes** whose author prices are in, or whose grace period (`max_price_delay_secs`) has passed: a closed take (its author sold all of their buy-in) on the author's sale prices, an open one at the 365-day mark.
3. **Settles partial sales** (`settle_part`), each position's in seq order, as soon as each one's prices are in (or at 0%, unscored, once its grace period has passed). They don't wait for the take.
4. **Settles positions**, which closes them (and a sold position's exit account) and refunds their rent to whoever paid it: a sold position as soon as its sale prices are in, the author's buy-in once its take settles, a held one once its take has settled and the 365-day prices are in; never while a partial sale of it waits to settle.
5. **Mints badges** an author has earned but doesn't hold yet.

Only step 1 needs the settler's signature; the settler key pays for the rest. Instructions are packed into as few transactions as fit, each with a compute limit from `THESIS_COMPUTE_UNITS` rather than the 200k default.

### Which price

**Prediction legs** (Gemini, paper-filled) are priced from Gemini's live market data through the Supabase `gemini` proxy (`GEMINI_PROXY_TOKEN`), never directly. The asset bank maps the leg's id to its contract and side.
- Entry is the held side's ask. The contract becomes the leg's basis in the audit log, so the exit doesn't need the bank.
- Quotes come from the contract's `bestBid` / `bestAsk` (No is the complement of Yes's book). A missing one is no quote: never Gemini's `prices.buy` / `prices.sell`, which it fills with the last trade when a side of the book is empty. Books that are crossed or don't add up are refused, and an entry is priced only from a read made at or after the trade.
- Exit and sale are 1 or 0 once the contract resolved, else the held side's bid. A contract that stopped trading is waited on, up to the price deadline.
- A fade holds the other side and records `1 − price`, for the program's "No" formula.
- Reads are per event and reused for 15 s. An event it's waiting on keeps the normal pace for 10 waits, then backs off to 1, 2, 4 and at most 5 minutes (`settler/gemini-source.ts`).
- Without the token, prediction legs wait unpriced.

**Other legs** are priced per leg, on the token the position's trade actually bought. The receipt's `TradeProved` event says which token account each leg filled, and by how much, counting only changes inside the trade's proof-of-trade brackets (`src/settler/proof.ts`). Two rules come first:

- **Asset match.** A spot leg is priced only on a token the trade delivered for it, whose underlying is the leg's own.
  - With no such token, the leg stays unpriced: none delivered, another underlying's token, or a token the bank doesn't know. There's **no stock fallback**, and after the grace period the position settles at 0%, unscored.
  - Legs held on Phoenix are checked against the Phoenix position instead (market, side, and notional ≥ `SETTLER_MIN_RECEIVED_RATIO` of share × leverage), priced on Phoenix's mark, and at −100% if the position is gone at the 365-day mark (`settler/phoenix-legs.ts`, [`docs/phoenix-plan.md`](../../docs/phoenix-plan.md)).
- **Value check.** At entry, the tokens a spot leg received, at the entry price, must be worth at least `SETTLER_MIN_RECEIVED_RATIO` (90%) of the leg's part of the stake. Otherwise the leg stays unpriced. This catches a stake swapped through a pool someone made at an absurd price.

Then, for a leg that passes:

1. **The issuer token's price** (Jupiter Price v3), at any hour, when the settler runs within `SETTLER_LIVE_WINDOW_SEC` of the moment (the trade, a sale or the 365-day mark) and the token has at least `SETTLER_MIN_LIQUIDITY_USD` of liquidity. The user holds the token, so its price is their result (token first, the stock only as a fallback). There's no band against the stock. The default floor is $25k (`PRICEABLE_MIN_POOLED_USD`), the same as the router's. Prices are scaled by the token's ScaledUiAmount multiplier since the entry (splits and reinvested dividends), or by the stock's splits from Alpaca for tokens with no multiplier. For stocks the settler also records the token's premium to the stock's latest Alpaca trade, if that trade is under `SETTLER_STALE_REF_SEC` old, so an exit that has to fall back to the stock stays on the token's terms. Tokens whose units-per-token ratio fails the bank's price check are never bought, so they never get here.
2. **Otherwise (the bought token has no liquid price, or the settler ran late), for US stocks and ETFs, the first Alpaca trade at or after** the moment (IEX feed, free plan). A Friday-evening back is priced at Monday's first trade, so nobody can trade on weekend news at Friday's close. This also covers a crank that runs late. A token-priced entry exits on the stock only through the premium recorded at entry; with no premium (entered with the market shut) it waits for a live token price within the live window, then stays unpriced. Jupiter and Alpaca are the only price sources.
3. **Yield legs** (scored) are priced on one share of the Jupiter Lend vault the trade delivered (the proved output must be that vault's share): its value in USDC now, `totalAssets / totalSupply`, rule `lend-share-value`. The vault only gains, and any price at or after the moment counts, so the current value is the first one at or after it. Their return is the interest the share earned.
4. **Card legs** (paper-filled Collector Crypt cards) are priced in dollars at the card's Collector Crypt insured value, read at or after the trade, the sale or the 365-day mark, rule `card-insured-value` (`settler/card-legs.ts`). With no insured value inside the price window the leg stays unpriced.
5. **Anything else has no source yet:** non-stock underlyings with no liquid token in the live window. Prediction legs have their own source (above). Those legs stay unpriced; after the grace period the position settles at 0% and doesn't count toward the score.

Prices are per one unit of the underlying (one share, one ounce), using the bank's units-per-token, so entry and exit compare like with like even when one came from the token and the other from the stock.

### Audit trail

Each `record_*_prices` call carries `source_hash` = sha256 of a canonical JSON document (keys sorted at every level) holding the raw market data used: the Alpaca trade or the Jupiter response (and the stock reference its premium came from), per leg. The documents are appended to `SETTLER_AUDIT_FILE` (default `.data/settler/audit.jsonl`), one line each with its hash, and, with `PRICE_AUDIT_TOKEN` set, published to the public `price_audit` table through the `price-audit` function, which recomputes each hash before storing it. Entry bases are read back from that table on start, so losing the local file doesn't break exits. To check a position's prices against the chain: `node apps/executor/scripts/verify-prices.ts` (or recompute `sha256(canonicalJson(doc))` yourself, `src/settler/audit.ts`).

### Settings

Environment or the repo-root `.env`; keys are never printed.

| Variable | Default | |
| --- | --- | --- |
| `SOLANA_RPC_URL` | `http://127.0.0.1:18899` (the fork) | |
| `SETTLER_KEYPAIR` | `.data/fork/settler.json` | Must be the config's settler |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | required | Free Alpaca account, market data |
| `JUPITER_API_KEY` | required | Token prices (Price v3, read in batches of 50 per tick, resting 30 s to 2 min after a 429) and yield legs, on api.jup.ag |
| `SETTLER_MIN_LIQUIDITY_USD` | 50000 (`PRICEABLE_MIN_POOLED_USD`) | The router's floor too |
| `SETTLER_LIVE_WINDOW_SEC` | 300 | |
| `SETTLER_MIN_RECEIVED_RATIO` | 0.9 | A spot leg's tokens at entry must be worth this share of its part of the stake |
| `SETTLER_INTERVAL_SEC` | 20 | |
| `SETTLER_AUDIT_FILE` | `.data/settler/audit.jsonl` | |
| `PRICE_AUDIT_TOKEN` | unset: local file only | Publishes each signed price's source document to `price_audit` |
| `ASSET_BANK_SINK` | file | Where the bank lives; run the asset bank once first |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | unset: scan every tick | The open positions come from `chain_positions` between full scans |
| `SETTLER_CHAIN_NETWORK` | `solana-mainnet-fork` for a local RPC, else `solana-mainnet` | Which network's `chain_positions` rows |
| `SETTLER_FULL_SCAN_SEC` | 600 | The full program scan's period, a backstop for the Stream |

### Limits for now

- The open set comes from `chain_positions`, so a position the Stream hasn't delivered waits for the next full scan (10 minutes at most). Without Supabase settings it scans every tick.
- One settler key signs prices and pays for cranks. Splitting the crank payer from the price signer is a config change away.

### Tests

```sh
pnpm --filter @thesis/executor typecheck
pnpm --filter @thesis/executor test        # pricing and proof-of-trade rules, hashing, packing, source requests
pnpm fork:settler-e2e -- --move-clock      # on the fork: entry, time jump, exit, settlement, badges (the fork maintainer's OK only; restart the fork after)
```
