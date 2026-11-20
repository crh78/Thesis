# supabase

Migrations, edge functions, seed data and config for the `thesis` project (`https://<project-ref>.supabase.co`). Auth is Privy, not Supabase Auth: clients read with the publishable key, and every write goes through an edge function that verifies the Privy access token (`privy-token` header) and uses the service role.

Migrations are numbered `0001_<name>.sql` onward; a new one takes the next number. Below, `*_name` means the migration of that name.

## Database

### People and social

| Migrations | What they do |
|---|---|
| `*_profiles`, `*_ensure_account`, `*_explicit_grants` | Users: `profiles` (public) and `accounts` (private) |
| `*_social` | Takes and their legs, follows, saves (private), comments, comment likes, and the stats tables |
| `*_social_reads` | SQL read functions the apps call directly (`/rest/v1/rpc/<name>`): `feed`, `following_feed`, `trending`, `search_takes`, `take_comments`, `followers`, `following`, `leaderboard`, … Each returns one screen's data as JSON |
| `*_social_writes` | `create_take`: a take and its legs in one transaction (service role only) |
| `*_suggested_follows` | `suggested_follows(profile)`: people to follow, ranked by who the people you follow follow, who follows you, then followers / cash made / recent takes, each with a `reason` ("Followed by @priya and 2 others") |
| `*_take_traders` | `take_traders(take, viewer)`: who traded or faded a take and how much (you first, then people you follow, then recent) |
| `*_profile_avatars`, `*_drop_avatar_icon_columns` | Profile photos in `profiles.avatar_url` (a built-in face, an uploaded photo, or a demo asset) and the public `avatars` bucket |
| `*_follow_privacy`, `*_follows_private` | Whether others can see who you follow and who follows you (counts stay public); the `follows` table itself is service role only, so lists go through the `social` function |
| `*_leaderboard_dir_viewer` | `leaderboard(period, limit, board, sort, dir, viewer)`: `dir` `asc` ranks lowest first; with a `viewer` profile id the answer is `{ rows, viewer: { rank, cash, pct, person } \| null }` |
| `*_account_deletion` | Deleting an account keeps the takes others are in: `takes.author_id` and `comments.author_id` are `on delete set null`, reads show `deleted_person_json()` ("Deleted account"), and `delete_account(profile)` (service role, `functions/session`) drops the takes nobody else is in, the person's comments (one others replied to stays as "[deleted]") and the profile |
| `*_card_images` | Called-it card pictures the apps share as links (public `cards` bucket, written by `functions/cards`); the web page `/c/<take>?card=<id>` uses one as its preview |

### Takes, posting and drafts

