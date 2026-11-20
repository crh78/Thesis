# @thesis/imessage

The iMessage bot: inbound message → `@thesis/agent` → reply. Live on Railway with the X bot ([`infra/bots`](../../infra/bots/README.md)) on Sendblue's free line. Built, not dogfooded yet.

- **Baskets:** someone states a take, the agent replies with the picks and a link to a **draft take** (`/d/<id>`, with a link preview); whoever taps it signs in and posts it as theirs, and once it's live the same link opens the take.
- **Trading by text:** "make this a take for $20", "I'm in for $50 on Jake's take", "fading Jake for $25", "sell half my nvidia take", "my positions", from the texter's own account within the limits they set at `/limits` (the `agent` function, Privy session signer). A first-time number gets a one-time link to connect it.
- **Every trade waits for a yes:** "On it. Like this message or reply yes to confirm: back @jake's take "gold to 5k" with $50." A like or love tapback, or "yes", from the same person in the same chat within 10 minutes runs it; "no" drops it. BlueBubbles reports tapbacks; whether Sendblue passes them through is unchecked (unusual message types are logged as `inbound type`), so "yes" is the sure way. The reply comes once the fork accepts the trade.
- `IMESSAGE_TRADING=0` turns trading off. Not built: outbound group updates ("Sarah just backed Jake's take").

## Code

- `src/providers/`: one adapter per provider, so one can be swapped if it's blocked: [Sendblue](https://docs.sendblue.com) (`sendblue.ts`, the default) and [BlueBubbles](https://bluebubbles.app) (`bluebubbles.ts`, works in group chats). `IMESSAGE_PROVIDER` picks one.
- `src/types.ts`: the transport-neutral `Inbound` / `Handler` / `Provider` shapes, and tapback parsing.
- `src/reply.ts`: hands each message to `@thesis/agent`.
- `src/contact-card.ts`: the Thesis contact card (name and `assets/thesis-contact.png`), sent once per DM, since shared lines can't show our name and photo.

Logs are one JSON line per event; message bodies are never logged and handles are masked to the last 4 digits.

## Running it (Sendblue)

Free plan: a number shared with other free accounts; only verified contacts (up to 10, each texts the number once) reach the bot, DMs only (group chats need a dedicated line, the AI Agent plan at $100/mo). No webhooks on the free plan, so the adapter polls every 2 s and needs no public URL. Don't run it locally while Railway runs it: both would reply.

```sh
npx @sendblue/cli setup --phone +1XXXXXXXXXX     # one text verifies you and creates the account
npx @sendblue/cli show-keys                      # → SENDBLUE_API_KEY / SENDBLUE_API_SECRET
npx @sendblue/cli lines                          # → SENDBLUE_FROM_NUMBER
npx @sendblue/cli add-contact +1XXXXXXXXXX       # a tester; they text the number once to verify
cp apps/imessage/.env.example apps/imessage/.env # the above, plus OpenAI and the Thesis values
pnpm --filter @thesis/imessage start
```

Try the agent without iMessage: `pnpm --filter @thesis/agent chat "AI power demand is underrated"` (`--group` for group behaviour; `--as +1555…` trades from the account that number is connected to).

## Group chats for free: BlueBubbles

A free server on a Mac signed into Messages, exposing it over a REST API, so the bot can read and reply in any chat that Apple ID is in, groups included. Untested on a real install.

1. A Mac that stays awake, signed into Messages with the **bot's own Apple ID** (never your personal one: the bot would read your chats and reply as you).
2. Install the server from [bluebubbles.app/install](https://bluebubbles.app/install), grant Full Disk Access and Accessibility, set a server password. The Private API isn't needed.
3. Add the bot's Apple ID to a group chat (or text it).
4. In `apps/imessage/.env`: `IMESSAGE_PROVIDER=bluebubbles`, `BLUEBUBBLES_URL=http://localhost:1234`, `BLUEBUBBLES_PASSWORD`; run the bot on that Mac.

In a group the agent replies only when addressed ("thesis", "@thesis"), asked something, or someone states a take worth a basket. Typing bubbles and the contact card are Sendblue-only.
