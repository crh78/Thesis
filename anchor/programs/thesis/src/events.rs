use anchor_lang::prelude::*;

use crate::state::{BadgeKind, ConfigParams, Risk, Side};

// One event per state change. The QuickNode Stream decodes these for the live feed,
// notifications and iMessage updates.

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub allowlist_admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub pending_allowlist_admin: Option<Pubkey>,
    pub settler: Pubkey,
    pub params: ConfigParams,
    pub trade_programs: Vec<Pubkey>,
    pub badge_uri_base: String,
}

#[event]
pub struct FeesWithdrawn {
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TakeCreated {
    pub take: Pubkey,
    pub author: Pubkey,
    pub claim_hash: [u8; 32],
    pub risk: Risk,
    pub horizon_end: i64,
    pub legs: u8,
    pub stake: u64,
    /// The take bets against its basket: the author's buy-in is a fade (`Take::inverted`).
    pub inverted: bool,
}

#[event]
pub struct PositionOpened {
    pub take: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub stake: u64,
    pub legs_mask: u16,
    pub fee: u64,
    pub creator_fee: u64,
    pub scored: bool,
    /// The prediction share held in escrow until the position settles.
    pub escrowed: u64,
}

/// Emitted by every receipt (`create_take`, `back`, `fade`) with what its trade's proof measured:
/// only changes inside the trade's brackets count, so tokens moved in from elsewhere don't.
#[event]
pub struct TradeProved {
    pub position: Pubkey,
    pub owner: Pubkey,
    /// USDC that left the owner's account inside the brackets.
    pub spent: u64,
    /// Legs with an output account (bit i = leg i); `outputs` and `received` follow in leg order.
    pub outputs_mask: u16,
    pub outputs: Vec<Pubkey>,
    /// How much each output account grew inside the brackets, in its token's base units.
    pub received: Vec<u64>,
}

#[event]
pub struct CreatorFeesClaimed {
    pub take: Pubkey,
    pub author: Pubkey,
    pub amount: u64,
}

/// `source_hash` commits to the market data the settler priced from, so anyone holding that
/// data can check the price later.
#[event]
pub struct EntryPricesRecorded {
    pub take: Pubkey,
    pub position: Pubkey,
    pub legs: u16,
    pub source_hash: [u8; 32],
}

#[event]
pub struct ExitPricesRecorded {
    pub take: Pubkey,
    pub position: Pubkey,
    pub legs: u16,
    pub source_hash: [u8; 32],
}

/// The owner sold the position before the horizon. It scores on prices at or after `exited_at`.
#[event]
pub struct PositionExited {
    pub take: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub exited_at: i64,
    /// The escrowed prediction share, returned to the owner at the sale.
    pub escrow_returned: u64,
    /// The cost basis sold: what was left after any partial sales.
    pub stake: u64,
}

#[event]
pub struct SalePricesRecorded {
    pub take: Pubkey,
    pub position: Pubkey,
    pub legs: u16,
    pub source_hash: [u8; 32],
}

#[event]
pub struct TakeSettled {
    pub take: Pubkey,
    pub author: Pubkey,
    pub result_bps: i64,
}

#[event]
pub struct PositionSettled {
    pub take: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub return_bps: i64,
    pub pnl: i64,
    pub scored: bool,
    /// Scored at its sale rather than at the horizon.
    pub exited: bool,
    /// Escrow returned to the owner.
    pub escrow_returned: u64,
    /// The cost basis this settlement scored: what was left after any partial sales.
    pub stake: u64,
}

/// The owner sold part of a position before the horizon (`sell_part`). The part scores on its
/// own sale prices and settles on its own (`PartSettled`); the rest runs on.
#[event]
pub struct PositionPartSold {
    pub take: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub seq: u16,
    pub bps: u16,
    pub stake_sold: u64,
    pub remaining_stake: u64,
    /// The sold fraction of the escrowed prediction and card share, returned to the owner.
    pub escrow_returned: u64,
    pub sold_at: i64,
}

#[event]
pub struct PartPricesRecorded {
    pub take: Pubkey,
    pub position: Pubkey,
    pub seq: u16,
    pub legs: u16,
    pub source_hash: [u8; 32],
}

#[event]
pub struct PartSettled {
    pub take: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub seq: u16,
    pub stake: u64,
    pub return_bps: i64,
    pub pnl: i64,
    pub scored: bool,
}

#[event]
pub struct BadgeMinted {
    pub owner: Pubkey,
    pub kind: BadgeKind,
    pub mint: Pubkey,
}

/// The author sold their buy-in: the take takes no new backs or fades, and settles on the sale's
/// prices (`settle_take`). Emitted after `PositionExited`, in the same instruction.
#[event]
pub struct TakeClosed {
    pub take: Pubkey,
    pub author: Pubkey,
    pub closed_at: i64,
}
