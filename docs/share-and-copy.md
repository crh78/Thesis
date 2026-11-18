# Takes from what you read, and copying X accounts

Share articles and X posts into Thesis, and copy X accounts. Built: the share sheet and **one-tap copy** (an account's calls become takes you approve). Not built: auto-copy. X posts come through **Apify** for now.

## Share sheet → a take

1. **`apps/ios/ThesisShare`** (the "Thesis" / "Thesis Dev" share extension) gathers the link, the page title, and in Safari the selection or article text (`Preprocess.js`), then opens `yourthesis(-dev)://take/new?read=<url>&title=…&text=…`.
2. **The app** (`TakeLink.read` → `CreateFlow` → `ReadingView`) fetches the page on the phone (news sites turn servers away), strips scripts, and sends it to **`POST functions/v1/source`**. A cold start waits for sign-in first.
3. **`source`** (`_shared/source.ts`) reads X posts through X's public oEmbed (no key) and articles from the page (og tags and paragraphs), then one fast model call drafts `{ claim, risk, is_call }` (no horizon: a take runs until its author sells). The composer opens on it, credited.
4. **Posting** calls `POST source/attach`, which sets `takes.source_url/label/kind` (author only, once). `take_json` returns `source`, shown as "via …" on the take page, the basket and the web page.

The native extension needs the App Store (phase 3); until then the public share path is sharing to the Thesis contact in Messages (see the README's "What's next").

## Copy from X

- **Search → Traders on X** (`XCopyView` on iOS, `app/(tabs)/x` on the web): add `@handle`. The first person to copy an account reads its last three weeks (one Apify run, ~$0.003).
- **Every 15 minutes** pg_cron calls `POST source/poll` (header `x-poll-secret`, from the Vault). One Apify search covers every copied account, and none runs when nobody copies anyone. Each new post gets a drafted take; posts that make a call (`is_call`) notify everyone copying the account (`x_call`, trigger `x_calls_notify`), only for posts after they started copying.
- **Tapping a call** (list, inbox or notification) opens the composer with the basket built and credited to the post. Buying in and posting is still your tap.
- **Limit:** 10 copied accounts per person (`MAX_COPIED`; the 11th answers `copy_limit`).

Tables (`migrations/0032_sources_and_x_copy.sql`): `x_accounts`, `x_follows`, `x_calls`, service role only. Cron and secrets: `migrations/0033_x_poll_cron.sql`.

## Setup

- **Apify token** in the Vault as `apify_token` (or `APIFY_TOKEN` as a function secret). To replace it: `select vault.update_secret((select id from vault.secrets where name = 'apify_token'), '<token>');`. Without one, copying a new account answers "isn't switched on yet".
- The actor is `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` ($0.22 per 1,000 posts, with a minimum per run). It scrapes X against X's terms: move `fetchPosts` in `_shared/x.ts` to the official X API before launch.
- **Project URL** in the Vault as `project_url` (`select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');`): the poll cron job calls the `source` function at this URL.
- Deploy: `supabase functions deploy source` (one function serves every route above).

## Not built

- **Auto-copy** (buying for you when a call lands, within your limits) needs Privy session signers with a spending policy.
- **Track records** ("@thesis score @handle"): each copied account's calls scored as baskets priced at posting time, forward only. Each `x_calls` row already has the drafted take and its time.
