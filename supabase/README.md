# supabase

Migrations, edge functions, seed data and config for the `thesis` project
(`https://<project-ref>.supabase.co`). Auth is Privy, not Supabase Auth: clients read with the
publishable key, and every write goes through an edge function that verifies the
Privy access token (`privy-token` header) and uses the service role.

## What's here

| Piece | What it does |
|---|---|
| `migrations/*_profiles`, `*_ensure_account`, `*_explicit_grants` | Users: `profiles` (public) and `accounts` (private) |
| `migrations/*_social.sql` | Takes and their legs, follows, saves (private), comments, comment likes, and placeholder stats tables |
| `migrations/*_social_reads.sql` | SQL read functions the app calls directly (`/rest/v1/rpc/<name>`): `feed`, `following_feed`, `trending`, `search_takes`, `take_comments`, `followers`, `following`, `leaderboard`, … Each returns one screen's data as JSON. |
| `migrations/*_suggested_follows.sql` | `suggested_follows(profile)`: people to follow, ranked by who the people you follow follow, who follows you, then followers / cash made / recent takes, each with a `reason` ("Followed by @priya and 2 others", "Top caller"). |
| `migrations/*_take_traders.sql` | `take_traders(take, viewer)`: who traded / faded a take and how much (you first, then people you follow, then recent). Security definer over the private ledger, exposing only that take's trades / fades. |
| `migrations/*_post_after_chain.sql` | `takes.status` (`posting` / `live`): a fork-mode take is visible only to its author until its on-chain `takeCreated` makes it live. Live-only RLS on takes, legs, stats and comments; `take_for_chain(id)` (the fork API's read), `posting_takes`, `discard_posting_take`; an hourly pg_cron job deletes posting takes older than 24 hours. `takeCreated` makes a take live only when author, claim hash and `horizonEnd` all match (`*_go_live_by_take.sql`); one posting take per author and claim. |
| `migrations/*_author_sale_closes.sql` | No-timeline takes: `create_take` ignores the horizon (every take is `12mo`, `settles_at` = posting + 365 days, the "auto-settles by" date). The author's sale closes the take: `takeClosed` sets `chain_takes.closed_at`, `takeSettled` sets `settled_at`, and `take_json()` adds `closed_at`, `settled` and `settled_at`. Holders with open positions get a `take_closed` notification ("@author sold: closed at +X%. Your position stays open until you sell."), and the `take_settled` after the sale leaves them out. `apply_marks()` freezes a closed take's return. |
| `migrations/*_chain_scores.sql` | Scores from the chain: `chain_positions` (one row per on-chain position, kept from `chain_events`), `chain_wallet_stats(network, since)`. With the `x-thesis-network` header, `leaderboard()` and `person_json()` use on-chain P&L, and only profiles with on-chain activity are on the board. |
| `migrations/*_two_scores.sql` | The second score: `chain_backer_stats(network, since)` is what everyone who backed an author's takes made, net of losses, without fades or the author's own positions. `person_json()` adds `backers_made` and `backers_pct`. `leaderboard(period, limit, board, sort)` takes a board (`own` or `backers`) and a sort (`cash` or `pct`); called with only a period it answers as before. |
| `migrations/*_fader_board.sql` | The fader board: `chain_fader_stats(network, since)` is what each wallet made fading other people's takes, and `leaderboard()` accepts the board `faders`. |
| `migrations/*_leaderboard_dir_viewer.sql` | `leaderboard(period, limit, board, sort, dir, viewer)`: `dir` `asc` ranks lowest first; with a `viewer` profile id the answer is `{ rows, viewer: { rank, cash, pct, person } \| null }` (their place on the whole board), without one the same array as before |
| `migrations/*_account_deletion.sql` | Deleting an account keeps the takes others are in: `takes.author_id` and `comments.author_id` are `on delete set null`, reads show `deleted_person_json()` ("Deleted account") for a missing author, and `delete_account(profile)` (service role, `functions/session`) drops the takes nobody else is in, the person's comments (one others replied to stays as "[deleted]") and the profile |
| `migrations/*_social_writes.sql` | `create_take`: a take and its legs in one transaction (service role only) |
| `migrations/*_cash.sql` | Double-entry `ledger` (every transfer is a user row + a platform row that sum to 0), and the money functions: `cash_deposit`, `cash_withdraw`, `place_trade`, `cash_summary`. Service role only; each locks the user's account row so balance checks can't race. |
| `migrations/*_positions_and_selling.sql` | `positions` (shares and cost per person, take and side), the price on every trade, and `sell_position`. A take's price is `take_price()` = 1 + its return. |
| `functions/session` | Sign-in: find-or-create the user, sync their wallet, onboarding fields |
| `functions/social` | Social writes: post a take, save, follow, comment, like, edit your bio; plus `GET /saves` (saves are private). Name, handle and photo are edited through `functions/session`. |
| `functions/_shared/privy.ts` | Privy token verification |
| `migrations/*_assets.sql` | Assets: `take_legs.asset_id` (the catalog row a pick came from; older picks matched by name), `search_securities()` (ticker / name / theme search, one row per company, service role), `asset_takes(asset)` (takes holding it, any issuer; public), `search_people(query)` (public), and the `asset_charts` / `asset_pools` price-history cache |
| `functions/assets` | Asset search (`GET /assets/search?q=`: one full-text query, `search_assets`: tickers and names first, then themes and descriptions) and asset pages (`GET /assets/:id?range=1D\|1W\|1M\|1Y`: details, live price from Jupiter, history from GeckoTerminal). Everything is available to everyone for now; with `US_RESTRICTIONS=on`, things US persons can't buy are shown marked unavailable. A token whose pool is under $50k shows its stock's price, and yield rows show Jupiter Lend's live APY |
| `functions/take-builder` | Take → basket: every stock, perp and cash vault is listed in Luna's cached prompt (reasoning low), prediction markets are BM25-searched in the worker, and Luna can call `search` for a market it needs; no embeddings (100-case eval in `packages/take-builder/eval`). `source` makes a basket that copies a post, article or a fund's holdings. Also edits a basket: `mode: "edit"` with an `ask` ("add AMD", "less crypto"), `mode: "risk"` (new risk, same picks), and `include` (a take started from an asset page). `cards.ts` searches Collector Crypt live for card picks; `rules.ts` holds the house rules (one pick per name, perps at most 30% beside other picks, leverage at most 5x, 2x without a model call). Takes have no horizon: an old client's is ignored, and prediction markets resolving within a year are preferred |
| `functions/_shared/catalog.ts` | The catalog as the app shows it: display names, who can buy what, prices (the stock's price for a token under the $50k floor) and charts (scaled by the token's multiplier) |
| `migrations/*_profile_avatars.sql`, `*_drop_avatar_icon_columns.sql` | Profile photos in `profiles.avatar_url` (a built-in face, an uploaded photo, or a demo asset) and the public `avatars` bucket |
| `migrations/*_follow_privacy.sql` | Whether others can see who you follow and who follows you (counts stay public) |
| `migrations/*_trade_amounts.sql`, `*_cash_activity_paging.sql`, `*_cash_positions.sql` | Play-money trades of any amount, paged cash activity, and your positions from the ledger |
| `migrations/*_securities*.sql`, `*_match_securities_*.sql`, `*_basket_catalog.sql` | The take builder's `securities` catalog, and `basket_catalog()` (everything a basket can hold, compact, for the builder's BM25 index; a snapshot pg_cron rebuilds every 5 minutes in `basket_catalog_cache`, so workers never scan the table). `match_securities` and the `embedding` column are no longer used |
| `migrations/*_asset_search.sql` | `search_assets()`: the assets function's one full-text query over `securities.search_doc` |
| `migrations/*_live_marks.sql` | Live returns: picks' base and mark on `take_legs`, `take_stats.history_at`, `chain_positions.live_return_bps`, and `apply_marks()` (service role), which the marker calls through `functions/marks`. |
| `migrations/*_price_audit.sql` | The public `price_audit` table (each signed price's source document; a check constraint keeps sha256 = hash) and `price_events()`, a position's on-chain price events with their documents. |
| `migrations/*_catalog_fixes.sql`, `*_traded_yield_only.sql` | Picks backfilled to catalog rows where the name match is unambiguous; search and the builder offer only the Jupiter Lend yield row (what every yield pick deposits into). |
| `migrations/*_asset_bank.sql` | The asset bank's tables, for the poller's optional Supabase sink (`ASSET_BANK_SINK=supabase`) |
| `migrations/*_demo_tradeable_legs.sql` | Demo takes hold only assets that can actually be bought on Solana |
| `migrations/*_chain_events.sql` | Chain activity from the QuickNode Stream / fork relay: `chain_events` (every program event, service role only), `chain_takes` (on-chain counters per take, public), `ingest_chain_events()`, and `take_json()` showing chain numbers when a request sends `x-thesis-network` |
| `functions/quicknode-stream` | The Stream's webhook: checks QuickNode's signature (`QUICKNODE_STREAM_TOKEN`), decodes events, calls `ingest_chain_events()` (see `infra/quicknode/README.md`) |
| `tests/chain_events.sql` | Checks the ingest and the header against a scratch database (rolls back). CI runs every `tests/*.sql` on PRs that touch `supabase/` (`.github/workflows/supabase.yml`: `supabase db start`, then `psql`) |
| `migrations/*_notifications.sql` | The inbox: `notifications` (service role only) filled by triggers (someone you follow posts; a comment or reply; from chain events: your take traded or faded, a take you're in closed (its author sold) or settled, a badge) and `post_daily_positions()`; `notification_inbox()` for reads |
| `functions/open` | `GET /open?…` → a 302 into the app's URL scheme, so chat links (iMessage only taps `https`) open a take straight on its basket. Only take fields pass through |
| `functions/securities-index` | Loads the take builder's catalog into `securities` (description and themes); `unindex` marks prediction rows `thin`, out of search; `liquidity` syncs tradeable flags from the asset bank. Called by `packages/take-builder` and the asset-bank poller with `SECURITIES_INDEX_SECRET` |
| `functions/gemini` | Read-only proxy for Gemini's public prediction-market data (`GET /gemini/categories`, `/gemini/events?…`, `/gemini/events/<ticker>`), so the backend's Gemini reads leave from Supabase, not a developer's or server's own address. Needs `x-gemini-proxy-token` (`GEMINI_PROXY_TOKEN`); forwards nothing from the caller but the path and query; caches briefly; trims events to the fields Thesis reads (`docs/gemini-plan.md`) |
| `functions/notify` | The backend's daily positions digest → inbox (signed with `NOTIFY_TOKEN`, one per profile, network and day), and liquidation alerts for Phoenix legs (`{ network, alerts }`, from the fork API's check) |
| `migrations/*_liquidation_alerts.sql` | The `liquidation_risk` notification kind and `post_liquidation_alert()`: one inbox row per alert key (position, leg, level), so a leg warns once when it turns near and once when it turns close. |
| `tests/liquidation_alerts.sql` | Checks each alert is stored once per key; that none is stored for a wallet with no profile or with no key; that an unknown take is dropped from the row; and that alerts reach the inbox (rolls back) |
| `functions/social` `GET /notifications`, `POST /notifications/read` | Your inbox (chain notifications only for the `x-thesis-network` you ask for) and marking only visible rows read |
| `tests/notifications.sql` | Checks every trigger, the digest's once-a-day rule and the inbox's network filter (rolls back) |
| `tests/post_after_chain.sql` | Checks posting takes: hidden from the publishable key, live only on the author's `takeCreated`, discard and the cleanup job (rolls back) |
| `tests/chain_scores.sql` | Checks `chain_positions`, the stats against the program's rules, and the chain boards (own P&L, made for backers and faders, by dollars and by percent) with and without the header (rolls back) |
| `migrations/*_gemini_leg_names.sql` | Gemini leg names without the "?" before the contract's label, in the catalog and in takes' legs |
| `migrations/*_take_leg_name_120.sql` | Leg names up to 120 characters (long card titles and prediction names) |
| `migrations/*_web_push.sql` | Web push for `apps/www`: `push_subscriptions` (one row per browser, service role only), `web_push_secret()`, and a trigger that sends each new notification through `functions/web-push` (chain notifications for the fork's network only) |
| `functions/web-push` | Saves and removes a browser's push subscription (with the user's Privy token), and sends a notification to that person's browsers when the trigger calls it |
| `tests/web_push.sql` | Checks the trigger queues one call only for a person with a subscribed browser, and chain notifications only for the fork's network (rolls back) |
| `tests/account_deletion.sql` | Checks deleting an account: takes others are in stay with the "Deleted account" author, the rest go, comments go except an answered one (rolls back) |
| `tests/leaderboard.sql` | Checks the boards lowest first and the viewer's own rank, past the limit and off the board (rolls back) |
| `tests/take_drafts.sql` | Checks `take_draft()` says whom an X draft is for, and that the drafts table stays private (rolls back) |
| `migrations/*_badges_bucket.sql` | The public `badges` bucket: each badge's Token-2022 metadata JSON and image (`infra/badges/README.md`) |
| `seed/demo.sql` | Demo callers (Jake, Priya, …) and their takes so a new account has a feed |
| `seed/demo_trades.sql` | Real ledger trades / fades from the demo callers on the demo takes, so take pages can name who traded. Run after `demo.sql`; safe to re-run |

`take_stats.ret_pct` and its history move with the marker (`apps/executor`, every 5 minutes,
through `functions/marks`): a take's return is its author's buy-in's live return once its
entry prices are signed, else an index of its picks since posting. Trade/fade counts and money in
are real: on the fork they come from the chain.

### Retired: simulated money

The simulated-money mode is gone (decided 2026-11-18): `functions/cash` is removed, and only the
fork's on-chain trades count. Its tables and SQL functions stay so no data is dropped: the
double-entry `ledger`, `positions`, `cash_rules()`, `cash_deposit` / `cash_withdraw`,
`place_trade`, `sell_position`, `cash_summary` / `cash_activity` / `cash_positions` (all service
role only, and nothing calls the writes any more). `take_traders()` still reads the ledger, so
older play-money trades keep their names on take pages.

## Deploying

With the Supabase CLI 2.x (3.x rejects `config.toml`'s `[inbucket]`; to use 3.x, deploy from a folder holding only the function), linked to the project.

- **Migrations:** the hosted history uses MCP-assigned versions, so **never `supabase db push`** (it would re-run old ones). Apply each new migration on its own with `supabase db query --linked -f supabase/migrations/<file>.sql`, then record its version in `supabase_migrations.schema_migrations`. Additive, backward-compatible changes may go to the hosted project after local tests pass.
- **Functions:** `supabase functions deploy <name>` (all `verify_jwt = false` in `config.toml`): `session social assets take-builder open securities-index quicknode-stream notify gemini source cards marks price-audit web-push`. Preserve live changes from other branches when redeploying one.
- **Seed:** `psql "$DATABASE_URL" -f supabase/seed/demo.sql`, then `seed/demo_trades.sql` (both safe to re-run).
- **Vault** (once per project, in SQL): `select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');`. The X poll cron job and the web push trigger call functions at this URL; there is no default.
- **Secrets** (dashboard or `supabase secrets set`): the Privy keys, OpenAI, `SECURITIES_INDEX_SECRET`, `QUICKNODE_STREAM_TOKEN`, `NOTIFY_TOKEN`, `GEMINI_PROXY_TOKEN`, `MARKS_TOKEN`, `PRICE_AUDIT_TOKEN`, and for web push `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Every name, with what it's for, is in `functions/.env.example`.
