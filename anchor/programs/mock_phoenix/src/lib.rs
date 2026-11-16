//! Test-only stand-in for Phoenix perps, deployed in LiteSVM at Phoenix's own program id, so the
//! Thesis program's proof of trade can be tested against a Phoenix-owned trader account. Its
//! instructions have Phoenix's names (so the same 8-byte prefixes), but they only move a number:
//! `place_market_order` adds base lots to the account's first position. The tests build the
//! account's bytes themselves (tests/common: `phoenix_trader_data`). Never deployed anywhere but
//! LiteSVM.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");

/// Where the position entries start in a trader account (see the Thesis program's `proof.rs`).
const ENTRIES: usize = 224;

#[program]
pub mod mock_phoenix {
    use super::*;

    /// Adds `base_lots` (negative for a short) to the first position, creating it if needed.
    pub fn place_market_order(ctx: Context<Trade>, base_lots: i64) -> Result<()> {
        let mut data = ctx.accounts.trader.try_borrow_mut_data()?;
        let len = u64::from_le_bytes(data[ENTRIES..ENTRIES + 8].try_into().unwrap());
        if len == 0 {
            data[ENTRIES..ENTRIES + 8].copy_from_slice(&1u64.to_le_bytes());
            data[ENTRIES + 16..ENTRIES + 24].copy_from_slice(&39u64.to_le_bytes());
        }
        let at = ENTRIES + 24;
        let base = i64::from_le_bytes(data[at..at + 8].try_into().unwrap()) + base_lots;
        data[at..at + 8].copy_from_slice(&base.to_le_bytes());
        Ok(())
    }

    /// Does nothing: stands in for the collateral deposit, which Thesis allows inside a trade.
    pub fn deposit_funds(_ctx: Context<Trade>) -> Result<()> {
        Ok(())
    }

    /// Does nothing: stands in for a withdrawal, which Thesis refuses inside a trade.
    pub fn withdraw_funds(_ctx: Context<Trade>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub authority: Signer<'info>,
    /// CHECK: a Phoenix-shaped trader account this program owns; only its position bytes change.
    #[account(mut, owner = crate::ID)]
    pub trader: UncheckedAccount<'info>,
}
