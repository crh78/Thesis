# @thesis/imessage

iMessage surface. Inbound message → `@thesis/agent` → reply. When someone states a take, the agent builds its basket and replies with the picks and a link to a **draft take** on the web app (`/d/<id>`, with a link preview). A bot can't post a take as someone, so whoever taps the link signs in and posts it as theirs. Once it's live, the same link opens the take, where anyone in the chat can trade or fade it. To share a take that's already posted, share its link from the app. It also trades by text for whoever texts it ("make this a take for $20", "I'm in for $50 on Jake's take", "fading Jake for $25", "sell half my nuclear take"), from their own account within the limits they set at `/limits` (`@thesis/agent`, the `agent` function). The first time, it texts back a one-time link to connect the number. Every trade waits for a yes: the bot answers "On it. Like this message or reply yes to confirm: back @jake's take \"gold to 5k\" with $50." A like or love tapback (BlueBubbles reports them; on Sendblue, if it passes them through) or "yes" from the same person in the same chat runs it within 10 minutes; "no" drops it. The reply comes once the fork accepts the trade. `IMESSAGE_TRADING=0` turns trading off. Outbound group updates ("Sarah just backed Jake's take") aren't built yet.

- `src/providers/` — one adapter per iMessage API provider, so it can be swapped if one gets blocked: [Sendblue](https://docs.sendblue.com) (`sendblue.ts`, the default) and [BlueBubbles](https://bluebubbles.app) (`bluebubbles.ts`, free, works in group chats). `IMESSAGE_PROVIDER` picks one.
- `src/types.ts` — the transport-neutral `Inbound` / `Handler` / `Provider` shapes.
- `src/reply.ts` — hands each message to `@thesis/agent` (Luna + the `build_basket` tool).
- `src/contact-card.ts` — the Thesis contact card (name and `assets/thesis-contact.png`) for Sendblue's Contact Sharing.

## Using it

The bot runs on Railway with the iMessage and X bots together (`infra/bots/README.md`). Its line is **+1 (347) 268-9632**.

1. **Get added.** Sendblue's free plan replies only to verified contacts, up to 10. Someone with the Sendblue login runs `npx @sendblue/cli add-contact +1XXXXXXXXXX`.
2. **Text the number once.** That verifies you. The first reply includes the Thesis contact card, so save it.
3. **Text it a take** in plain words, like "AI power demand is underrated", "Eli Lilly keeps winning on GLP-1s" or "Tesla is overvalued". You can add a risk ("high risk") or a horizon ("over a year"). If you don't, it uses medium risk and 3 months.
4. **It replies** with one line on what has to be true and up to 5 picks (`Name 40%: why`). It ends with a link to a **draft take**. If nothing you can buy goes up when the take is right, it says so instead of guessing.
5. **Tap the link and sign in.** The draft becomes your take: change the picks or the amount, then post it and buy in. Anyone you send the link to after that sees the live take and can back it or fade it.

You can also just ask it things ("what's a fade?", "why Nvidia?"). It answers in a sentence or two and keeps track of the conversation. A reply with a basket can take up to about 20 seconds. The bot never buys or posts anything itself; nothing happens until someone taps the link and posts.

**Doesn't work yet:** group chats (they need a paid dedicated line, or BlueBubbles below), trading by text, and texting from a number that isn't verified (the bot doesn't see those messages).

**If it stops replying:** check `railway logs --service bots` (lines start with `[imessage]`). Don't start the bot on your laptop while Railway runs it. Both copies would poll the same line and reply to every text twice.

## Group chats for free: BlueBubbles

Sendblue's free line can't join group chats. BlueBubbles is a free, open-source server that runs on a Mac signed into Messages and exposes it over a REST API, so the bot can read and reply in any chat that Apple ID is in, groups included.

1. **A Mac that stays awake**, signed into Messages with the **bot's own Apple ID** (make a new one, e.g. thesis.bot@icloud.com). Don't use your personal Apple ID: the bot would read your chats and reply in DMs as you. A separate macOS user account works if the Mac is shared; keep it logged in (fast user switching).
2. Install the server from [bluebubbles.app/install](https://bluebubbles.app/install) and go through its setup. Give it Full Disk Access and Accessibility when it asks. Set a server password. The Private API isn't needed: sending to existing chats uses AppleScript.
3. Add the bot's Apple ID to a group chat (or text it to start a DM).
4. In `apps/imessage/.env`: `IMESSAGE_PROVIDER=bluebubbles`, `BLUEBUBBLES_URL=http://localhost:1234` (the server's port) and `BLUEBUBBLES_PASSWORD`. Run the bot on the same Mac (`pnpm --filter @thesis/imessage start`).

In a group the agent replies only when addressed ("thesis", "@thesis"), asked something, or someone states a take worth a basket. Typing bubbles and the contact card are Sendblue-only.

## Running it (Sendblue)

Production runs on Railway (`infra/bots/README.md`). Run it locally only with Railway's copy off (`BOTS_IMESSAGE=0` on the `bots` service), for the reason above.

Sendblue free plan: a number shared with other free accounts, and only verified contacts (up to 10, each texts the number once) can reach the bot. Group chats need a dedicated line (AI Agent plan, $100/mo). The free plan has no webhooks, so the adapter polls for new messages every 2 s and needs no public URL.

```sh
npx @sendblue/cli setup --phone +1XXXXXXXXXX     # one text verifies you and creates the account
npx @sendblue/cli show-keys                      # → SENDBLUE_API_KEY / SENDBLUE_API_SECRET
npx @sendblue/cli lines                          # → SENDBLUE_FROM_NUMBER
cp apps/imessage/.env.example apps/imessage/.env # fill in the above + OpenAI / take-builder values
pnpm install
pnpm --filter @thesis/imessage start             # or: dev (restarts on file changes)
```

Add a tester: `npx @sendblue/cli add-contact +1XXXXXXXXXX`, then they text the number once to verify.

Try the agent without iMessage: `pnpm --filter @thesis/agent chat "AI power demand is underrated"` (add `--group` to see group behaviour).

Logs are one JSON line per event; message bodies are never logged and handles are masked to the last 4 digits.

`assets/thesis-contact.png` is the leaf mark sized for a contact photo, for Sendblue's Contact Sharing (name and photo) once we're on a dedicated line.
