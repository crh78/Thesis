# @thesis/take-builder

AI take builder: opinion → risk question → explained basket (why each leg, purity of exposure, liquidity), or "no clean exposure". There's no horizon question: a take runs until its author sells, a year at most, so prediction markets resolving within a year are preferred.

The builder runs as the `take-builder` Supabase edge function (`supabase/functions/take-builder`). It lists every stock, ETF, perp and cash vault in a cached prompt, BM25-searches prediction markets on the take's words (an in-worker index over `basket_catalog()`, no embeddings), lets one fast model call `search` for a market it needs, and has it pick and weight 1–5 legs. `eval/` compares builders on 100 takes with blind LLM judges (`eval/RESULTS.md`).

House rules (`supabase/functions/take-builder/rules.ts`):
- a perp pick's leverage is the model's choice, from the risk the user picked and how directly the name is the take, at most 5x and the market's own max; 2x when no model chose it (the rules fallback, a switch to high risk, an add by name);
- a perp is at most 30% when the basket holds other picks; one pick per name;
- Collector Crypt cards (live search) at medium and high risk only: a take about cards can be all cards, any other take gets at most three cards, each at most 20%, never only cards;
- only assets the catalog rates "tradeable". Everyone gets the whole catalog for now (`US_RESTRICTIONS=on` brings back the US rule).

Each pick says whether a fade can short it (`canShort`), which the apps use to show Fade only when a leg can be faded.

This package builds the index:

| Command | What it does |
| --- | --- |
| `pnpm --filter @thesis/take-builder catalog` | `catalog.json` from the liquidity registry (`packages/venues/registry/assets.json`): spot names, Phoenix perps, Gemini markets, yield, cards, each with a liquidity class |
| `pnpm --filter @thesis/take-builder index` | Sends the catalog to the `securities-index` function, which writes descriptions and themes and stores it |
| `pnpm --filter @thesis/take-builder index-gemini [-- --dry-run]` | Keeps Gemini prediction contracts current (one row per contract, `gemini:<instrumentSymbol>`, all categories). Reads through the `gemini` proxy and indexes only new ones (no model call); contracts expired over a day ago leave search. The asset-bank poller does this after each sweep, so this is for a manual refresh. |

Gemini contracts aren't in `catalog.json`: `index-gemini` indexes them on their own (`docs/gemini-plan.md`).

`catalog.json` is a snapshot, but the asset-bank poller re-syncs the stored `tradeable` / `thin` flags every 15 minutes (`src/liquidity-sync.ts`: a $50k pool and a $100 buy under 1%, or the Phoenix market's own flag). Trades check live liquidity too, so a pick can still be left out of a trade if its pools thinned between syncs.
