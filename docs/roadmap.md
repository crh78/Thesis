# Roadmap

A direction, not a schedule, ordered by the three phases: a public fork, a private mainnet program, then real mainnet. The program's own steps are in [`docs/onchain-plan.md`](onchain-plan.md).

## Phase 1: a public fork

Anyone signs up on the web app, replies "@yourthesisxyz back $20" under a post on X, and trades play money on the shared fork. The iOS app stays a development build on the team's phones until phase 3.

**Built and live on the fork**
- **The web app** at `yourthesis.xyz` ([`apps/www`](../apps/www/README.md)): sign-in with Google, email or X; feed, Scores, Search, comments, notifications and web push, Copy from X, Copy trading, trading-by-text limits, the composer, Me with both scores, creator fees and the $1,000 cap; an install prompt; on desktop, the phone layout with a QR code. Vercel builds production from `main` only.
- **The fork API in public** at `https://<fork-host>`, published by Caddy on the VM ([`infra/executor`](../infra/executor/README.md)). The browser calls it directly, server renders read with a service key, and auth and read limits are enforced ([abuse limits](../scripts/fork/README.md#abuse-limits)): a Privy token on money routes, 10 money actions a minute and 100 a day per wallet, 120 reads a minute per Privy user (else per IP), and $1,000 of play money per account with no top-ups or withdrawals.
- **No-timeline takes:** no horizon anywhere; a take runs until its author sells their buy-in, at most 365 days; the author's full sale closes it.
- **Inverted takes:** a bearish take ("crypto sucks") is built as the basket it's against and posted inverted: the author and everyone who agrees hold the short side (Phoenix shorts, the other side of prediction legs), and anyone who disagrees holds the basket long. Every leg must be shortable, so no cash or cards. The apps show "Betting against these" and an Against pill; the bots reply "Betting against: …".
- **Partial sales:** sell a share of a position, or of a whole holding, by % or $, as long as $10 stays in; Buy | Sell tabs on web and iOS, swipe to sell all on the profile. An author's partial sale keeps the take open.
- **Speed checked** with `pnpm fork:load-trades` (2026-11-19, 4–5 people at once, every leg type): every trade landed and 18 of 19 sales, with no Jupiter waits; Phoenix sends queue one at a time (up to ~2 s when all 5 tap together), and a wallet's first Phoenix trade registers its Phoenix accounts (2–5 s, during the sheet's prebuild in the apps).
- **Fast trades:** builds made before the tap and refreshed until used, sent with accept-then-confirm; each token's route is kept for 10 minutes and repriced, so most builds cost one Jupiter price read or none, and a back's sell routes are seeded right after it lands. Measured: tap to "You're in" in about 0.2–0.5 s with a ready build (Privy's signing is most of it); a first build of a take ~1 s on the Developer-plan Jupiter key; Phoenix legs re-copy only Phoenix's accounts and read mainnet's makers during the build. A swap refused for slippage, or failing inside its pool, is answered `requote` and the apps build and sign it again without a tap; a tap waits up to 20 s for Jupiter rather than failing.
- **Legs:** spot and yield (Jupiter, Jupiter Lend), Gemini prediction legs and Collector Crypt card legs (paper; each card leg shows Collector Crypt's logo), Phoenix perps and shorts with liquidation warnings. At most 5 legs a take (the program allows 10) and up to 3 cards, each at most 20%, unless the take is about cards. Phoenix's mainnet traders are put back to their mainnet inventory before each Phoenix trade, so fork fills never pile up against the makers (thin markets like CoreWeave panicked before). Fade shows only when a leg can be faded, and nobody can fade their own take.
- **Trading by text** (2026-11-19/20): a user allows Thesis's Privy session signer once on the limits screen (`/limits`: per-trade and daily limits, revocable), and the `agent` function trades for them within those limits (`supabase/functions/agent`: limits checked under a lock, the fork API builds, the session signer signs). The X and iMessage bots and auto-copy use it; the MCP server will too. Limits go up to $1,000 a trade and a day; the owner's account has $10,000 of play money and limits (`FORK_DEPOSIT_CAP_OVERRIDES`, `AGENT_LIMIT_OVERRIDES`).
- **The X bot** ([`apps/x`](../apps/x/README.md)), live as @yourthesisxyz since 2026-11-20: "make this a take" (a draft for the asker), "back $20" / "fade $20" (a take of their own with that buy-in, or a back or fade of a Thesis take or of the bot's own reply), "sell" / "sell half" / "sell $20", "score" / "score @handle" (the Thesis record of the account linked to that X account: own P&L, made for backers, takes, and a P&L-chart card), and "copy" (auto-copy that account). Built and live; `copy` is dogfooded, replies and trades from mentions aren't yet. Replies carry no link (they point to the bio) but carry the basket or score card as a picture. X takes always build at high risk; several repliers under one post share one basket; someone without a Thesis account gets one reply; 10 replies per person a day (`X_UNLIMITED` for the team). Takes made from X show a "Take from X ↗" tag linking to the post.
- **The iMessage bot** ([`apps/imessage`](../apps/imessage/README.md)) drafts baskets and trades by text: "make this a take for $20", "I'm in for $50 on Jake's take", "fading Jake for $25", "sell half my nvidia take", "my positions". A first-time number gets a one-time link to connect it on `/limits`; every trade waits for a like or "yes" ("On it. Like this message or reply yes to confirm: …"). It runs on Railway with the X bot (one service, `thesis-bots`: [`infra/bots`](../infra/bots/README.md)) on Sendblue's free line, so only DMs from up to 10 verified contacts; group chats need a dedicated line or BlueBubbles. Built and live, not dogfooded yet.
- **Copy trading** ([`docs/share-and-copy.md`](share-and-copy.md#auto-copy)), dogfooded end to end on 2026-11-20: auto-copy an X account (each new call becomes your own take, kept out of the feeds) or a Thesis trader (their new takes are backed), $20 a call and 3 a day by default, fully automatic within your limits. Set it on Copy from X, in the Copy trading tab, with Copy on a profile, or by replying "@yourthesisxyz copy". The X poll (Apify) reads auto-copied accounts every 15 minutes and the rest hourly.
- **A clean feed:** e2e suites trade only made-up takes from hidden accounts.
- **Limits checked (2026-11-18; trades load-tested 2026-11-19):** Privy's free tier (500 monthly users) is enough; Supabase is far under its free limits; Vercel stays on Hobby; the VM serves 200 concurrent readers through Caddy with no failures. Jupiter was the tightest limit: since 2026-11-19 `JUPITER_API_KEY` is on the owner's Developer plan ($25 a month, 10 requests a second per organisation), and the fork API uses it at 420 a minute.

**Left before opening it up**
- **Dogfood the bots:** on X, a real "back $10" mention with the basket picture (the first image upload), "sell" under the bot's reply, "score" under a post, and a second account backing the first's take; on iMessage, connecting a number, a trade confirmed by "yes" and one by a like (whether Sendblue passes tapbacks through is unchecked).
- **Basket size:** since the take builder's #150 ("picks that move with the take, or none"), many baskets have a single pick (an NVIDIA take is NVIDIA alone, with AMD, Broadcom and Micron tradeable). A two-line prompt change (2–5 picks when several listed names move with the take) is proposed; check with its author first.
- **Dogfood** every screen at phone and desktop width and every trade path (back, fade, partial and full sale, cash-out, claims; spot, yield, perp, prediction and card legs) on web and iOS, including Phoenix on a phone (the liquidation alert hasn't fired on the fork, which can't move a price that far).
- **Share to Messages:** a link shared to the Thesis contact becomes a drafted take through the `source` function. It's the public share path, since iOS won't list a web app in the share sheet. (The BlueBubbles adapter is untested on a real install.)
- **Cards** (required for phase 1): tune the take builder so it reliably reaches for the card search on a card take ([`docs/cards-plan.md`](cards-plan.md)).
- **Open the fork:** resets are allowed until it's public; from then, none ([resets](../scripts/fork/README.md#resets)).

**Also in phase 1**
- **The Thesis MCP server:** score an account, build a take from a post, back, fade, sell and list positions, within the user's limits.
- **X cost limits:** done so far: one basket per post shared by every replier, accounts read only while someone copies them (hourly unless auto-copied), scores from in-app data only (no X reads). Left: cache share results per URL; move the X reads from Apify (which scrapes against X's terms) to X's API before mainnet.

## Phase 2: a private mainnet program

No users and no money in; a real program ID and real activity ([launch checklist](onchain-plan.md#mainnet-launch-checklist)). The project owner holds the upgrade authority, and the SOL for the deploy is ready.
- Deploy the program (about 5–10 SOL of rent, refundable by closing it), `init_config`, and the upgrade authority on a separate safe key.
- A QuickNode Stream on the mainnet program, delivering to the `quicknode-stream` webhook ([`infra/quicknode`](../infra/quicknode/README.md)).
- One or two team trades (spot and yield legs only, from a wallet eligible for xStocks; the settler on a fresh key), so the explorer and the Stream show activity.
- Optional (either could live on the fork instead): X calls on-chain (the settler posts a Merkle root over batches of scored calls, so a call survives its post being deleted); agent spending limits enforced by the Thesis program.

## Phase 3: real mainnet

- The native iOS app on the App Store (the Apple Developer Program is paid then, not before). Until then the team's development builds aren't rebuilt (deferred 2026-11-19: the web app is the product for phase 1); the next one comes from `main` against the fork host (`FORK_API_URL = https:/$()/<fork-host>`), on a Mac with an Apple ID in Xcode, and picks up inverted takes, stopped-trade recovery, the 5-pick cap, "Finding assets that match" and Collector Crypt's logo on card legs.
- Money in: USDC over CCTP, and an Apple Pay onramp. Withdrawals and an offramp.
- The mainnet gate: the whole product (UI, backend, AI, iMessage) dogfooded on the fork first.
- Security: a fuller outside review; the settler key in OCI Vault; the upgrade authority on a multisig, with a separate allowlist key.
- Phoenix registration by a non-US person or entity, and optionally a builder account ([`docs/phoenix-plan.md`](phoenix-plan.md)).
- Rules for real money: geoblocking (`US_RESTRICTIONS=on` brings back the old rule); labels for paper legs so paper gains never look withdrawable, or real Gemini orders.
- The QuickNode Stream for everything, deployed from the program's commit.
- More chat surfaces (Telegram, Discord, WhatsApp).

## Account-owner setup

- **X developer app: done, and the bot is live (2026-11-20).** Pay-per-use credits ($40), the app owned by @yourthesisxyz with Read and Write permissions (the access token was regenerated after setting them), the account marked automated, X's approval for an AI reply bot granted, and the monthly cap raised.
- **Privy: done.** Sign-in with X and session signers are on; the session signer's authorization key is registered in the Privy app and set in Supabase (`PRIVY_AUTHORIZATION_KEY`, `PRIVY_SIGNER_ID`).

## Open decisions

| When | Decision |
|---|---|
| Phase 3 | Fees on small X trades: below about $50 the 10 bps fee doesn't cover X and AI costs (~$0.05 a trade). A flat fee, a higher rate, or a higher minimum? |
| Phase 3 | The iMessage provider (BlueBubbles is built) and the Apple Pay onramp |
| Phase 3 | Paper-leg labels and geoblocking |

## Settled

- **Product:** the name is Thesis; two scores instead of a formula (own P&L and made for backers, by dollars or percent, plus a faders board); a flat 5 bps creator share on every back and fade, no performance boost.
- **Takes:** no timeline. A take runs until its author sells, at most 365 days; the author's full sale closes it and settles its headline result, and backers keep their positions until they sell. A partial sale must leave at least $10.
- **Pricing:** Gemini quotes from best bid and ask only; token first with no band, from Jupiter and Alpaca only; tradeable means a $25k pool and under 1% impact on a $100 buy; a take's live return follows its author's signed entry prices; every signed price's source document is public in `price_audit`.
- **Costs:** paid plans only where needed: the owner's QuickNode Build plan (the fork's mainnet reads) and Jupiter's Developer plan ($25 a month); Vercel, Supabase and Privy stay on free tiers (use is cut instead); X is pay-per-use credits; Apify draws on its own account for X reads.
- **Phase 1:** web first; 10 bot replies per person a day plus a monthly cap; X takes build at high risk; scores come from in-app data only; copy trading is automatic within limits; X-reply takes are normal takes earning the replier the creator share; $1,000 of play money with no top-ups; no resets while public; one link-free reply to people who haven't signed up; iMessage trading and the MCP server in phase 1; sharing to the Thesis contact in Messages as the public share path; the bot is @yourthesisxyz.
