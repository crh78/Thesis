use anchor_lang::prelude::*;

use crate::constants::{MAX_BADGE_URI_BASE_LEN, MAX_LEGS, MAX_TRADE_PROGRAMS};

/// Program-wide settings, one per deployment at `[CONFIG_SEED]`.
///
/// Only `init_config` creates a `Config`, and only at that address, so any account Anchor accepts
/// as `Account<Config>` (owned by this program, with this discriminator) is the config.
/// Instructions therefore skip re-deriving its address, which saves a hash per instruction.
/// The same reasoning applies to profiles and positions: each exists only at its PDA, so a check
/// on its stored `owner` / `take` / `id` fields identifies it.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Sets the params and the settler, withdraws platform fees, pauses. Can't touch the trade
    /// allowlist (security review M-2).
    pub admin: Pubkey,
    /// The only key that can change `trade_programs` (security review M-2):
    /// kept apart from the fee admin, so the admin key alone can't let a plain transfer count
    /// as a trade.
    pub allowlist_admin: Pubkey,
    /// Proposed by the admin, takes over once it signs `accept_admin` (two-step, review L-2).
    pub pending_admin: Option<Pubkey>,
    /// Proposed by the allowlist admin, takes over once it signs `accept_allowlist_admin`.
    pub pending_allowlist_admin: Option<Pubkey>,
    /// Signs prices and results for legs with no on-chain price (Gemini markets, trading cards).
    pub settler: Pubkey,
    pub usdc_mint: Pubkey,
    /// Program-owned USDC account that collects platform fees, at `[FEE_VAULT_SEED]`.
    pub fee_vault: Pubkey,
    /// Program-owned USDC account holding creator fees until authors claim them,
    /// at `[CREATOR_VAULT_SEED]`. Kept apart so withdrawing platform fees can't touch them.
    pub creator_vault: Pubkey,
    /// Program-owned USDC account holding each position's prediction share (paper-filled Gemini
    /// legs) until it settles, at `[ESCROW_VAULT_SEED]`. Never mixed with fees.
    pub escrow_vault: Pubkey,
    pub params: ConfigParams,
    pub bump: u8,
    pub fee_vault_bump: u8,
    pub creator_vault_bump: u8,
    pub escrow_vault_bump: u8,
    /// Programs a trade may call between `begin_trade` (or `trade_step`) and the receipt: Jupiter,
    /// Jupiter Lend, Compute Budget, Associated Token. Never the Token programs or System, so the
    /// stake can't be spent with a plain transfer (`update_allowlist` refuses them).
    #[max_len(MAX_TRADE_PROGRAMS)]
    pub trade_programs: Vec<Pubkey>,
    /// Where badge metadata lives: `{badge_uri_base}{slug}.json` (an `https://` URL ending in
    /// `/`). Set by the admin with `update_config`, so the host can change without an upgrade.
    #[max_len(MAX_BADGE_URI_BASE_LEN)]
    pub badge_uri_base: String,
}

/// Every tunable number. Changed with `update_config`, never hard-coded.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct ConfigParams {
    /// Platform fee on each back or fade, in bps of the stake (10 = 0.10%).
    pub fee_bps: u16,
    /// Part of `fee_bps` credited to the take's author on backs and fades (5 of the 10).
    pub creator_fee_bps: u16,
    /// Smallest stake that counts toward a score, and the author's minimum buy-in, in USDC base units.
    pub min_stake: u64,
    /// Legs allowed per take, at most `MAX_LEGS`.
    pub max_legs: u8,
    pub min_horizon_secs: i64,
    pub max_horizon_secs: i64,
    /// How long after a trade (or a horizon end) an oracle price can be published and still be used.
    /// Prices must be at or after that moment, never before.
    pub max_price_delay_secs: i64,
    /// Extra share of a take's platform fees paid to its author, scaled by follower profit. 0 = off.
    pub creator_boost_bps: u16,
    /// Blocks new takes and positions. Settlement and claims keep working.
    pub paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Back,
    Fade,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum LegKind {
    /// Token bought through Jupiter (xStocks, Ondo, RWA tokens).
    Spot,
    /// Idle USDC in Kamino or Jupiter Lend.
    Yield,
    /// Phoenix perp. Moves with the underlying, times leverage.
    Perp,
    /// Gemini prediction market, priced as odds.
    Prediction,
    /// Collector Crypt card.
    Card,
}

