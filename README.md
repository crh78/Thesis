# Thesis

Social trading built into your group chats and feeds: say a take, friends trade it or fade it in one message, and the chain keeps score.

Thesis is non-custodial: the user's own wallet does the trades and the program records a receipt in the same transaction. The on-chain work follows [`docs/onchain-plan.md`](docs/onchain-plan.md).

## Layout

| Path | What it is |
| --- | --- |
| `anchor/` | The Thesis Solana program: takes, non-custodial receipts with proof of trade, fee split, escrow for paper legs, settler prices, settlement, badges |
| `packages/chain` | TS client from the IDL: addresses, instruction builders, the transaction composer, the lookup table, event and Stream decoding |
| `packages/venues` | Venue adapters (Jupiter and Jupiter Lend, Gemini, Phoenix, Collector Crypt), the asset bank with best-issuer routing (`bank/`), and the liquidity registry (`registry/` → `docs/liquidity.md`) |
| `packages/take-builder` | The take builder's securities catalog and index; the builder itself is the `take-builder` Supabase function |
| `packages/agent` | Chat agent brain, transport-agnostic (Luna with a `build_basket` tool) |
| `apps/www` | The public web app (Vercel): feed, Scores, Search, composer, Me, Copy from X, take pages; trades on the fork with Privy |
| `apps/ios` | SwiftUI iPhone app (iOS 26): social data from Supabase, money on the fork |
| `apps/imessage` | iMessage transport: provider adapters → agent → replies |
| `apps/executor` | The settler (holds the settler key, never user funds), the asset-bank poller and the marker (live returns) |
| `apps/web` | The fork Blink (closed; code kept, unmaintained) |
| `scripts/fork` | The mainnet-fork dogfood environment and the fork API |
| `infra/executor` | The Oracle VM that runs the one shared fork and the always-on services |
| `infra/quicknode` | The QuickNode Stream filter, fixtures, and the fork relay |
| `infra/badges` | Badge images and Token-2022 metadata in Supabase Storage |
| `supabase/` | Migrations, edge functions, seed, config |
| `docs/design` | Design tokens, principles and exported assets |

Surfaces (`apps/`) stay thin; logic lives in `packages/`.

## Running it

| Part | State | How to run |
| --- | --- | --- |
| Web (`apps/www`) | The public app, live at `yourthesis.xyz` (Vercel) on the shared fork: Google, email and X sign-in, trading, posting, scores. Settings in [`apps/www/.env.example`](apps/www/.env.example) | [`apps/www/README.md`](apps/www/README.md) |
| iOS (`apps/ios`) | A development build on the team's phones (no App Store until phase 3). Social data from Supabase; trades, posting and receipts on the fork, including prediction, perp and card legs | [`apps/ios/README.md`](apps/ios/README.md) |
| iMessage (`apps/imessage`) | Sendblue or BlueBubbles → Luna agent; replies with a basket link. Trading by text isn't built | [`apps/imessage/README.md`](apps/imessage/README.md) |
| Share sheet and Copy from X (`supabase/functions/source`) | Built: shared articles and X posts become drafted takes; copied X accounts' calls arrive as one-tap takes | [`docs/share-and-copy.md`](docs/share-and-copy.md) |
| Anchor program (`anchor/`) | Built and tested; deployed on the fork, not on mainnet. Open review item: M-3 ([`docs/security-review.md`](docs/security-review.md)) | Below |
| Executor (`apps/executor`) | Runs on the VM against the fork | [`apps/executor/README.md`](apps/executor/README.md) |
| Mainnet fork (`scripts/fork`) | One shared fork on the Oracle VM; the apps reach its fork API at `https://<fork-host>` (`FORK_API_URL`) | Nothing to run for the apps. Operating it: [`infra/executor/README.md`](infra/executor/README.md), [`scripts/fork/README.md`](scripts/fork/README.md) |
| Live data (`infra/quicknode`) | Program events reach Supabase through the fork relay today, and through a QuickNode Stream on mainnet | [`infra/quicknode/README.md`](infra/quicknode/README.md) |

### iOS app

Needs Xcode 26 with the iOS 26 platform and Metal Toolchain (Xcode → Settings → Components).

```sh
brew install xcodegen
cd apps/ios && xcodegen generate && open Thesis.xcodeproj
```

Press ⌘R for the simulator, or set your team under Signing & Capabilities to run on your phone (free accounts: the app expires after 7 days). Tests: ⌘U. More in [`apps/ios/README.md`](apps/ios/README.md).

### Anchor program

