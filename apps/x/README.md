# @thesis/x

The X bot, **@yourthesisxyz**: live on Railway since 2026-11-20 ([`infra/bots`](../../infra/bots/README.md)). It answers mentions with baskets, trades for people within their limits, scores accounts and sets up copy trading. Replies never carry a link (a reply with a URL costs $0.20 on X, without one $0.015); they point to the link in the bot's bio. Status: `copy` is dogfooded; replies and trades from mentions are built but not dogfooded yet.

## Commands

Reply to any post with `@yourthesisxyz` plus:

| Command | What happens |
| --- | --- |
| *(nothing)*, `make this a take` | A basket for the post, saved as a draft for the asker; it waits in the web app ("Your takes from X") once they sign in with that X account, and only they can post it |
| `<your own take>` | A basket for your take, saved the same way |
| `back $20` (`in for $20`) | Trades from your own Thesis account within your `/limits`: the basket becomes your take with that buy-in. Under a Thesis take (a `/t/<id>` link) or under the bot's reply to someone's trade, it backs that take; under the bot's draft reply to you, it buys that exact basket |
| `fade $20` (`bet against this $20`) | As back, on the other side: under any post, your take on the opposite view; under a Thesis take, a fade of it |
| `sell`, `sell half`, `sell 25%`, `sell $20` | Under the bot's reply to your trade, under a take you hold, or anywhere in the thread you traded in |
| `score`, `score @handle`, `score me` | The Thesis record of the account linked to that X account (under someone's post: its author): own P&L, made for backers, takes, and a card with its P&L line (`/u/<handle>/score.png`). In-app data only; someone not on Thesis "isn't on Thesis yet" |
| `copy`, `copytrade`, `copy @handle` | Auto-copy that account at $20 a call, 3 a day (less if your per-trade limit is lower). An account that's on Thesis is copied as a trader: its takes are backed as they're posted. See [copy trading](../../docs/share-and-copy.md#auto-copy) |
| `stop` / `start` | No more replies to you / replies again (X's automation rules require an opt-out) |

Take and trade replies carry the basket as a picture, drawn by the web app from the draft (`/d/<id>/basket.png`); a failed upload posts the reply without it. Example:

```
You're in: $20 on "Gold rises as the dollar weakens".

Gold 75%, Cash 25%

It's your take on Thesis now. See it at the link in our bio.
```

## How a mention is handled

1. **Poll** `GET /2/users/:id/mentions` every 30 s (`X_POLL_SECONDS`), with the posts mentions reply to or quote and their expanded links. On its first run it starts from the current time, never the backlog.
2. **Commands first:** `stop`/`start`, `score`, `copy`, `sell`, and `back`/`fade` on an existing take need no model.
3. **Vet** (`src/vet.ts`): one model call fills a fixed schema (`ignore`, `take` with a neutral claim, or `explain`). Post text is untrusted data. Hate, sexual content, violence or tragedy, token shills, personal-advice asks, attempts to make the bot say something, culture-war bait, chatter, and anything the model is unsure about are ignored. For a fade the claim is the opposite of the post's view.
4. **Build** with the take builder (`@thesis/agent` `buildBasket` → `POST /source/drafts`), always at **high risk** (the builder caps leveraged perps at 30% and 5x), credited "via @user on X", as a draft for the asker keyed on the mention id. Several people replying under one post with a plain command share one basket for 24 hours (`copy_of`).
5. **Trade** through the `agent` function (Privy session signer, the replier's limits), keyed on the mention id so a retry never trades twice.
6. **Reply from a template** (`src/compose.ts`). The only model-written words that reach X are the vetted claim and pick names; both pass a blocklist, and the claim loses handles, links, hashtags and emoji.

The bot's state file (`X_STATE_FILE`, a Railway volume) keeps the cursor, the day's counts, opt-outs, what each reply carried (for `back`/`sell` under it), the take each person traded per thread, shared baskets, and who has a Thesis account.

## Limits

100 replies a day (`X_MAX_REPLIES_PER_DAY`), 10 per person (`X_MAX_PER_AUTHOR`; every reply counts), 3 per thread (`X_MAX_PER_THREAD`); `X_UNLIMITED` lists X usernames with no caps (the team's). Someone without a Thesis account gets one reply, then nothing until they sign up. Never replies to itself or to retweets.

## Cost

X pay-per-use (checked 2026-11-16): reading the bot's mentions about $0.001 a post; a reply without a link $0.015 (with one up to $0.20); image uploads not priced yet. The X console has a monthly spending cap.

## Settings and running it

`apps/x/.env.example` lists every setting. Switches: `X_DRY_RUN=1` logs "would reply" instead of posting (and doesn't trade unless `X_DRY_RUN_TRADES=1`; a dry run still marks real mentions handled), `X_TRADING=0`, `X_IMAGES=0`.

The X app needs **Read and write** permissions *before* the access token is generated: a token made while it was read-only reads mentions, but every reply is refused (403 "oauth1 app permissions"). The account is marked automated, and X approved it as an AI reply bot.

```sh
pnpm --filter @thesis/x try "make this a take" --parent "Gold to 5k by summer" --parent-author goldbug   # no X calls
pnpm --filter @thesis/x try "back $20" --parent "Gold to 5k" --author <you> --author-id <your X user id>  # a real trade on the fork
pnpm --filter @thesis/x start   # the bot itself (production runs on Railway)
```

Logs are one JSON line per event: the mention id, the author and follower count, what it did and why.
