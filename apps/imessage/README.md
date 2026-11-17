# @thesis/imessage

iMessage surface. Inbound message → `@thesis/agent` → reply. When someone states a take, the agent builds its basket and replies with the picks and a link to a **draft take** on the web app (`/d/<id>`, with a link preview). A bot can't post a take as someone, so whoever taps the link signs in and posts it as theirs. Once it's live, the same link opens the take, where anyone in the chat can trade or fade it. To share a take that's already posted, share its link from the app. Trading by text (back and fade within spending limits) and outbound group updates ("Sarah just backed Jake's take") aren't built yet.

- `src/providers/` — one adapter per iMessage API provider, so it can be swapped if one gets blocked: [Sendblue](https://docs.sendblue.com) (`sendblue.ts`, the default) and [BlueBubbles](https://bluebubbles.app) (`bluebubbles.ts`, free, works in group chats). `IMESSAGE_PROVIDER` picks one.
- `src/types.ts` — the transport-neutral `Inbound` / `Handler` / `Provider` shapes.
- `src/reply.ts` — hands each message to `@thesis/agent` (Luna + the `build_basket` tool).
- `src/contact-card.ts` — the Thesis contact card (name and `assets/thesis-contact.png`) for Sendblue's Contact Sharing.

## Group chats for free: BlueBubbles

Sendblue's free line can't join group chats. BlueBubbles is a free, open-source server that runs on a Mac signed into Messages and exposes it over a REST API, so the bot can read and reply in any chat that Apple ID is in, groups included.

1. **A Mac that stays awake**, signed into Messages with the **bot's own Apple ID** (make a new one, e.g. thesis.bot@icloud.com). Don't use your personal Apple ID: the bot would read your chats and reply in DMs as you. A separate macOS user account works if the Mac is shared; keep it logged in (fast user switching).
2. Install the server from [bluebubbles.app/install](https://bluebubbles.app/install) and go through its setup. Give it Full Disk Access and Accessibility when it asks. Set a server password. The Private API isn't needed: sending to existing chats uses AppleScript.
3. Add the bot's Apple ID to a group chat (or text it to start a DM).
4. In `apps/imessage/.env`: `IMESSAGE_PROVIDER=bluebubbles`, `BLUEBUBBLES_URL=http://localhost:1234` (the server's port) and `BLUEBUBBLES_PASSWORD`. Run the bot on the same Mac (`pnpm --filter @thesis/imessage start`).

In a group the agent replies only when addressed ("thesis", "@thesis"), asked something, or someone states a take worth a basket. Typing bubbles and the contact card are Sendblue-only.

## Running it (Sendblue)

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