| Migrations | What they do |
|---|---|
| `*_post_after_chain` | `takes.status` (`posting` / `live`): a fork-mode take is visible only to its author until its on-chain `takeCreated` makes it live. `take_for_chain(id)` (the fork API's read), `posting_takes`, `discard_posting_take`; an hourly pg_cron job deletes posting takes older than 24 hours |
| `*_take_for_chain_author_wallet` | `take_for_chain` also returns the author's wallet, so the fork API refuses to put a real user's take back on-chain under a stand-in author after a reset |
| `*_go_live_by_take`, `*_claim_hash_author` | `takeCreated` makes exactly one posting take live: the one whose author wallet, claim hash and `horizonEnd` (its `settles_at`) all match, or none. An on-chain take is linked only to its own author's take |
| `*_live_takes_only` | Every read asks for live takes itself, so posting takes stay hidden even from reads the `social` function runs with the service role |
| `*_author_sale_closes` | No-timeline takes: `create_take` ignores the horizon (every take is `12mo`, `settles_at` = posting + 365 days). The author's sale closes the take: `takeClosed` sets `chain_takes.closed_at`, `takeSettled` sets `settled_at`, and `take_json()` adds `closed_at`, `settled` and `settled_at`. Holders with open positions get a `take_closed` notification; `apply_marks()` freezes a closed take's return |
| `*_inverted_takes` | Takes that bet against their basket: `takes.inverted`, set by `create_take` and matched by the go-live check. The database keeps literal on-chain sides and flips them on read for inverted takes (`take_json` backs and fades, the backer and fader scores, the faders board, "faded your take" notifications); a leg's `ret` stays the basket's own move |
| `*_take_drafts`, `*_take_drafts_for_x`, `*_take_draft_for_x` | Draft takes from the chat bots (`/d/<id>` on the web). An X draft is saved for the asker's X username (`for_x`) and listed only to them; `take_draft()` says whom it's for, and only that account can post it |
| `*_take_leg_name_120`, `*_gemini_leg_names` | Leg names up to 120 characters; Gemini leg names without the "?" before the contract's label |
| `*_sources_and_x_copy`, `*_x_poll_cron` | Takes from what you read and copying X accounts: `x_accounts`, `x_follows`, `x_calls` (service role only) and the X poll (pg_cron every 15 minutes; accounts nobody auto-copies are read hourly) ([`docs/share-and-copy.md`](../docs/share-and-copy.md)) |

### Trading by text and copy trading

| Migrations | What they do |
|---|---|
| `*_agent_grants`, `*_agent_limits_10k` | `agent_grants` (each account's session-signer wallet, per-trade and daily limits, linked X account and iMessage handle), `agent_links` (one-time iMessage connect links), `agent_trades` and `agent_spent()`, all service role only, for `functions/agent`. The table allows limits up to $10,000; the function holds everyone else to $1,000 (`AGENT_LIMIT_OVERRIDES`) |
| `*_copy_trading` | Auto-copy: `x_follows.auto*`, `trader_follows`, `copy_jobs` queued by triggers and run by the pg_cron job `copy-run` (every minute → `functions/agent` `POST /agent/copy-run`), `x_calls.draft_id` (one basket per call, shared by every copier), `takes.auto_copy` (kept out of the feeds), and the `copy_done` / `copy_skipped` notifications |

### Chain data and scores

| Migrations | What they do |
|---|---|
| `*_chain_events` | Chain activity from the QuickNode Stream or the fork relay: `chain_events` (every program event, service role only), `chain_takes` (on-chain counters per take, public), `ingest_chain_events()`, and `take_json()` showing chain numbers when a request sends `x-thesis-network` ([`infra/quicknode`](../infra/quicknode/README.md)) |
| `*_chain_scores` | `chain_positions` (one row per on-chain position, kept from `chain_events`) and `chain_wallet_stats(network, since)`. With the `x-thesis-network` header, `leaderboard()` and `person_json()` use on-chain P&L, and only profiles with on-chain activity are on the board |
| `*_two_scores` | The second score: `chain_backer_stats(network, since)`, what everyone who backed an author's takes made, net of losses, without fades or the author's own positions. `leaderboard(…, board, sort)` takes a board (`own` or `backers`) and a sort (`cash` or `pct`) |
| `*_fader_board` | `chain_fader_stats(network, since)`, what each wallet made fading other people's takes; `leaderboard()` accepts the board `faders` |
| `*_partial_sales` | `chain_position_parts` (one row per partial sale, from `positionPartSold` and `partSettled`), `chain_positions.remaining` / `settled_stake` / `realized_pnl`, and `chain_realizations(network, since)` (settled partial sales plus final settlements, each at its own settle time), which every score reads. A position is one win when its parts' P&L plus its final P&L is above zero. `price_audit` takes moment `part` with `part_seq` |
| `*_live_marks` | Live returns: picks' base and mark on `take_legs`, `take_stats.history_at`, `chain_positions.live_return_bps`, and `apply_marks()`, which the marker calls through `functions/marks` |
| `*_price_audit` | The public `price_audit` table (each signed price's source document; a check keeps sha256 = hash) and `price_events()`, a position's on-chain price events with their documents |
| `*_badges_bucket` | The public `badges` bucket: each badge's Token-2022 metadata JSON and image ([`infra/badges`](../infra/badges/README.md)) |

`take_stats.ret_pct` and its history move with the marker (`apps/executor`, every 5 minutes): a take's return is its author's buy-in's live return once its entry prices are signed, else an index of its picks since posting. Trade and fade counts and money in come from the chain.

### Notifications

| Migrations | What they do |
|---|---|
| `*_notifications` | The inbox: `notifications` (service role only) filled by triggers (someone you follow posts; a comment or reply; from chain events: your take traded or faded, a take you're in closed or settled, a badge) and `post_daily_positions()`; `notification_inbox()` for reads |
| `*_liquidation_alerts` | The `liquidation_risk` kind and `post_liquidation_alert()`: one inbox row per position, leg and level, so a leg warns once when it turns near and once when it turns close |
| `*_web_push` | Web push for `apps/www`: `push_subscriptions` (service role only), `web_push_secret()`, and a trigger that sends each new notification through `functions/web-push` (chain notifications for the fork's network only) |

### Catalog and assets

| Migrations | What they do |
|---|---|
| `*_securities*`, `*_match_securities_*`, `*_basket_catalog`, `*_basket_catalog_cache` | The take builder's `securities` catalog, and `basket_catalog()` (everything a basket can hold, compact, for the builder's BM25 index; a snapshot pg_cron rebuilds every 5 minutes in `basket_catalog_cache`). `match_securities` and the `embedding` column are no longer used |
| `*_assets` | `take_legs.asset_id` (the catalog row a pick came from), `search_securities()`, `asset_takes(asset)`, `search_people(query)`, and the `asset_charts` / `asset_pools` price-history cache |
| `*_asset_search`, `*_search_speed` | `search_assets()`: the assets function's one full-text query over `securities.search_doc`; indexes that make ticker and name search fast |
| `*_catalog_fixes`, `*_traded_yield_only`, `*_prediction_expiry` | Picks backfilled to catalog rows; only the Jupiter Lend yield row is offered; a prediction market needs an expiry to be offered, and resolved ones are marked thin |
| `*_asset_bank` | The asset bank's tables, for the poller's optional Supabase sink (`ASSET_BANK_SINK=supabase`) |
| `*_demo_tradeable_legs` | Demo takes hold only assets that can actually be bought on Solana |

### Retired: simulated money

The simulated-money mode and `functions/cash` are gone; only the fork's on-chain trades count. Its tables and functions (`*_cash`, `*_cash_activity_paging`, `*_trade_amounts`, `*_cash_positions`, `*_positions_and_selling`: `ledger`, `positions`, `place_trade`, …) stay so no data is dropped; nothing writes them. `take_traders()` still reads the ledger, so older trades keep their names on take pages.

## Edge functions

All have `verify_jwt = false` in `config.toml` and check their own caller.

| Function | What it does |
|---|---|
| `session` | Sign-in: find-or-create the user, sync their wallet, onboarding fields, name, handle and photo, account deletion |
| `social` | Social writes (post a take, save, follow, comment, like, bio), `GET /saves`, the follow lists, and the inbox (`GET /notifications`, `POST /notifications/read`; chain notifications only for the `x-thesis-network` you ask for) |
| `assets` | Asset search (`GET /assets/search?q=`) and asset pages (`GET /assets/:id?range=1D\|1W\|1M\|1Y`: details, live price from Jupiter, history from GeckoTerminal; a token under the $25k pooled-liquidity floor shows its stock's price; yield rows show Jupiter Lend's live APY). With `US_RESTRICTIONS=on`, things US persons can't buy are marked unavailable |
| `take-builder` | Take → basket: every stock, perp and cash vault in a cached prompt, prediction markets BM25-searched in the worker, and a `search` tool for a market the model needs; no embeddings. Also edits a basket (`mode: "edit"` with an `ask`, `mode: "risk"`, `include`), copies a post, article or fund (`source`), and searches Collector Crypt live for cards (`cards.ts`). House rules in `rules.ts` ([`packages/take-builder`](../packages/take-builder/README.md)) |
| `source` | Takes from what you read (`POST /source`, `/source/attach`), copying X accounts (`/source/x`, the pg_cron `/source/poll`), and the chat bots' drafts (`POST /source/drafts` with `x-bot-secret`, `GET /source/drafts/mine`, `PUT /source/drafts/:id`) |
| `quicknode-stream` | The Stream's webhook: checks QuickNode's signature (`QUICKNODE_STREAM_TOKEN`), decodes events, calls `ingest_chain_events()` |
| `marks` | The marker's way in (`MARKS_TOKEN`): calls `apply_marks()` |
| `price-audit` | Publishes the settler's price documents to `price_audit` (`PRICE_AUDIT_TOKEN`), recomputing each hash first |
| `notify` | The fork API's daily positions digest → inbox (`NOTIFY_TOKEN`, one per profile, network and day), and liquidation alerts for Phoenix legs |
| `gemini` | Read-only proxy for Gemini's public prediction-market data (`/gemini/categories`, `/gemini/events?…`, `/gemini/events/<ticker>`), so Gemini reads leave from Supabase, not a developer's or server's address. Needs `x-gemini-proxy-token` (`GEMINI_PROXY_TOKEN`); caches briefly; trims events to the fields Thesis reads ([`docs/gemini-plan.md`](../docs/gemini-plan.md)) |
| `securities-index` | Loads the take builder's catalog into `securities`; `unindex` marks prediction rows thin; `liquidity` syncs tradeable flags from the asset bank. Called with `SECURITIES_INDEX_SECRET` |
| `web-push` | Saves and removes a browser's push subscription (with the user's Privy token), and sends a notification to that person's browsers when the trigger calls it |
| `cards` | Uploads a called-it card picture (`privy-token`), so a shared link previews as the card |
| `agent` | Trading by text within the limits a user approved once on the web app's `/limits` screen, through a Privy session signer: the user's routes (`/agent/grant`, `/agent/copies`, `/agent/links/:token`, Privy token) and the bots' routes (`x-bot-secret`: `/agent/trades`, `/agent/whois`, `/agent/positions`, `/agent/score`, `/agent/copy`, `/agent/links`, and `/agent/copy-run` for pg_cron). Trades go to the fork API with its `agent` service key |
| `open` | `GET /open?…` → a 302 into the app's URL scheme, so chat links (iMessage only taps `https`) open a take on its basket |

Shared code is in `functions/_shared/` (`privy.ts` token checks, `catalog.ts` the catalog as the apps show it, `source.ts` and `x.ts`, and `thesis-idl.json`, a copy of the program's IDL that a `packages/chain` test keeps equal).

## Tests

`tests/*.sql` run against a scratch database and roll back. CI runs all of them on PRs that touch `supabase/` (`.github/workflows/supabase.yml`: `supabase db start`, then `psql`), plus the Deno checks and tests of the functions.

| Test | Checks |
|---|---|
| `chain_events.sql` | The ingest and the `x-thesis-network` header |
| `chain_scores.sql` | `chain_positions`, the stats against the program's rules, and the chain boards (own P&L, made for backers and faders, by dollars and percent) with and without the header, partial sales included |
| `post_after_chain.sql` | Posting takes: hidden from the publishable key, live only on the author's `takeCreated`, discard and the cleanup job |
| `notifications.sql` | Every trigger, the digest's once-a-day rule and the inbox's network filter |
| `liquidation_alerts.sql` | Each alert stored once per key; none for a wallet with no profile or no key; alerts reach the inbox |
| `web_push.sql` | The trigger queues one call only for a person with a subscribed browser, chain notifications only for the fork's network |
| `account_deletion.sql` | Takes others are in stay with the "Deleted account" author, the rest go; comments go except an answered one |
| `leaderboard.sql` | Boards lowest first and the viewer's own rank, past the limit and off the board |
| `take_drafts.sql` | `take_draft()` says whom an X draft is for; the drafts table stays private |
| `agent_grants.sql` | The per-trade and daily limits (never on sales), one trade per surface + ref, revoked grants, private tables |
| `copy_trading.sql` | Auto-copy jobs queued once per copier and call or take, claimed once, the daily count, auto-copied takes out of the feeds |
| `search_securities.sql` | `search_securities` answers exactly as its slower predecessor did |

## Seed

`seed/demo.sql`: demo callers (Dev, Johnny, Nina, Priya and Danny) and their takes, so a new account has a feed. `seed/demo_cast.sql` moves a database seeded with the earlier cast (Jake, Lena, Mo, Kai) to this one. `seed/demo_trades.sql`: ledger trades and fades from the demo callers on the demo takes, so take pages can name who traded; run after `demo.sql`. Both are safe to re-run.

## Deploying

Changes to the hosted project are applied from this repo. Additive, backward-compatible changes may go to the hosted project after local tests pass; tell the project owner each time.

- **CLI:** Supabase CLI 3.x, run from a folder without the repo's `supabase/config.toml` (its `[inbucket]` key is rejected by 3.x).
- **Migrations:** the hosted history uses MCP-assigned versions, so **never `supabase db push`** (it would re-run old ones). Apply each new migration on its own with `supabase db query --remote=<project-ref> --yes -f <absolute path to supabase/migrations/<file>.sql>`, then record its version in `supabase_migrations.schema_migrations`.
- **Functions:** `supabase functions deploy <name>`: `session social assets take-builder source quicknode-stream marks price-audit notify gemini securities-index web-push cards open agent`. Deploy `quicknode-stream` from the same commit as the program, so its IDL matches. Preserve live changes from other branches when redeploying one.
- **Seed:** `psql "$DATABASE_URL" -f supabase/seed/demo.sql`, then `seed/demo_trades.sql`.
- **Vault** (in SQL, `select vault.create_secret('<value>', '<name>');`): `project_url` (`https://<project-ref>.supabase.co`; the pg_cron jobs and the web push trigger call functions at this URL, with no default), `bot_secret` and `x_poll_secret` (migrations create random ones; the bots and `functions/source` must use the same values), and `apify_token` (set by hand). `web_push_secret` is made by its migration.
- **Secrets** (dashboard or `supabase secrets set`): every name, with what it's for, is in `functions/.env.example` (Privy, OpenAI, the shared tokens, VAPID, the X and Apify keys, the agent's session signer and fork API service key).
