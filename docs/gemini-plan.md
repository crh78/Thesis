# Gemini prediction legs (paper fills)

Prediction legs from Gemini's prediction markets, filled on paper at Gemini's live prices and scored on-chain like any other leg. Built and live on the fork.

## Rules

- **Market data only.** Gemini's public endpoints, always through the Supabase `gemini` proxy (`supabase/functions/gemini`, `@thesis/venues/gemini`), never from our own address. No Gemini key, account or orders.
- **The money.** A prediction leg's share of the stake (floor of stake × prediction weight ÷ included weight) goes into the program's escrow vault in the receipt's transaction. `exit_position` returns it at a sale, `settle_position` otherwise. Paper gains aren't paid; Thesis is never a counterparty. Proof of trade requires `spent ≥ stake − escrowed`.
- **The score.** Prediction legs count in the same return, profile stats, leaderboards and badges as real legs.
- **Prices** (settler-signed):
  - entry is the held side's ask when the trade lands;
  - exit is 1 or 0 if the contract resolved, otherwise the held side's bid at the sale or the take's 365-day mark;
  - quotes come only from `bestBid` / `bestAsk` (No is the complement of Yes's book); a missing one is no quote. Never Gemini's `prices.buy` / `prices.sell`, which it fills from the last trade.
- **Fades** hold the other side of each prediction leg. Other legs are faded through Phoenix shorts where listed; the rest show as excluded.
- **Markets:** all categories. A contract must resolve at least an hour out and have a bid and an ask on the chosen side. A take has no timeline (it runs until its author sells, a year at most), so the builder prefers contracts resolving within 365 days; later ones are allowed (exit at the bid).
- **Fee:** 0.10% of the whole stake, prediction share included.
- **No "paper" label** in the app on the fork. Before real users: paper gains must never look withdrawable.

## How a leg is identified

A leg names one contract and one side: `asset = sha256("thesis:prediction:v1:gemini:<instrumentSymbol>:<yes|no>")` (`predictionIdHex`). App picks carry `asset_id = gemini:<instrumentSymbol>` plus the side. A fade records `entry = 1 − (other side's ask)` and `exit = 1 − (other side's bid)`, or the resolution. The settler stores the contract in the leg's entry basis, so exits don't need the asset bank.

## Keeping contracts current, within the free plans

Every read is one Supabase Edge Function invocation plus egress (free plan: 500,000 invocations and 5 GB a month); Gemini asks for under 1 request a second. The proxy trims events to the fields Thesis reads (`slimEvent`): a full sweep is ~4.7 MB, one event ~1.5 KB.

| Reader | What it reads | How often |
|---|---|---|
| Asset-bank poller | A full sweep (~30 reads, 1 a second); indexes new contracts for the take builder, drops ones expired a day ago from search | Every 6 hours (`ASSET_BANK_GEMINI_MIN`); counts as current for 13 hours |
| Fork API (trades, receipts, marks) | The take's events, live. Trades leave a leg out if Gemini can't be read; receipts fall back to the sweep. A side missing for a few seconds is bridged with a price seen in the last minute (`GAP_MS`) | Once per event per 30 s (`scripts/fork/api/gemini-live.ts`) |
| Settler | One event per price it signs, reused 15 s; a stuck contract backs off to every 5 minutes (at most ~1,150 reads over the price deadline) | Per price |
| `index-gemini` | A full sweep | By hand only |

Two weeks of dogfooding comes to under ~55,000 invocations and ~0.35 GB. No WebSocket: it would need a long-running client that shows our address.

## Not decided yet

- Should a contract need a minimum relevance to be offered? (Unrelated sports lines used to rank high; recheck with the BM25 search.)
- Before real users: paper-leg labels, or real Gemini orders.
- The trading/fading bar reads "0% trading, 100% fading" on a take with no trades yet.
