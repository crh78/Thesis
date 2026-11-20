# Thesis iOS

SwiftUI app for iOS 26, using native Liquid Glass. Design spec: [`docs/design`](../../docs/design/README.md).

The public product in phase 1 is the web app ([`apps/www`](../www/README.md)). Until phase 3 (the paid Apple Developer Program, then the App Store), this app runs only as a development build on the team's own phones; free builds expire every 7 days.

## Setup

```sh
brew install xcodegen          # once
cd apps/ios
cp Config/Backend.local.xcconfig.example Config/Backend.local.xcconfig   # once; fill in Supabase URL and key
cp Config/Privy.local.xcconfig.example Config/Privy.local.xcconfig       # once; fill in Privy app and client ID
cp Config/Fork.local.xcconfig.example Config/Fork.local.xcconfig         # once; set FORK_API_URL (see "The fork")
xcodegen generate              # creates Thesis.xcodeproj from project.yml
open Thesis.xcodeproj
```

The `.local.xcconfig` files are gitignored and included by `Config/Debug.xcconfig` and `Config/Release.xcconfig`. Without them the app still builds, and stops at launch naming the missing value: a missing backend or Privy value stops it with an error, and a missing `FORK_API_URL` shows "This build needs FORK_API_URL (see apps/ios/README)".

Needs Xcode 26 with the iOS 26 platform installed (Xcode → Settings → Components). Build through Xcode: Border Beam's Metal shader is compiled by Xcode's build system.

`Thesis.xcodeproj` and `Thesis/Info.plist` are generated, so they're not committed. Edit `project.yml` instead and re-run `xcodegen generate`.

Bundle IDs: `xyz.yourthesis.app.dev` ("Thesis Dev", Debug) and `xyz.yourthesis.app` ("Thesis", Release), so both install side by side. `DEVELOPMENT_TEAM` in `project.yml` is set to one team; change it to your own (or pick theirs under Signing & Capabilities) to run on a device.

## Layout

| Path | What |
| --- | --- |
| `Thesis/App` | App entry, tab bar (`RootView`), debug screen routes |
| `Thesis/DesignSystem` | Colors (`Palette`), Geist fonts (`Font.geist/serif/mono/pixel`), components, charts |
| `Thesis/Model` | Models and `MockData` (UI tests and `-screen` previews; signed-in builds use the live backend) |
| `Thesis/Session` | Privy sign-in, the Supabase APIs (session, social) and the fork API (`ForkAPI.swift`) |
| `Thesis/Features` | Feed, Take page, Create flow (write → build → basket), Back/Fade sheet, Comments, Search, Scores, Profile |
| `Thesis/Resources` | Geist fonts (OFL), avatars, topic images |
| `ThesisShare` | Share extension: an article or X post shared from any app opens Thesis on a take drafted from it (through the URL scheme) |

## Liquid Glass

- Tab bar, toolbars and sheets get glass from the system (iOS 26).
- Search is a `Tab(role: .search)`; "What's your take?" is the `tabViewBottomAccessory`. The take page hides the tab bar because it has its own Fade / Trade bar; the accessory sits below that bar.
- Custom glass: `.glassEffect(...)` inside `GlassEffectContainer` (Back/Fade pills, amount presets, chips, inputs); primary actions use `.buttonStyle(.glass)`.
- Content stays on the background with hairline dividers — no cards.

## Libraries

