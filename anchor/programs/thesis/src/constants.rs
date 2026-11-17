use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";

#[constant]
pub const CREATOR_VAULT_SEED: &[u8] = b"creator_vault";

/// Holds the prediction share of stakes (Gemini legs are paper-filled) until positions settle.
#[constant]
pub const ESCROW_VAULT_SEED: &[u8] = b"escrow_vault";

#[constant]
pub const PROFILE_SEED: &[u8] = b"profile";

#[constant]
pub const TAKE_SEED: &[u8] = b"take";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

#[constant]
pub const BADGE_SEED: &[u8] = b"badge";

#[constant]
pub const EXIT_SEED: &[u8] = b"exit";

/// A trade ticket, at `[TICKET_SEED, position]`: the proof-of-trade record for the position a
/// trade is about to open.
#[constant]
pub const TICKET_SEED: &[u8] = b"ticket";

/// Most programs the config can allow between `begin_trade` and a receipt.
pub const MAX_TRADE_PROGRAMS: usize = 8;

/// Id of the author's own buy-in position, created with the take.
#[constant]
pub const AUTHOR_POSITION_ID: u64 = 0;

#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard ceiling on the platform fee, in bps of the stake (1%, ten times the launch fee). The admin
/// sets the fee in the config but can never go above this, so a fee change can't take more than
/// 1% of a stake, even from a trade already signed (security review M-1).
/// Raising it takes a program upgrade.
#[constant]
pub const MAX_FEE_BPS: u16 = 100;

/// Prices are stored as u64 with 8 decimals (1 USD = 100_000_000).
#[constant]
pub const PRICE_DECIMALS: u8 = 8;

/// 1.0 in price units. Prediction legs are priced as odds from 0 to `PRICE_ONE`.
#[constant]
pub const PRICE_ONE: u64 = 100_000_000;

/// Hard cap on legs per take. `ConfigParams::max_legs` can be lower, never higher.
pub const MAX_LEGS: usize = 10;

/// Symbol on every "called it" badge mint.
#[constant]
pub const BADGE_SYMBOL: &str = "THESIS";

/// Badge metadata URIs are `{Config::badge_uri_base}{badge slug}.json`. A new config starts with
/// this placeholder until the admin sets the real base with `update_config` (
/// Supabase Storage's public `badges` bucket). Badges already minted keep the URI they were
/// minted with (the badge mint is its own update authority, so only the program could change it).
#[constant]
pub const DEFAULT_BADGE_URI_BASE: &str = "https://placeholder.thesis.invalid/badges/";

/// Longest `badge_uri_base`, in bytes. A Supabase Storage public URL is about 75.
pub const MAX_BADGE_URI_BASE_LEN: usize = 128;
