# Take builder A/B results

Kept out of rubric.md so judges never see which builder has been winning.

## Results (100 cases, blind, 4 judges)

| Run | BM25 builder | wins vs gte | mean score | p50 / p90 latency (gte) |
|---|---|---|---|---|
| 1 | search-only, two model calls | 46-24 | 6.51 vs 5.83 | 3.1 / 5.0 s (2.4 / 6.4 s) |
| 2 | + tokenizer, aliases | 50-29 | 6.56 vs 5.56 | 3.2 / 10.0 s (2.6 / 12.1 s) |
| 3 | listed catalog in the cached prompt | 36-31 | 6.11 vs 5.72 | 2.8 / 7.7 s (2.3 / 5.6 s) |
| 4 | + speculative search round, team aliases | 42-36 | 6.09 vs 5.59 | 3.3 / 11.0 s (3.8 / 13.4 s) |
| 5 | + names matched in memory, short abouts, looser counts | **54-23** | **6.89 vs 5.74** | **2.0 / 3.1 s (2.3 / 3.2 s)** |

Runs 1-4's tails were the builder's own per-word `search_securities` calls saturating the
database (slowing gte too); run 5 matches names in memory.

## Seven variants, listwise (100 cases, 5 judges; agent-db judged 3-way, 4 judges)

| Variant | Score | vs gte W-T-L | p50 | p90 | searches/take |
|---|---|---|---|---|---|
| agent-markets (search tool + up-front markets, up to 8 rounds) | 7.08 | 56-29-15 | 4.2 s | 11.8 s | 5.6 |
| agent (search tool only, up to 8 rounds) | 7.01 | 51-35-14 | 4.8 s | 11.0 s | 6.5 |
| **v10-reasoning (shipped)** | 6.98 | 57-28-15 | **2.1 s** | **4.0 s** | 0.1 |
| v10 (reasoning none) | 6.94 | 59-20-21 | 2.2 s | 5.8 s | 0.3 |
| listed-agent (v10, up to 8 rounds) | 6.93 | 54-29-17 | 2.3 s | 5.5 s | 0.5 |
| agent-db (no index: Postgres search, up to 8 rounds) | 6.10 | 43-28-29 | 12.3 s | 20.7 s | 7.9 |
| gte (embeddings, the old builder) | 5.67 | | 2.6 s | 6.3 s | |

More search rounds over the same BM25 index score within noise of v10 at twice the latency;
searching Postgres directly (no aliases, no listed catalog) scores lower and gives up more often.

## Direction and fit (120 cases: the 100 + 20 X mentions and posts, 101-120; 1 blind judge each)

Main bought what a bearish take is against ("$TSLA demand is collapsing": Tesla; "restaurants are in
trouble": McDonald's, Wendy's), stood a broad index or an unrelated name in for a sector the catalog
doesn't have (utilities: the S&P 500; nuclear: Lockheed), and dropped a perp below high risk even
when it's the only way to hold a name (Eli Lilly: the basket became cash or an off-topic market).

Fixed with: every pick IN what the take is about or no_clean_exposure; a `gains_if_right` per pick
and a `bearish` flag (a bearish post's $cashtags aren't copied as buys); a 1x perp for a name with
no stock at any risk, uncapped; no name-matching fallback once the model has answered.

| Builder | vs main W-T-L | score (main) | X cases (main) | p50 / p90 |
|---|---|---|---|---|
| reasoning low (the app) | 44-62-14 | 6.93 (5.79) | 6.5 (3.7) | 1.5 / 2.3 s |
| **reasoning medium (the bots, via `POST /source/drafts`)** | **52-62-6** | **7.44 (5.77)** | **7.2 (3.7)** | 2.8 / 5.1 s |

Main's p50 / p90 on the same run: 1.8 / 3.0 s. Low still bought longs on a bearish post in some
runs; medium didn't. Medium's losses: a low-risk basket without its cash, a prediction market
diluted by the stock.
