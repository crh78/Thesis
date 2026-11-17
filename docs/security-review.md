# Security review: the Thesis program

An internal first pass over the Anchor program (`anchor/programs/thesis`) and its keys. It's not an audit: an outside audit should read the program before real users (phase 3). Off-chain services were out of scope except for what their keys can do.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| H-1 | High | Anyone could call `init_config` first after a deploy and become admin | Fixed: the signer must be the program's upgrade authority. Initialize before making the program immutable |
| H-2 | High | Associated Token's `RecoverNested` could count tokens the owner already held as bought | Fixed: inside a bracket, Associated Token may only create accounts |
| M-1 | Medium | The admin could raise the fee up to 100%, even on trades already signed | Fixed: `MAX_FEE_BPS = 100` (1%) |
| M-2 | Medium | The admin could allow any program inside a trade | Fixed: a separate `allowlist_admin` is the only key that changes `trade_programs` |
| **M-3** | Medium | **The settler key decides every score** | **Open, accepted** while prices are settler-signed |
| L-1 | Low | A return too large for `i64` read as "price missing" | Fixed: refused with `ReturnOutOfRange` |
| L-2 | Low | Admin hand-over was one step | Fixed: propose, then accept (both admin keys) |
| L-3 | Low | Fades and perp backs could be recorded with any allowed spend | Fixed: Phoenix legs must grow a Phoenix position inside the trade ([`phoenix-plan.md`](phoenix-plan.md)); prediction and card shares are escrowed |
| L-4 | Low | An abandoned split trade's ticket kept the app payer's rent | Fixed in the fork API: the owner's next trade cancels it (`pnpm fork:ticket-e2e`). The production backend needs the same |
| I-1 | Info | Pause doesn't block `begin_trade` / `trade_step` | No change needed: a paused program refuses every receipt |

## M-3: the settler key decides every score

`record_entry_prices`, `record_exit_prices` and `record_sale_prices` check only the timing window, one price per leg and the ranges. The settler key can give any position any result within those bounds, or withhold prices so positions settle unscored. Mitigations: each price's source document is hashed into the receipt and published in the public `price_audit` table; the key belongs in OCI Vault before real users; stock legs can move to Pyth later without a program change.

## The keys and what they can do

| Key | Can | Can't |
|---|---|---|
| **Upgrade authority** | Replace the program | (Everything follows from that: cold storage or a multisig before real users) |
| **Admin** (`Config.admin`) | Change fees (≤1%), limits, the settler and the badge base; propose the next admin; pause new trades; withdraw platform fees | Change the trade allowlist; touch creator fees, escrow or user wallets; change the USDC mint or vaults; edit takes or positions |
| **Allowlist admin** (`Config.allowlist_admin`) | Set the programs a trade may call (never Token, Token-2022, System or Thesis); propose its successor | Anything the admin does |
| **Settler** (`Config.settler`) | Sign every price within the timing rules, and so every score (M-3) | Move funds; record a price twice; price outside the window |
| **App fee payer** (fork API, later the backend) | Pay rent and fees for Privy users, signing only messages it built (`/submit` checks them byte for byte) | Sign for a user's wallet; take back rent other than its own |

## Pause

`paused` blocks `create_take`, `back` and `fade`. Sales, prices, settlement, claims, badges and fee withdrawals keep working, so a pause never traps a position.