Needs Rust (pinned in `anchor/rust-toolchain.toml`), the Solana CLI (Agave 4.1.2) and Anchor 1.2.2 via `avm`.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
cargo install --git https://github.com/solana-foundation/anchor --tag v1.2.2 avm --locked
avm install 1.2.2 && avm use 1.2.2

cd anchor
anchor build                                     # program and IDL
cargo test                                       # LiteSVM tests plus property tests of the math
PROPTEST_CASES=50000 cargo test --lib --release  # deeper property tests
```

After an interface change, copy `anchor/target/idl/thesis.json` and `anchor/target/types/*.ts` to `packages/chain/idl/` (CI fails if they differ); the full checklist is in [`docs/hardening-plan.md`](docs/hardening-plan.md#working-on-the-program).

### Verifiable build

`solana-verify` builds the program in a pinned Docker image (`solanafoundation/solana-verifiable-build:4.1.2`), so anyone can reproduce it and explorers can match it to a deployed program. Needs Docker.

```sh
cargo install solana-verify --version 0.5.2 --locked
cd anchor
solana-verify build --library-name thesis --base-image solanafoundation/solana-verifiable-build:4.1.2
solana-verify get-executable-hash target/deploy/thesis.so
```

CI runs it on every push to `main` and on demand (`.github/workflows/verifiable-build.yml`), with the hash in the run summary and `thesis.so` uploaded. At mainnet launch: deploy that `thesis.so`, check it with `solana-verify get-program-hash <PROGRAM_ID>`, and publish with `solana-verify verify-from-repo`.

### Checks

```sh
pnpm --filter @thesis/chain test      # also @thesis/venues, @thesis/executor, @thesis/take-builder, @thesis/fork, @thesis/x
```

CI (`.github/workflows/`) runs these, the program's build, tests, fmt and clippy, the web app's build, the edge functions' Deno checks, the iOS build on PRs touching `apps/ios/`, and the SQL tests on PRs touching `supabase/`.

Fork e2e suites run on the shared fork, on the VM ([`infra/executor/README.md`](infra/executor/README.md), "Running it"); the full list is in [`scripts/fork/README.md`](scripts/fork/README.md#commands). The usual ones:

```sh
pnpm fork:api-e2e                     # the apps' fork-mode flow over HTTP
pnpm fork:jupiter-e2e                 # Jupiter swaps + Jupiter Lend + receipts, then entry prices
pnpm fork:exit-e2e -- --settle        # partial and full sales, then settle them
pnpm fork:settler-e2e -- --move-clock # moves the fork's clock ~4 days: the fork maintainer's OK only, then restart the fork
```

## What's next

A direction, not a schedule, ordered by the three phases: a public fork, a private mainnet program, then real mainnet. The program's own steps are in [`docs/onchain-plan.md`](docs/onchain-plan.md).

### Phase 1: a public fork

Anyone signs up on the web app, replies "@yourthesisxyz back $20" under a post on X, and trades play money on the shared fork. The iOS app stays a development build on the team's phones until phase 3.

**Built and live on the fork**
- **The web app** at `yourthesis.xyz` ([`apps/www`](apps/www/README.md)): sign-in with Google, email or X; feed, Scores, Search, comments, notifications and web push, Copy from X, the composer, Me with both scores, creator fees and the $1,000 cap; an install prompt; on desktop, the phone layout with a QR code. Vercel builds production from `main` only.
- **The fork API in public** at `https://<fork-host>`, published by Caddy on the VM ([`infra/executor`](infra/executor/README.md)). The browser calls it directly, server renders read with a service key, and auth and read limits are enforced ([abuse limits](scripts/fork/README.md#abuse-limits)): a Privy token on money routes, 10 money actions a minute and 100 a day per wallet, 120 reads a minute per Privy user (else per IP), and $1,000 of play money per account with no top-ups or withdrawals.
- **No-timeline takes:** no horizon anywhere; a take runs until its author sells their buy-in, at most 365 days; the author's full sale closes it.
- **Partial sales:** sell a share of a position, or of a whole holding, by % or $, as long as $10 stays in; Buy | Sell tabs on web and iOS, swipe to sell all on the profile. An author's partial sale keeps the take open.
- **Fast trades:** builds made before the tap and refreshed until used, sent with accept-then-confirm; each token's route is kept for 10 minutes and repriced, so most builds cost one Jupiter price read or none, and a back's sell routes are seeded right after it lands. Measured: tap to "You're in" in about 0.2–0.5 s with a ready build (Privy's signing is most of it); a first build of a take ~1 s on the Developer-plan Jupiter key; Phoenix legs re-copy only Phoenix's accounts and read mainnet's makers during the build. A swap refused for slippage, or failing inside its pool, is answered `requote` and the apps build and sign it again without a tap; a tap waits up to 20 s for Jupiter rather than failing.
- **Legs:** spot and yield (Jupiter, Jupiter Lend), Gemini prediction legs and Collector Crypt card legs (paper; each card leg shows Collector Crypt's logo), Phoenix perps and shorts with liquidation warnings. At most 5 legs a take (the program allows 10) and up to 3 cards, each at most 20%, unless the take is about cards. Phoenix's mainnet traders are put back to their mainnet inventory before each Phoenix trade, so fork fills never pile up against the makers (thin markets like CoreWeave panicked before). Fade shows only when a leg can be faded, and nobody can fade their own take.
- **The X bot** ([`apps/x`](apps/x/README.md)) turns a mention into a draft take for the asker: no link in replies (they point to the bio), 10 replies per person a day, "stop" opts out. Checked end to end on 2026-11-19 (`pnpm --filter @thesis/x try`: OpenAI vetting, the take builder, a draft and the reply); its keys are in `apps/x/.env` on the owner's Mac, still in dry run (`X_DRY_RUN=1`).
- **The iMessage bot** ([`apps/imessage`](apps/imessage/README.md)) drafts takes by text: someone texts a take, it replies with the picks and a link to a draft. It runs on Railway with the X bot (one service, `thesis-bots`: [`infra/bots`](infra/bots/README.md)) on Sendblue's free line, so only DMs from up to 10 verified contacts; it made drafts on 2026-11-19 after the deploy. It doesn't trade, and group chats need a dedicated line or BlueBubbles.
- **A clean feed:** e2e suites trade only made-up takes from hidden accounts.
- **Limits checked (2026-11-18; trades load-tested 2026-11-19):** Privy's free tier (500 monthly users) is enough; Supabase is far under its free limits; Vercel stays on Hobby; the VM serves 200 concurrent readers through Caddy with no failures. Jupiter was the tightest limit: since 2026-11-19 `JUPITER_API_KEY` is on the owner's Developer plan ($25 a month, 10 requests a second per organisation), and the fork API uses it at 420 a minute (the friend's `JUPITER_TRADE_API_KEY` is retired).

**Left before opening it up**
- **Privy session signers** and the spending-limit consent screen (`apps/www/app/limits`): per-trade and daily limits the user approves once and can revoke. The X agent, auto-copy and iMessage trading all use them. (Project owner.)
- **The X reply agent trading for users** ("@yourthesisxyz back $20" or "fade $50" under any post): it reads the post, builds a basket, trades from the replier's Privy wallet within their limits, and replies with what it bought. The take is the replier's; others can back and fade it, and the replier earns the creator share. Needs the session signers, the X developer app's keys, X's written approval for an AI reply bot, and a hard monthly cap in the X console. (Project owner.)
- **The owner's agent code** (`packages/agent`): sell intents with `bps` / `usd`, and a warning when a sale closes the author's take (`closesTake`). (Done: no horizon in the agent or the X bot.) Also the Thesis MCP server.
- **Speed:** checked with `pnpm fork:load-trades` (2026-11-19, 4–5 people at once, every leg type): every trade landed and 18 of 19 sales, with no Jupiter waits; Phoenix sends queue one at a time (up to ~2 s when all 5 tap together), and a wallet's first Phoenix trade registers its Phoenix accounts (2–5 s, during the sheet's prebuild in the apps).
- **Dogfood** every screen at phone and desktop width and every trade path (back, fade, partial and full sale, cash-out, claims; spot, yield, perp, prediction and card legs) on web and iOS, including Phoenix on a phone (the liquidation alert hasn't fired on the fork, which can't move a price that far).
- **Track records** (required for phase 1): "@yourthesisxyz score @handle" scores an X account's posted calls as baskets priced at posting time, forward only.
- **Auto-copy** (required for phase 1): Thesis backs a copied account's new calls within the user's limits (one-tap copying is built: [`docs/share-and-copy.md`](docs/share-and-copy.md)).
- **iMessage trading** (required for phase 1; today the bot only drafts): create, back and fade by text through the session signers. Also **share to Messages**: a link shared to the Thesis contact becomes a drafted take through the `source` function. It's the public share path, since iOS won't list a web app in the share sheet. (The BlueBubbles adapter is built but untested on a real install.)
- **Cards** (required for phase 1): tune the take builder so it reliably reaches for the card search on a card take ([`docs/cards-plan.md`](docs/cards-plan.md)).
- **The X bot live:** its X keys, `OPENAI_API_KEY` and `THESIS_BOT_SECRET` set on the Railway `bots` service (with `X_STATE_FILE=/data/x-state.json`), a dry run there, X's approval for an AI reply bot (requested 2026-11-19), then `X_DRY_RUN` emptied and the $10 monthly cap raised.
- **Open the fork:** resets are allowed until it's public; from then, none ([resets](scripts/fork/README.md#resets)).

**Also in phase 1**
- **The Thesis MCP server:** score an account, build a take from a post, back, fade, sell and list positions, within the user's limits.
- **X cost limits:** read each post once and share the result; track an account only once someone scores or copies it; fetch only posts that look like calls; cache share results per URL.

### Phase 2: a private mainnet program

No users and no money in; a real program ID and real activity ([launch checklist](docs/onchain-plan.md#mainnet-launch-checklist)). The project owner holds the upgrade authority, and the SOL for the deploy is ready.
- Deploy the program (about 5–10 SOL of rent, refundable by closing it), `init_config`, and the upgrade authority on a separate safe key.
- A QuickNode Stream on the mainnet program, delivering to the `quicknode-stream` webhook ([`infra/quicknode`](infra/quicknode/README.md)).
- One or two team trades (spot and yield legs only, from a wallet eligible for xStocks; the settler on a fresh key), so the explorer and the Stream show activity.
- Optional (either could live on the fork instead): X calls on-chain (the settler posts a Merkle root over batches of scored calls, so a call survives its post being deleted); agent spending limits enforced by the Thesis program.

### Phase 3: real mainnet

- The native iOS app on the App Store (the Apple Developer Program is paid then, not before). Until then the team's development builds aren't rebuilt (deferred 2026-11-19: the web app is the product for phase 1); the next one comes from `main` against the fork host (`FORK_API_URL = https:/$()/<fork-host>`), on a Mac with an Apple ID in Xcode, and picks up stopped-trade recovery, the 5-pick cap, "Finding assets that match" and Collector Crypt's logo on card legs.
- Money in: USDC over CCTP, and an Apple Pay onramp. Withdrawals and an offramp.
- The mainnet gate: the whole product (UI, backend, AI, iMessage) dogfooded on the fork first.
- Security: a fuller outside review; the settler key in OCI Vault; the upgrade authority on a multisig, with a separate allowlist key.
- Phoenix registration by a non-US person or entity, and optionally a builder account ([`docs/phoenix-plan.md`](docs/phoenix-plan.md)).
- Rules for real money: geoblocking (`US_RESTRICTIONS=on` brings back the old rule); labels for paper legs so paper gains never look withdrawable, or real Gemini orders.
- The QuickNode Stream for everything, deployed from the program's commit.
- More chat surfaces (Telegram, Discord, WhatsApp).

### Account-owner setup

- **X developer app: done (2026-11-19).** Pay-per-use credits ($40), a $10 monthly cap (raise it when the bot goes live), the app owned by @yourthesisxyz with read and write tokens, the account marked automated, and X's approval for an AI reply bot requested. Left: the bot account's OAuth 1.0a access token and secret, `OPENAI_API_KEY` and `THESIS_BOT_SECRET` (the Vault's `bot_secret`) in `apps/x/.env` on the machine that runs the bot, then a dry run (`X_DRY_RUN=1`).
- **Privy: done.** Sign-in with X and session signers are on.

### Open decisions

| When | Decision |
|---|---|
| Phase 3 | Fees on small X trades: below about $50 the 10 bps fee doesn't cover X and AI costs (~$0.05 a trade). A flat fee, a higher rate, or a higher minimum? |
| Phase 3 | The iMessage provider (BlueBubbles is built) and the Apple Pay onramp |
| Phase 3 | Paper-leg labels and geoblocking |

### Settled

- **Product:** the name is Thesis; two scores instead of a formula (own P&L and made for backers, by dollars or percent, plus a faders board); a flat 5 bps creator share on every back and fade, no performance boost.
- **Takes:** no timeline. A take runs until its author sells, at most 365 days; the author's full sale closes it and settles its headline result, and backers keep their positions until they sell. A partial sale must leave at least $10.
- **Pricing:** Gemini quotes from best bid and ask only; token first with no band, from Jupiter and Alpaca only; tradeable means a $50k pool and under 1% impact on a $100 buy; a take's live return follows its author's signed entry prices; every signed price's source document is public in `price_audit`.
- **Costs:** no paid plans for now (Jupiter, Vercel and Supabase stay free, and their use is cut instead); the fork reads mainnet through the owner's QuickNode Build plan.
- **Phase 1:** web first; 10 bot replies per person a day plus a monthly cap; X-reply takes are normal takes earning the replier the creator share; $1,000 of play money with no top-ups; no resets while public; one link-free reply to people who haven't signed up; iMessage trading and the MCP server in phase 1; sharing to the Thesis contact in Messages as the public share path; the bot is @yourthesisxyz.