impl LegKind {
    /// Paper-filled legs: nothing is traded for them. Their share of the stake is held in the
    /// escrow vault and returned in full at a sale or settlement, and their price moves count only
    /// in the score. Gemini prediction legs, and Collector Crypt card legs (
    /// priced in dollars at the card's insured value).
    pub fn is_escrowed(self) -> bool {
        matches!(self, LegKind::Prediction | LegKind::Card)
    }
}

/// How a fade takes the other side of a leg.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum FadeVia {
    /// Can't be faded; excluded from fades.
    None,
    PhoenixShort,
    PredictionNo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TakeStatus {
    /// Takes backs and fades until the author sells or `horizon_end` passes.
    Open,
    /// The headline result is recorded (`settle_take`).
    Settled,
    /// The author sold their buy-in (`exit_position`): no new backs or fades, and `settle_take`
    /// scores the take on the sale's prices. Holders keep their positions until they sell, or
    /// until `horizon_end`. Appended, so `Open` and `Settled` keep their Borsh indices.
    Closed,
}

/// One leg of a basket, as the author chose it. Every leg is priced by the settler, so the
/// leg names what it tracks but not a price feed: the price source can change off-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct LegSpec {
    pub kind: LegKind,
    /// What the leg tracks: for spot and perp legs the underlying's id (`underlyingId` in
    /// `packages/venues`), so backers can buy any issuer's token for it; for off-chain legs the
    /// sha256 of the venue's market id.
    pub asset: Pubkey,
    pub weight_bps: u16,
    /// 1 for spot; above 1 only for perps.
    pub leverage: u8,
    pub fade_via: FadeVia,
}

/// A take: the claim, its basket and its live counters. Never edited or deleted.
/// At `[TAKE_SEED, author, id]`.
#[account]
#[derive(InitSpace)]
pub struct Take {
    pub author: Pubkey,
    pub id: u64,
    /// sha256 of the claim text. The text itself lives off-chain.
    pub claim_hash: [u8; 32],
    pub risk: Risk,
    pub created_at: i64,
    /// When the take settles if the author never sells (a year after posting, by config), and
    /// the last moment anyone can sell a position before it settles on horizon prices instead.
    pub horizon_end: i64,
    #[max_len(MAX_LEGS)]
    pub legs: Vec<LegSpec>,
    pub backers: u32,
    pub faders: u32,
    pub total_backed: u64,
    pub total_faded: u64,
    /// Positions not yet settled and closed.
    pub open_positions: u32,
    pub creator_fees_unclaimed: u64,
    /// Platform's part of the fees from backs of this take, for the creator boost.
    pub platform_fees_from_backs: u64,
    pub status: TakeStatus,
    /// Headline return in bps: the author's position, entry to its sale (or to the horizon if
    /// the author never sold). Set at settlement.
    pub result_bps: i64,
    pub bump: u8,
    /// When the author sold their buy-in and the take closed; 0 while they haven't. Kept here
    /// because the author's exit account closes once their buy-in settles.
    pub closed_at: i64,
}

impl Take {
    /// Account size for a take with `legs` legs, so rent is only paid for legs that exist.
    pub fn space(legs: usize) -> usize {
        8 + Self::INIT_SPACE - (MAX_LEGS - legs) * LegSpec::INIT_SPACE
    }
}

/// One back or fade. Temporary: settling it folds the result into the owner's profile,
/// closes it and refunds the rent to `rent_payer`.
/// At `[POSITION_SEED, take, owner, id]`.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub take: Pubkey,
    pub id: u64,
    /// Gets the rent back when the position is settled and closed.
    pub rent_payer: Pubkey,
    pub side: Side,
    /// USDC base units.
    pub stake: u64,
    pub opened_at: i64,
    /// Bit i set = leg i is part of this position.
    pub legs_mask: u16,
    /// One entry per leg of the take (not just the included ones), indexed by leg.
    #[max_len(MAX_LEGS)]
    pub prices: Vec<LegPrices>,
    /// Bit i set = leg i's entry (exit) price is recorded. A price can legitimately be 0
    /// (a prediction that resolved No), so 0 can't mean "missing".
    pub entry_set: u16,
    pub exit_set: u16,
    /// At or above the minimum stake, so it counts toward the owner's score.
    pub scored: bool,
    /// Sold before the horizon (`exit_position`): it scores on its `Exit` account's prices.
    pub exited: bool,
    /// The stake's prediction share, in USDC base units, held in the escrow vault and returned to
    /// the owner at a sale (`exit_position`, which then sets this to 0) or when the position
    /// settles. Prediction legs are paper-filled at Gemini's prices.
    pub escrowed: u64,
    pub bump: u8,
    /// Cost basis still held, in USDC base units: `stake` at open, lowered by each partial sale
    /// (`sell_part`). The final settlement scores on this.
    pub remaining: u64,
    /// Partial sales made so far; the next one's seq (its `PartSale` PDA).
    pub parts: u16,
    /// Partial sales settled so far. They settle in order (seq = `parts_settled`), and the
    /// position settles only once every one has (`parts_settled == parts`).
    pub parts_settled: u16,
    /// P&L realized by settled partial sales, in USDC base units (scored or not).
    pub realized_pnl: i64,
}

