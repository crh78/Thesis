# @thesis/agent

The chat agent brain, independent of transport, and the client the bots use to trade.

- **The agent** (`src/index.ts`): one OpenAI Responses call per inbound message (Luna, low effort), with tools. `build_basket` turns a take into a **draft take** through the `source` function's `POST /source/drafts` (bot secret: `THESIS_BOT_SECRET`) and answers its page (`WEB_URL/d/<id>`). Trade tools (`src/tools.ts`): `post_take` (a basket as the sender's take with a buy-in), `back_take`, `fade_take`, `sell_position` (all, a percent or dollars), `my_positions`. Each chat remembers its last few drafts and take links, so "Jake's take" resolves.
- **Trades wait for a yes** (`src/confirm.ts`): a trade tool sets the trade up and checks the sender is connected and within limits; the bot asks "On it. Like this message or reply yes to confirm: …"; a like/love tapback or "yes" runs it with no model call. Not connected: a one-time connect link. Over a limit: the take's link to do it by hand. Trades are keyed on the message id, so a redelivery never trades twice.
- **The agent client** (`src/trade.ts`): the `agent` function's bot routes (`whois`, `links`, `trades`, `positions`, `takes`, `score`, `copy`), used by the iMessage bot and the X bot (which also uses `buildBasket`, with its own vetting and reply templates).

Used by `apps/imessage` and `apps/x`.

```sh
pnpm --filter @thesis/agent chat "AI power demand is underrated"            # --group for group behaviour
pnpm --filter @thesis/agent chat --as +15555550100 "make this a take for $20: gold to 5k"   # real trades on the fork
```
