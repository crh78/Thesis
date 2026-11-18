# Phoenix perps

Perp legs (leverage on high-risk takes) and shorts (fades of stock and crypto legs) on Phoenix, the perps exchange from Ellipsis Labs. Built and working on the fork end to end: backs, fades, sales, cash-out, settlement, liquidation warnings. Dogfooded in the simulator; not yet on a phone.

## What's left before mainnet

Phoenix docs: [trader onboarding](https://docs.phoenix.trade/sdk/register.md), [builder codes](https://docs.phoenix.trade/builder-codes.md), [API best practices](https://docs.phoenix.trade/sdk/ws-api-best-practices.md). No builder account is required: registration without a referral code (`build-register-ixs`, then `send-register-ixs`, Phoenix's onboarder co-signs) is supported, and the app's payer can cover it.

1. **Who owns it.** Phoenix is closed to US persons. The first real registration, and any builder account, should be owned and run by the non-US person or entity behind Thesis's mainnet side, from outside the US.
2. **First real registration.** That person registers one wallet through the no-referral route (~0.03 SOL rent). The code exists (`PhoenixVenue.submitRegistration`) but isn't wired into an API, since the fork uses its own onboarder.
3. **Builder account (recommended before launch):**
   1. A fresh, empty wallet as the builder authority (hardware wallet or multisig).
   2. Register at [flight.phoenix.trade](https://flight.phoenix.trade) and set a builder fee in bps. Recommendation: 0 bps, since Thesis already takes 10 bps.
   3. Set an onboarder signer (`buildSetOnboarderSignerIx`) naming a key Thesis's backend holds (OCI Vault). Then each user is onboarded with one instruction (`buildOnboardTraderIx`), with no user signature and no Phoenix API call.
   4. Ask Phoenix on Discord for a bigger onboarding allowance, higher API limits (the public API allows about one read every two seconds per address), and whether apps should stream books and marks over WebSocket.
   5. Share the builder authority's public key and the onboarder key's location, so the API can switch from the fork onboarder to Flight.

## Decisions

| Question | Rule |
|---|---|
| Leverage | The take builder's model picks it per perp pick, at most 5x and the market's max. A take has no timeline, so the model picks from the risk and how directly the name is the take. A pick with no leverage is left out. Without a model call (rules fallback, a switch to high risk) it's 2x. A perp is at most 30% when the basket holds other picks, and one pick per name |
| Margin | One isolated Phoenix subaccount per perp leg per position, so legs never net against each other and one liquidation can't touch another |
| Price the settler signs | Phoenix's mark: the first one-minute bar at or after the trade, sale or the take's 365-day mark (rule `phoenix-mark`), per unit of the underlying (kPEPE is 1,000 PEPE) |
| A position gone at the 365-day mark without a Thesis sale | That leg scores −100% (`phoenix-liquidated`): the exit is `entry × (1 − 1/leverage)` for a back, `entry × (1 + 1/leverage)` for a fade |
| After the 365-day mark | The position stays open on Phoenix until the user taps "Cash out" (Thesis can't close it without their signature). The score stops at the mark; funding and liquidation risk continue, and the app says so |
| Fades of spot legs | A short of the same underlying where Phoenix lists it (`fade_via = PhoenixShort`); otherwise left out with the reason |
| US users | Open to everyone for now. `US_RESTRICTIONS=on` hides perps from US accounts again |

## How it works

**Accounts.** A parent trader account (subaccount 0) per wallet, registered and onboarded once (~0.028 SOL, paid by the app). Child subaccounts 1–100, one per open perp leg (0.0021 SOL each, reused once closed and swept). More than 100 open perp legs would need a second parent, which the SDK doesn't support yet. Proof of trade names the child as the leg's output account, so `TradeProved` records which child belongs to which leg.

**A back or fade**, per Phoenix leg, inside the proof-of-trade brackets: Ember `deposit` (USDC → PhUSD), Phoenix `deposit_funds` into the child, `place_market_order` (buy for a back, sell for a fade) sized at share × leverage. Child registration and the parent's onboarding go in an earlier transaction outside the brackets. The user only signs; the app pays fees and rent. With Phoenix's fixed accounts in the Thesis lookup table, a whole leg fits in one transaction with the receipt (953 bytes); without them it splits in two.

**Program.** A Phoenix trader account of the owner can be a leg's output; its "balance" is its absolute position size, which must grow inside a bracket. Backs need one per perp leg, fades one per `PhoenixShort` leg. Inside a bracket Phoenix may run only `deposit_funds`, `place_market_order`, `register_trader` and `sync_parent_to_child`, and Ember only `deposit`, so the stake can't leave mid-trade.

**Settler** (`apps/executor/src/settler/phoenix-legs.ts`). The child's position must be in a market whose underlying is the leg's, long for a back and short for a fade, with notional at entry at least 90% of share × leverage. Otherwise the leg stays unpriced and the position settles unscored. The entry check reads the trade's own order, so a position sold before the settler runs still prices.

**A sale** closes each child's position in the same set as `exit_position`, then `withdraw_funds` and Ember `withdraw` back to USDC ("Cash out", since Phoenix won't withdraw more than an account holds and the amount is only known after the close).

**Liquidation warnings.** Each leg's liquidation price comes from Phoenix's margin equation (`liquidationOf` in `@thesis/venues/phoenix`), checked against Phoenix's own view on the fork. Receipts show it ("liquidates at $61.21 · 18% away"), in warning colors within 25% ("near") and 10% ("close"). Every 5 minutes (`LIQUIDATION_CHECK_SEC`) the fork API sends one inbox alert per leg per level (`liquidation_risk`). No push until APNs (paid Apple signing). At 5x a position starts about 18% from liquidation, so it reads "near" from the start.

## The fork

- **Registration:** `fork:up` writes a copy of Phoenix's onboarding permission naming a fork-only onboarder key, so the fork API registers traders itself with the same instruction mainnet uses.
- **Prices:** Phoenix's makers and mark oracles only update on mainnet, so before each order the fork re-copies the market's book, its maker spline and the PerpAssetMap (`PhoenixVenue.marketAccounts`). Fills land within a few cents of mainnet's mid. The copy also resets open interest and funding to mainnet's, harmless at fork sizes.
- **Caveats:** fork traders take trader-index slots that mainnet traders get later, which rarely affects a fill. Phoenix's liquidators don't run on the fork, so a position past its price stays open (the warnings still fire).
- **Rate limits:** every Phoenix call retries 429s, and values fall back to the asset bank's mid. On mainnet with real users this needs a key or higher limit from Phoenix.
- Costs measured: register ~0.028 SOL, child 0.0021 SOL, market orders 160–200k CU (every Phoenix transaction sets a compute budget), about $0.09 of fees and spread on $80 of notional. `pnpm fork:phoenix-e2e` (adapter only) and `pnpm fork:phoenix-api-e2e -- --settle` (through the program) check it.

## Still to do

- Dogfood on a phone: a high-risk take with a leveraged leg; back, fade, sell, cash out; check the liquidation line and alert.
- Geoblocking, when decided.
- Push for liquidation alerts (inbox only until APNs).
- Mainnet registration and Phoenix's terms (items 1–3 above).

## Not decided yet

- Phoenix's terms for apps that register users on their behalf.
- Funding payments settle into the child's collateral, so they show up in the cash-out amount but not in the price-based score.
