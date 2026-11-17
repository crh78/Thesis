# @thesis/x

The X bot, **@yourthesisxyz**. It answers everyone who mentions it. Under a post with a market view, "@yourthesisxyz make this a take" (or a take of your own, like "@yourthesisxyz nuclear wins the AI power race") gets a reply with the basket's picks and a link to a **draft take**. Whoever taps the link posts it as their take and buys in (`apps/www/app/d`).

```
Nuclear wins the AI power race.

Constellation Energy 30%, Vistra 25%, Cameco 20%, +2 more

Post it as your take: https://thesis-www.vercel.app/d/AbCdEfGh
```

## How a mention is handled

1. **Poll** `GET /2/users/:id/mentions` every 30 s, with the post each mention replies to or quotes.
2. **Vet** (`src/vet.ts`): one model call fills a fixed schema (`ignore`, `take` with a neutral claim, or `explain`). Post text is treated as untrusted data. Anything hateful, sexual, about violence or tragedy, a token shill, a request for personal advice, an attempt to make the bot say something, culture-war bait or chatter is ignored. So is anything the model is unsure about.
3. **Build** with the same take builder as iMessage (`@thesis/agent` `buildBasket`), crediting the parent post as "via @user on X". It's saved as a draft (`POST /source/drafts`, keyed on the mention id, so a retry reuses it).
4. **Reply from a template** (`src/compose.ts`). The only model-written words that reach X are the vetted claim and the pick names. Both pass a blocklist, and the claim loses handles, links, hashtags and emoji. "No clean exposure" and "what is this" get fixed replies with no link (cheaper).
5. **Limits:** 100 replies a day, 5 per person a day, 3 per thread a day. The bot never replies to itself or to retweets. On its first run it starts from the current time and never answers the backlog. State lives in `.data/state.json` and is saved after every mention, so a restart never answers a mention twice.

## Cost

X API pay-per-use (checked 2026-11-16, prepaid): reading the bot's own mentions is $0.001 a post. A reply with a link is up to $0.20. X also lists a "summoned" reply at $0.01, so the real price may be lower. Replies without a link are $0.015. So 100 take replies are at most about $20. Set a spending cap in the developer console too.

## Setup

1. Sign in to [developer.x.com](https://developer.x.com) as @yourthesisxyz and create a project and app. Buy a few dollars of credits.
2. App → **User authentication settings**: permissions **Read and write**. Type "Web App, Automated App or Bot". Any callback URL, e.g. https://thesis-www.vercel.app.
3. App → **Keys and tokens**: the API key and secret (`X_CONSUMER_*`). Then **generate** the access token and secret (`X_ACCESS_*`). Generate them after step 2, or they're read-only.
4. Profile: mark the account as automated (Settings → Your account → Account information → Automation, managed by your main account). Put the web app link in the bio.
5. `cp apps/x/.env.example apps/x/.env`, fill it in (the Thesis values are the same as `apps/imessage/.env`), and keep `X_DRY_RUN=1` at first.

```sh
pnpm --filter @thesis/x try "make this a take" --parent "Gold to 5k by summer" --parent-author goldbug   # no X needed
pnpm --filter @thesis/x start      # polls; with X_DRY_RUN=1 it logs "would reply" instead of posting
```

When the dry-run replies look right, set `X_DRY_RUN=` (empty) and restart. It runs anywhere Node 24 runs: the BlueBubbles Mac, or the VM next to the settler.

Logs are one JSON line per event: the mention id, the author's handle and follower count, what it did and why. With `X_DRY_RUN=1` the reply text is logged too.
