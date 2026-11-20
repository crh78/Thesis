# @thesis/x

The X bot, **@yourthesisxyz**. It answers everyone who mentions it. Under a post with a market view, "@yourthesisxyz make this a take" (or a take of your own, like "@yourthesisxyz nuclear wins the AI power race") gets a reply with the basket's picks. The basket is saved as a **draft take** for the person who asked; the reply carries **no link** (a reply with a URL costs $0.20 on X, without one $0.015), and points to the link in the bot's bio instead. When they sign in to the web app with that X account, the draft waits at the top of their feed ("Your takes from X"), and posting it makes it their take (`apps/www/app/d`). Only the person whose X account it was made for can post it.

**Commands** (replies to any post): `@yourthesisxyz` or `make this a take` (a basket, saved for you), `@yourthesisxyz <your take>`, `back $20` / `fade $20` (trade it; under a Thesis take or under the bot's own trade reply, back or fade that take; under the bot's draft reply to you, buy that exact basket), `sell` / `sell half` / `sell 25%` / `sell $20` (under the bot's reply to your trade, under a take you hold, or anywhere in the thread you traded in), `stop` / `start`. X takes always build at high risk (up to 30% in perps at up to 5x; the rest spot). Several people replying under one post with a plain command share one basket (`copy_of`: no second vetting or build for 24 hours). Someone without a Thesis account gets one reply (it points to the bio), then nothing until they sign up (`whois` asks Privy whether the X account is linked). The bot remembers what each of its replies carried, the take each person traded per thread, and the shared baskets in its state file.

**Trading from a reply:** "@yourthesisxyz back $20" (or "in for $20", "fade $50") trades from the replier's own Thesis account, within the limits they set at `/limits` (the `agent` function, Privy session signer). Under a shared Thesis take (a `/t/<id>` link in the post) it backs or fades that take. Under any other post the basket becomes the replier's take with that buy-in; for a fade, the claim is the opposite of the post's view. Someone who hasn't set limits gets the draft reply with a pointer to the bio link; over a limit, a reply saying so. Trades run only when replies really go out (`X_DRY_RUN` empty), or with `X_DRY_RUN_TRADES=1`; `X_TRADING=0` turns them off. Try it without X: `pnpm --filter @thesis/x try "back $20" --parent "Nuclear wins the AI power race" --author <you> --author-id <your X user id>` (a real trade on the fork; the reply is printed).

```
Nuclear wins the AI power race.

Constellation Energy 30%, Vistra 25%, Cameco 20%, +2 more

Saved for you: sign in with X at the link in our bio to post it as your take.
```

## How a mention is handled

1. **Poll** `GET /2/users/:id/mentions` every 30 s, with the post each mention replies to or quotes.
2. **Vet** (`src/vet.ts`): one model call fills a fixed schema (`ignore`, `take` with a neutral claim and a risk level, or `explain`). There's no timeline to vet: a take runs until its author sells, a year at most. Post text is treated as untrusted data. Anything hateful, sexual, about violence or tragedy, a token shill, a request for personal advice, an attempt to make the bot say something, culture-war bait or chatter is ignored. So is anything the model is unsure about.
3. **Build** with the same take builder as iMessage (`@thesis/agent` `buildBasket`), crediting the parent post as "via @user on X". It's saved as a draft for the asker's X username (`POST /source/drafts` with `for_x`, keyed on the mention id, so a retry reuses it). The web app reads them back through `GET /source/drafts/mine`, which takes the X username from the caller's Privy account, never from the client.
4. **Reply from a template** (`src/compose.ts`), never with a link. Take and trade replies carry the basket as a picture: the web app draws it from the draft (`/d/<id>/basket.png`: the claim, a donut of the picks with their logos and weights), the bot uploads it to X and attaches it, and posts without it if anything fails (`X_IMAGES=0` turns it off). The only model-written words that reach X are the vetted claim and the pick names. Both pass a blocklist, and the claim loses handles, links, hashtags and emoji. "No clean exposure" ("No clean way to trade that one yet. Try a sharper take.") and "what is this" get fixed replies.
5. **Opting out** (X's automation rules require it): a mention that's just "stop" gets one confirmation and no more replies, kept across days; "start" turns replies back on. The help reply says so.
6. **Limits:** 100 replies a day (`X_MAX_REPLIES_PER_DAY`), 10 per person a day (`X_MAX_PER_AUTHOR`; every reply counts: takes, "no clean exposure" and help alike), 3 per thread a day (`X_MAX_PER_THREAD`); `X_UNLIMITED` lists X usernames with no caps at all (the team's own accounts); mentions are polled every `X_POLL_SECONDS` (30). The bot never replies to itself or to retweets. On its first run it starts from the current time and never answers the backlog. State lives in `.data/state.json` and is saved after every mention, so a restart never answers a mention twice.

## What it did (telemetry)

Every event the bot logs is also saved to Supabase, in `bot_events` (migration 0061), through the source function's `POST /source/bot-events` (the same `THESIS_BOT_SECRET`). That covers every mention it handled: `replied` (with the reply's text, its X id, the mention's text, whether it had the picture, any trade), `would reply` in a dry run, `skip` with the reason (vetted out, a cap, opted out, not signed up), `reply refused` and `reply failed` (X's answer), `plan failed`, `image failed`, plus `starting`, `stopped` and `poll failed` (at most every 10 minutes). Events go out in one batch after each poll; if Supabase is down they wait for the next one, and a reply never waits on them. Rows are kept 90 days. `X_TELEMETRY=0` turns it off.

Each event about a mention also carries `data.trace`, how the bot decided: `trace.vet` is what the vetting model saw (`input`), answered (`output`, the verdict and its reason) and a summary of its reasoning (`thoughts`); `trace.build` is the take builder's verdict and picks, its reasoning summaries per round (`trace.build.trace.thoughts`), its searches and its raw picks before the house rules. OpenAI never returns the reasoning itself, only a summary, and skips it when the model barely reasoned. The traces stay out of Railway's logs.

```sql
-- The last day's replies
select at, author, what, data->>'text' as reply, data->>'mention' as mention
from bot_events where bot = 'x' and event = 'replied' and at > now() - interval '1 day' order by at desc;

-- Why it answered (or didn't) one mention
select event, what, data->'trace'->'vet'->>'reason' as vet_reason, data->'trace'->'vet'->'thoughts' as vet_thoughts,
  data->'trace'->'build'->'trace'->'thoughts' as build_thoughts, data->'trace'->'build'->'trace'->'searches' as searches
from bot_events where ref = '<mention id>';

-- What it did, by kind, this week
select event, coalesce(what, data->>'reason') as why, count(*) from bot_events
where bot = 'x' and at > now() - interval '7 days' group by 1, 2 order by 3 desc;
```

## Cost

X API pay-per-use (checked 2026-11-16, prepaid): reading the bot's own mentions is $0.001 a post. A reply with a link is up to $0.20. X also lists a "summoned" reply at $0.01, so the real price may be lower. Replies without a link are $0.015. So 100 take replies are at most about $20. Set a spending cap in the developer console too.

## Setup

**Before going live, ask X for approval.** X's automation rules say any AI reply bot needs X's prior written approval: request it from the developer console (or your X contact). Replies here are templates, but the claim and picks come from a model, so ask.

1. Sign in to [developer.x.com](https://developer.x.com) as @yourthesisxyz and create a project and app. Buy a few dollars of credits.
2. App → **User authentication settings**: permissions **Read and write**. Type "Web App, Automated App or Bot". Any callback URL, e.g. https://yourthesis.xyz.
3. App → **Keys and tokens**: the API key and secret (`X_CONSUMER_*`). Then **generate** the access token and secret (`X_ACCESS_*`). Generate them after step 2, or they're read-only.
4. Profile: mark the account as automated (Settings → Your account → Account information → Automation, managed by your main account). Put the web app link in the bio.
5. `cp apps/x/.env.example apps/x/.env`, fill it in (the Thesis values are the same as `apps/imessage/.env`), and keep `X_DRY_RUN=1` at first.

```sh
pnpm --filter @thesis/x try "make this a take" --parent "Gold to 5k by summer" --parent-author goldbug   # no X needed
pnpm --filter @thesis/x start      # polls; with X_DRY_RUN=1 it logs "would reply" instead of posting
```

When the dry-run replies look right, set `X_DRY_RUN=` (empty) and restart. It runs anywhere Node 24 runs: the BlueBubbles Mac, or the VM next to the settler.

Logs are one JSON line per event: the mention id, the author's handle and follower count, what it did and why. With `X_DRY_RUN=1` the reply text is logged too.