- `BorderBeamKit` and `ThinkingOrbsKit` from [libraries.dev](https://libraries.dev) via Swift Package Manager. Used only in the new-take flow and the bottom accessory.
- Swift Charts for the scrubbable return chart, sparklines and the basket donut.

## Sign-in and onboarding

The app opens on sign-in (Google or an emailed code, via Privy; Apple is behind `APPLE_SIGN_IN_ENABLED` in `project.yml` until the team is in the paid Apple Developer Program), then asks for a name and @handle, a profile photo, and where you live, then shows the app. Signed-in users go straight to the app on later launches: Privy keeps the session in the keychain, and the last profile is cached so the app still opens offline. Log out is under Me → Settings.

- `Thesis/Session`: `SessionStore` (Privy client + sign-in state), `SessionAPI` (Supabase `session` function), `AppConfig`
- `Thesis/Features/Onboarding`: the welcome, email, profile and location screens
- `Thesis/App/AppGate.swift`: picks sign-in, onboarding or the app
- Profile photos live in `profiles.avatar_url`: `face:<person-NN>:<color>` (one of 24 built-in faces on a pastel), an uploaded `https://` photo, or `asset:<name>` (demo people). `Avatar` draws all three. Change it from Me → Edit profile.
- Tap any person (feed and take authors, commenters, Scores rows, Search, people lists, suggestions) to open their profile (`PersonProfileView`): bio, Follow, counts, record and their takes. Wrap new person UI in `PersonLink`; its stack needs `.peopleDestinations()`. Tapping yourself goes to the Me tab.
- Search has Takes / People / Assets. An asset row or a pick on a take page opens its asset page (`AssetView`, route `PeopleRoute.asset(id)`): price and chart (1D–1Y), what it is, details, the takes that hold it, and "Make a take with this" (the composer opens with that asset pinned in the basket). With `US_RESTRICTIONS=on` in the Supabase functions (off for now), assets US persons can't buy show as unavailable.
- The basket can be edited before posting: "Change something…" asks the take builder ("add AMD", "less crypto", ~2 s), and each pick's ⋯ menu has About, Set weight and Remove; "Add a pick" searches the catalog (`AssetPickerView`). Once you've changed the picks, a new risk keeps them and only swaps the cash (low) or perp (high) pick. The take builder's house rules (leverage ceilings, perp cap, one pick per name) are in [`packages/take-builder`](../../packages/take-builder/README.md). Weights always add up to 100 (`BasketMath`).
- Onboarding ends with an optional "Follow some callers" step (after location, which is when the server counts you as onboarded). "Suggested for you" also shows in Search (cards) and at the top of the Following feed (a short list, since that page swipes sideways).
- Dev login (debug builds) wipes the test account's profile and follows on every login, so it always goes through onboarding.

Backend values (Privy app/client ID, Supabase URL and publishable key) come from the gitignored `Config/Backend.local.xcconfig` and `Config/Privy.local.xcconfig` (see Setup); the URL scheme is a build setting in `project.yml`. Dev and prod read the same files, so they point at the same backend.

Privy dashboard, for sign-in to work: the iOS client must list both bundle IDs under Allowed app identifiers, and `yourthesis-dev` / `yourthesis` under Allowed URL schemes.

## The fork

The app runs only on the fork: Trade, Cash, posting and the take page go through the Thesis program on the shared mainnet fork (the Oracle VM) with fake money. There is no other money mode. Social data (feed, profiles, comments) comes from Supabase.

1. `cp Config/Fork.local.xcconfig.example Config/Fork.local.xcconfig` (gitignored). Set `FORK_API_URL` to the team's shared fork, `https://<fork-host>` (the Oracle VM in [`infra/executor`](../../infra/executor/README.md)), which runs the fork, the fork API, the relay and the settler. Nothing runs on your Mac, and a real iPhone reaches it too. Debug and Release both read it. A build made before the fork API moved to Caddy points at the old Tailscale Funnel address, which is off: update the file and rebuild.
2. There is exactly one fork; never start your own.
3. `xcodegen generate`, build and sign in. Add cash first: on the fork it mints fake USDC into your Privy wallet.

Without `FORK_API_URL` the app stops at launch on a screen that says so. Signing in also needs your Privy Solana wallet: if it couldn't be made, the app says so, and Try again makes it again. UI tests and `-screen` previews run on mock data and need neither.

How it works:

- **Trade:** the fork API builds the trade (Jupiter swaps for stock legs, Jupiter Lend for cash legs, a Phoenix position for perp legs, plus the receipt); your Privy wallet signs it (`signTransaction`, no send) and the API adds the fee payer and sends it. No SOL needed. Minimum $10; the sheet shows the 0.10% fee and any legs left out, with why. Prediction legs are paper-filled ("Yes · 47¢"), their share escrowed; **Fade** takes their other side and shorts each leg Phoenix lists.
- **Fast trades:** the Trade, Fade and Sell sheets build the trade before you tap (`Features/Trade/Prebuilds.swift`): at the default amount as the sheet opens, at once on a preset, half a second after typing stops, one build per amount, refreshed when it has under 15 s left while the sheet is open (for up to 3 minutes without a change). The tap signs every transaction at once and sends it with `until: "accepted"`, so the sheet says "You're in · Confirming on-chain…" (a sale: "Sold") as soon as the fork accepts it, and `AppState` follows it on `GET /submissions/:buildId`. If it then doesn't land, your balance and the take's counts come back and you're told: in the sheet if it's still open, otherwise in a banner with Try again ("That trade didn't go through. Nothing left your balance." / "That sale didn't go through. You still hold the position."). Each submit carries `timings` (ms from the tap: `built`, `sign_<i>`, `signed`, `submit`), and the app logs `accepted` and `shown` (category `trade`). Building ahead goes on only once a build made ahead answered `prebuilt: true` (the fork API counts its money action at submit); otherwise the app makes one early build and the tap builds, as before. A build is used for at most 50 s from when it was asked for, whatever its `expiresAt` says (the phone's clock can be behind). A `/submissions` 404 (`no_such_submission`) is an unknown: the app stops asking and reads the wallet. Against a fork API without these, the same code waits for confirmation at submit and builds again instead of refreshing.
- **Perps:** leverage comes from the take builder ("Stock · 3x"). Under each position the receipt shows each Phoenix leg's liquidation price and distance, in warning colors within 25% and red within 10%. A sale closes Phoenix positions and moves the cash back; positions left open after their take settles keep their risk until **Cash out** on the Cash tab.
- **Cash:** your wallet's fake USDC, added with fork cheatcodes up to $1,000 per account, no top-ups; withdrawals are off.
- **No horizon:** a take is a claim and a risk level. It's open until its author sells their buy-in, or a year after posting at most; then it's closed: Trade and Fade go ("Closed: @author sold"), and its result is final. Everyone else's positions keep running until they sell. The author's Sell tab warns first when a sale of all of it would close the take (`closesTake` on the build); a partial sale never closes it.
- **Posting:** the take goes on-chain with your buy-in. Until that confirms, only you see it ("Posting…", `PostingBar`); a failed buy-in shows "Didn't post" with Retry (same amount) or Discard.
- **Scores:** on-chain P&L for accounts with fork activity: "Own P&L", "For backers" and "Faders" boards, each by dollars or percent; profiles show both scores.
- **Creator fees:** your own profile shows what you earned (5 bps of every back and fade of your takes), with Claim and Claim all.
- **Selling:** the trade sheet has Buy | Sell tabs. Sell sells part or all of your holding on that side, by % or $, with presets and a typed amount (`Features/Trade/SellSheet.swift`, `SellModel.swift`, through `POST /takes/:id/sell`); it says why when an amount would leave less than $10, and warns at All when the sale would close your own take. On your profile, swipe an open holding left (or tap its red arrow) to sell all of it. Positions show the remaining size, realized P&L and "Selling…". Each sale scores at its own prices ([selling a position](../../scripts/fork/README.md#selling-a-position)). A fork API from before partial sales gets Sell all only.
- **Stopped trades:** a split trade that stops partway shows a message, but the app has no Finish or Swap-back flow yet (the web app has one: `GET /wallets/:w/incomplete`, retry, sweep).
- **Take page:** returns come from the chain ("—" while entry prices are pending), and an "On-chain receipt" section shows backers, faders, money in, each leg's entry and current price, and your positions.
- **Feed:** cards show on-chain counts and settled results (the app sends `x-thesis-network: solana-mainnet-fork` on Supabase reads).

## Notifications

The Home bell opens the inbox (opening it marks its network's notifications read; rows open their take). It covers: someone you follow posts; comments and replies; on the fork, trades and fades of your take, a take you're in closing (its author sold) or settling, badges; a Phoenix leg turning near or close to liquidation; and the daily positions digest (after 9 a.m. New York).

The free build shows local alerts when the app checks the inbox (on activation or Background App Refresh). Server-triggered APNs alerts need paid Apple signing.

## Debug: open a specific screen

Debug builds accept `-screen <name>` (`App/DebugRoute.swift`): `feed`, `search`, `scores`, `me`, `take`, `back`, `fade`, `sell`, `comments`, `create`, `building`, `basket`, `drawer`, `saved`, `followers`, `addcash`, `withdraw`, `cash`, `editprofile`, `startcash`, `loading`. These skip sign-in.

Onboarding screens with stubbed actions (no network): `welcome`, `email`, `handle`, `location`. Pass `-skipAuth` to go straight to the app on mock data. Add `-mockTradeFails` to make mock trades get accepted and then not land, to see the rollback (`-mockTradeFailsLate`: after the sheet has closed, to see the banner).

```sh
xcrun simctl launch booted xyz.yourthesis.app.dev -screen take
```

## Tests

UI smoke tests (`ThesisUITests`) tap through the tabs, Back/Fade and Sell sheets (`PartialSalesUITests`), the take page and comments, onboarding, asset pages, people and the full new-take flow.

```sh
xcodebuild test -project Thesis.xcodeproj -scheme Thesis \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Or press ⌘U in Xcode.

CI (`.github/workflows/ios.yml`, PRs that touch `apps/ios/` only) builds the app and these tests
with `build-for-testing` but doesn't run them: macOS runner minutes are expensive on a private repo.
Run them locally before a PR.

These run on mock data (`-skipAuth`), so they work offline and never touch the backend.

### Live backend tests

`LiveBackendUITests` sign in with Dev login and check that saves, follows, comments,
likes and new takes are stored on the server (still there after a relaunch). They're
skipped unless switched on, because they write to the shared Supabase project and the fork:

```sh
TEST_RUNNER_THESIS_LIVE=1 TEST_RUNNER_DEV_USER=<username> TEST_RUNNER_DEV_PASS=<password> \
xcodebuild test -project Thesis.xcodeproj -scheme Thesis -allowProvisioningUpdates \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:ThesisUITests/LiveBackendUITests
```

- Needs `Config/DevLogin.local.xcconfig` (the Dev login link only exists with it) and
  `Config/Fork.local.xcconfig`.
- Build signed (no `CODE_SIGNING_ALLOWED=NO`): unsigned simulator apps can't use the
  keychain, so Privy can't keep the session across relaunches.
- Saves, follows and likes are undone by the tests. Test comments and takes are named
  `[live test] …`; remove them with
  `delete from comments where body like '[live test]%'; delete from takes where claim like '[live test]%';`
- `testDisposableForkFullExit` adds fake cash, trades $10 and sells the position on the fork.
  It also needs `TEST_RUNNER_THESIS_FORK_EXIT=1`.

## Data

Signed in, `AppState` loads social data from the backend through `Session/SocialAPI.swift`
(reads: SQL functions with the publishable key; writes: the `social` edge function with
the Privy token), and money (cash, trades, posting, positions) from the fork API through
`Session/ForkAPI.swift`. Changes show immediately and roll back with a banner if the request
fails. Without a session (tests, `-screen` previews) it uses `Model/MockData.swift`.
Backend details: `supabase/README.md`.