impl Position {
    /// Account size for a position on a take with `legs` legs.
    pub fn space(legs: usize) -> usize {
        8 + Self::INIT_SPACE - (MAX_LEGS - legs) * LegPrices::INIT_SPACE
    }
}

/// A position its owner sold before the horizon. Its sale prices score the owner, and for the
/// author's buy-in they also set the take's headline result. At `[EXIT_SEED, position]`.
/// Closed together with its position.
#[account]
#[derive(InitSpace)]
pub struct Exit {
    pub position: Pubkey,
    pub exited_at: i64,
    /// Gets the rent back when the position is settled.
    pub rent_payer: Pubkey,
    /// Bit i set = leg i's sale price is recorded.
    pub price_set: u16,
    /// One sale price per leg of the take, 8 decimals, at or after `exited_at`.
    #[max_len(MAX_LEGS)]
    pub prices: Vec<u64>,
    pub bump: u8,
}

impl Exit {
    /// Account size for an exit on a take with `legs` legs.
    pub fn space(legs: usize) -> usize {
        8 + Self::INIT_SPACE - (MAX_LEGS - legs) * 8
    }
}

/// Part of a position its owner sold before the horizon (`sell_part`): a fraction of what was
/// left. It scores on its own sale prices (`record_part_prices`), entry to sale, on `stake`, and
/// settles on its own (`settle_part`, in seq order) while the rest of the position runs on.
/// At `[PART_SALE_SEED, position, seq u16 LE]`. Closed when it settles; rent to `rent_payer`.
#[account]
#[derive(InitSpace)]
pub struct PartSale {
    pub position: Pubkey,
    pub seq: u16,
    /// The fraction of the position's remaining stake sold, in bps (1 to 9,999).
    pub bps: u16,
    /// The cost basis sold, USDC base units.
    pub stake: u64,
    /// The escrowed prediction and card share returned to the owner at the sale.
    pub escrow_returned: u64,
    pub sold_at: i64,
    /// Gets the rent back when the part settles.
    pub rent_payer: Pubkey,
    /// Bit i set = leg i's sale price is recorded.
    pub price_set: u16,
    /// One sale price per leg of the take, 8 decimals, at or after `sold_at`.
    #[max_len(MAX_LEGS)]
    pub prices: Vec<u64>,
    pub bump: u8,
}

impl PartSale {
    /// Account size for a partial sale on a take with `legs` legs.
    pub fn space(legs: usize) -> usize {
        8 + Self::INIT_SPACE - (MAX_LEGS - legs) * 8
    }
}

