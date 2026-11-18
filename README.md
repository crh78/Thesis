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
| `apps/ios` | SwiftUI iPhone app (iOS 26) on the Supabase backend, with a fork mode for on-chain trades |
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
| Web (`apps/www`) | The full public app on the shared fork (Google and email sign-in; X sign-in behind `NEXT_PUBLIC_X_LOGIN`). Settings in [`apps/www/.env.example`](apps/www/.env.example) | [`apps/www/README.md`](apps/www/README.md) |
| iOS (`apps/ios`) | Live on Supabase (sign-in, feed, social, inbox, take builder, asset pages, play money). Fork mode runs trades, posting and receipts on the fork, including prediction, perp and card legs | [`apps/ios/README.md`](apps/ios/README.md) |
| iMessage (`apps/imessage`) | Sendblue or BlueBubbles → Luna agent; replies with a basket link. Trading by text isn't built | [`apps/imessage/README.md`](apps/imessage/README.md) |
| Share sheet and Copy from X (`supabase/functions/source`) | Built: shared articles and X posts become drafted takes; copied X accounts' calls arrive as one-tap takes | [`docs/share-and-copy.md`](docs/share-and-copy.md) |
| Anchor program (`anchor/`) | Built and tested; deployed on the fork, not on mainnet. Open review item: M-3 ([`docs/security-review.md`](docs/security-review.md)) | Below |
| Executor (`apps/executor`) | Runs on the VM against the fork | [`apps/executor/README.md`](apps/executor/README.md) |
| Mainnet fork (`scripts/fork`) | One shared fork on the Oracle VM; the apps reach its fork API through `FORK_API_URL` | Nothing to run for the apps. Operating it: [`infra/executor/README.md`](infra/executor/README.md), [`scripts/fork/README.md`](scripts/fork/README.md) |

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
pnpm --filter @thesis/chain test      # also: @thesis/venues, @thesis/executor, @thesis/fork (CI runs all four)
```

Fork e2e suites run on the shared fork, on the VM ([`infra/executor/README.md`](infra/executor/README.md), "Running it"):

```sh
pnpm fork:api-e2e                     # the apps' fork-mode flow over HTTP
pnpm fork:jupiter-e2e                 # Jupiter swaps + Jupiter Lend + receipts, then entry prices
pnpm fork:exit-e2e -- --settle        # sell a position, then settle it at the sale
pnpm fork:gemini-e2e                  # prediction legs: escrow, fades, sales, settler prices
pnpm fork:phoenix-api-e2e -- --settle # Phoenix perps and shorts: back, fade, liquidation warnings, sales, cash-out, settlement
node scripts/fork/cards-e2e.ts        # card legs: escrow, fade leaves the card out, sale returns the escrow
pnpm fork:settler-e2e -- --move-clock # moves the fork's clock ~4 days: the fork maintainer's OK only, then restart the fork
```

## What's next

A direction, not a schedule; the on-chain steps follow [`docs/onchain-plan.md`](docs/onchain-plan.md).

### Testing and dogfooding

UI, latency and trade testing across the web app, the iOS app and the fork: every screen at phone and desktop width, every trade path (back, fade, sell, cash-out, claims; spot, yield, perp, prediction and card legs), timings for each step, and a team dogfood on the fork.

**Latency and quota notes**
- **Jupiter is the tightest limit.** The asset bank runs at 25 requests a minute, and builds share it. Options:
  - a higher Jupiter plan, or more API keys/accounts if Jupiter's terms allow it;
  - QuickNode's Swap API (Metis) instead of Jupiter's own key (a paid add-on on a QuickNode plan);
  - another data source for reads that don't need Jupiter (prices, token data).
- **Helius** (the fork's mainnet source, free plan, 1M credits a month): Surfpool never remembers a missing account and forwards every `getProgramAccounts` scan, so code that looks up deleted accounts or scans in a loop spends credits fast.
  - Option: QuickNode (paid, already used by the asset bank) as `FORK_DATASOURCE_RPC_URL`, after checking its credit cost per method and its `getProgramAccounts` limits.
- **Trade times on the fork:** post ~3–3.6 s, fade 2.9 s, sale 0.8 s.

### Phase 1: a public fork

Anyone can sign up, reply "@yourthesisxyz back $20" under a post on X, and trade play money on the shared fork. Public users come in through the web app; the iOS app runs only as a development build on the team's phones until phase 3.

**Needed before opening it up**
- **Production launch:** mostly done. The web app is live on Vercel at `yourthesis.xyz`, `FORK_API_PROXY_KEY` is set in Vercel and on the VM, and the fork API's auth enforces (a Privy token on every money call). Still to do: a production deploy that picks up the proxy key and `NEXT_PUBLIC_X_LOGIN`, a phone test of production, then `FORK_API_READ_LIMIT=enforce` on the VM.
- **The web app as the public product** (`apps/www`): built: the iOS look and tabs, desktop with a QR code, Google and email sign-in, Me with both scores and the $1,000 cap, feed, leaderboards, Search, comments, notifications, Copy from X, install prompt, web push, the composer, card legs, and the Privy token on fork money calls. Still to do:
  - X login: on in Privy, and `NEXT_PUBLIC_X_LOGIN=on` is set in Vercel (live with the next deploy);
  - the spending-limit consent screen (`apps/www/app/limits`, built with the session signers);
  - the read limit's switch to enforce, once production has the proxy key.
- **X reply agent** (replaces the Blink): "@thesis back $20" or "@thesis fade $50" under any X post. It reads the post, builds a basket with the take builder, trades from the replier's Privy wallet within their limits, and replies with what it bought. The take is the replier's, quoting the post; others can back and fade it, and the replier earns the creator share. Replies carry no link (X charges $0.20 for a reply with a URL, $0.015 without); someone who hasn't signed up gets one reply pointing to the link in the bot's bio.
- **Privy session signers:** per-trade and daily limits the user approves once and can revoke. The X agent, auto-copy and iMessage all use them.
- **Abuse limits** (built; see [`scripts/fork/README.md`](scripts/fork/README.md#abuse-limits)):
  - a Privy token on the fork API's money endpoints, in report mode until enforced after the production deploy; a service key for the X agent;
  - $1,000 of play money per account, no top-ups, no withdrawals;
  - rate limits: 10 money actions a minute and 100 a day per wallet, "busy" when the shared Jupiter key is backed up, 120 reads a minute per IP (logged only until the production proxy sends the visitor's IP);
  - the X bot answers each person at most 10 times a day (every reply counts), 3 times per thread and 100 times in total (`apps/x`); still to do: a hard monthly cap in the X console.
- **No resets once it's public:** no program changes and no clock-moving suites while it's open. Policy in [`scripts/fork/README.md`](scripts/fork/README.md#resets).
- **A clean feed:** done (e2e suites trade only made-up takes from hidden accounts).
- **Own-take fades:** the fork API refuses fading your own take; the program-level check waits for the next program change.
- **Phoenix:** dogfooded in the simulator. The liquidation alert wasn't triggered, since the fork can't move a price that far.
- **Check the limits:** Helius credits, Privy's free tier, a hard monthly cap in the X console, the VM's capacity.

**Also on the fork**
- **Collector Crypt cards: built and live** ([`docs/cards-plan.md`](docs/cards-plan.md)): paper legs priced at CC's insured value, any card CC prices, never faded. A take about cards can be all cards; any other take at most one card at 20%. **Later: tune the AI**, which doesn't always reach for the card search on a card take.
- **Track records:** "@thesis score @handle" scores an X account's posted calls as baskets priced at posting time, forward only.
- **Auto-copy:** Thesis backs a copied account's new calls within the user's limits (one-tap copying is built).
- **Share to Messages (the public share path):** iOS won't list a web app in the share sheet and the native extension needs the App Store, but Messages is always there. A link shared to the Thesis contact becomes a drafted take through the `source` function, and the agent replies with it. Part of iMessage trading.
- **Web domain: done:** `yourthesis.xyz` serves the web app.
- **X cost limits:** read each post once and share the result; track an account only once someone scores or copies it; fetch only posts that look like calls; cache share-sheet results per URL.
- **iMessage trading:** create, back and fade by text through the session signers (the BlueBubbles adapter is built but untested on a real install); also takes shared links.
- **Thesis MCP server:** score an account, build a take from a post, back, fade, sell and list positions, within the user's limits.
- **Perp limits: done:** a 30% perp cap beside other picks, one pick per name, a leverage ceiling per horizon.

### Phase 2: a private mainnet program

No users and no money in; just a real program ID and real activity ([launch checklist](docs/onchain-plan.md#mainnet-launch-checklist)).
- Deploy the program (about 5–10 SOL of rent, refundable by closing it), `init_config`, and the upgrade authority on a separate safe key.
- A QuickNode Stream filtered on the mainnet program, delivering to the `quicknode-stream` webhook ([`infra/quicknode`](infra/quicknode/README.md)).
- One or two team trades (spot and yield legs only, from a wallet eligible for xStocks; the settler on a fresh key), so the explorer and the Stream show activity.
- Optional (either could live on the fork instead):
  - X calls on-chain: the settler posts a Merkle root over batches of scored calls, so a call survives its post being deleted;
  - agent spending limits enforced by the Thesis program.

### Phase 3: real mainnet

- The native iOS app on the App Store.
- Money in: USDC over CCTP, and an Apple Pay onramp.
- The mainnet gate: the whole product dogfooded on the fork first.
- Security: a fuller review; the settler key in OCI Vault; the upgrade authority in cold storage or a multisig, with a separate allowlist key.
- Phoenix registration by a non-US person or entity, and optionally a builder account ([`docs/phoenix-plan.md`](docs/phoenix-plan.md)).
- Rules for real money: geoblocking (`US_RESTRICTIONS` brings back the old rule); labels for paper legs so paper gains never look withdrawable, or real Gemini orders.
- The QuickNode Stream for everything, deployed from the program's commit.
- Withdrawals and an offramp.
- More chat surfaces (Telegram, Discord, WhatsApp).

### Account-owner setup

- **X developer app:** pay-per-use credits, a hard monthly cap in the X console, and the bot's handle.
- **Privy: done:** sign-in with X and session signers are on.
- **Phoenix on a phone:** dogfood it with a development build.

### Open decisions

| When | Decision |
|---|---|
| Phase 3 | Fees on small X trades: below about $50 the 10 bps fee doesn't cover X and AI costs (~$0.05 a trade). A flat fee, a higher rate, or a higher minimum? |
| Phase 3 | The iMessage provider (BlueBubbles is built) and the Apple Pay onramp |
| Phase 3 | Paper-leg labels and geoblocking |

### Settled

- **Product:** the name is Thesis; two scores instead of a formula (own P&L and made for backers, by dollars or percent, plus a faders board); no creator performance boost (a flat 5 bps on every back and fade).
- **Pricing:** Gemini quotes from best bid and ask only; token first with no band, from Jupiter and Alpaca only; tradeable means a $50k pool and under 1% impact; a take's live return follows its author's signed entry prices; every signed price's source document public in `price_audit`.
- **Phase 1:** web first; 10 bot replies per user per day plus a monthly cap; X-reply takes are normal takes earning the replier the creator share; $1,000 of play money with no top-ups; no resets while public; one link-free reply to people who haven't signed up; iMessage trading and the MCP server in phase 1; sharing to the Thesis contact in Messages as the public share path; the bot is @yourthesisxyz.
- **Mainnet:** the upgrade authority is held by the project owner, with the SOL for the deploy ready.