/// Proof of trade for one position, while its trade runs. At `[TICKET_SEED, position]`.
///
/// The trade runs in one or more transactions. Each one is a *bracket*: it opens with
/// `begin_trade` (the first) or `trade_step` (later ones), and closes with `trade_step` or, in the
/// last transaction, the receipt (`create_take`, `back`, `fade`). Only programs in the config's
/// `trade_programs` may run inside a bracket. A bracket measures only what happens inside it, so
/// USDC moved between the trade's transactions never counts. The receipt requires the owner's
/// USDC to have dropped by at least the stake across all brackets, and each bought leg's output
/// account (a token account, or a Phoenix trader account for perp legs and shorts) to have
/// grown, then closes the ticket.
#[account]
#[derive(InitSpace)]
pub struct TradeTicket {
    pub owner: Pubkey,
    /// The position the receipt will open (its address, derived before it exists).
    pub position: Pubkey,
    /// Paid the ticket's rent; must be the receipt's payer, who gets it back.
    pub rent_payer: Pubkey,
    /// The owner's USDC account the stake is spent from.
    pub owner_usdc: Pubkey,
    /// Output token account for each leg, by leg index, fixed the first time a bracket names it.
    pub outputs: [Pubkey; MAX_LEGS],
    /// USDC spent inside closed brackets so far (net of anything that came back inside them).
    pub spent: u64,
    /// Bit i set = leg i's output account grew inside a bracket.
    pub grown: u16,
    /// How much each leg's output account grew inside the brackets, in its token's base units
    /// (a Phoenix account's in base lots of its position).
    /// The receipt emits it (`TradeProved`) so the settler values what was really bought.
    pub received: [u64; MAX_LEGS],
    /// Bit i set = leg i's output account has been named (`outputs[i]` is fixed).
    pub named: u16,
    /// Bit i set = leg i's output is a Phoenix trader account (its "balance" is its position
    /// size), not a token account. Perp legs and Phoenix shorts must be; token legs mustn't.
    pub phoenix: u16,
    /// The open bracket: the opening instruction's index in its transaction, or `NO_BRACKET`.
    pub open_ix: u16,
    /// Outputs the open bracket watches (bit i = leg i), and their balances when it opened.
    pub open_mask: u16,
    pub usdc_start: u64,
    pub outputs_start: [u64; MAX_LEGS],
    pub bump: u8,
}

impl TradeTicket {
    /// `open_ix` when no bracket is open.
    pub const NO_BRACKET: u16 = u16::MAX;
}

/// A leg's prices for one position, 8 decimals, for the token this owner actually bought.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace,
)]
pub struct LegPrices {
    /// At or after the trade.
    pub entry: u64,
    /// At or after the horizon end.
    pub exit: u64,
}

/// A user's permanent track record: raw stats only. The score formula is computed off-chain.
/// At `[PROFILE_SEED, owner]`.
#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    pub takes_created: u32,
    pub positions_opened: u32,
    pub positions_settled: u32,
    pub scored_positions: u32,
    /// Sum of scored stakes, in USDC base units.
    pub scored_stake: u64,
    /// Sum of scored profit and loss, in USDC base units.
    pub scored_pnl: i64,
    pub wins: u32,
    pub badges: u32,
    /// The owner's own takes that have settled, and how many cleared each badge threshold.
    pub takes_settled: u32,
    pub takes_over_50: u32,
    pub takes_over_100: u32,
    pub takes_over_1000: u32,
    /// Best settled take result, in bps.
    pub best_take_bps: i64,
    pub bump: u8,
}

/// The badge catalog. Each badge is earned once per user and minted to them as a
/// non-transferable Token-2022 token.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BadgeKind {
    /// Posted a first take.
    FirstTake,
    /// First take that settled at +50% or more.
    FirstOver50,
    /// First take that settled at +100% or more.
    FirstOver100,
    /// Ten takes settled at +50% or more.
    TenOver50,
    /// A take that settled at +1,000% or more.
    Over1000,
}

impl BadgeKind {
    pub fn earned(self, profile: &Profile) -> bool {
        match self {
            BadgeKind::FirstTake => profile.takes_created >= 1,
            BadgeKind::FirstOver50 => profile.takes_over_50 >= 1,
            BadgeKind::FirstOver100 => profile.takes_over_100 >= 1,
            BadgeKind::TenOver50 => profile.takes_over_50 >= 10,
            BadgeKind::Over1000 => profile.takes_over_1000 >= 1,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            BadgeKind::FirstTake => "Thesis: First take",
            BadgeKind::FirstOver50 => "Called it: +50%",
            BadgeKind::FirstOver100 => "Called it: +100%",
            BadgeKind::TenOver50 => "Called it: 10x +50%",
            BadgeKind::Over1000 => "Called it: +1,000%",
        }
    }

    /// Stable short id, used in the metadata URI and fields.
    pub fn slug(self) -> &'static str {
        match self {
            BadgeKind::FirstTake => "first-take",
            BadgeKind::FirstOver50 => "first-50",
            BadgeKind::FirstOver100 => "first-100",
            BadgeKind::TenOver50 => "ten-50",
            BadgeKind::Over1000 => "over-1000",
        }
    }
}
