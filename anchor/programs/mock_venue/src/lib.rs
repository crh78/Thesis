//! Test-only stand-in for a venue such as Jupiter, so the Thesis program's LiteSVM tests can run
//! real-shaped trades: a swap moves USDC from the user into a pool and pays the output token from
//! the pool to any destination, as a Jupiter route does. `call` invokes another program, for the
//! nested-CPI attack test. Never deployed anywhere but LiteSVM.
#![allow(unexpected_cfgs)]

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6wyYbfk7tXFAejgwcnQNSk7k4qRxe7TpBYSGAcwKEftn");

pub const POOL_SEED: &[u8] = b"pool";

#[program]
pub mod mock_venue {
    use super::*;

    /// Moves `amount_in` from the user's source into the pool, and `amount_out` from the pool's
    /// holdings to `destination`. Either amount can be 0.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, amount_out: u64) -> Result<()> {
        let program = ctx.accounts.token_program.key();
        if amount_in > 0 {
            token::transfer(
                CpiContext::new(
                    program,
                    Transfer {
                        from: ctx.accounts.source.to_account_info(),
                        to: ctx.accounts.pool_in.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;
        }
        if amount_out > 0 {
            let bump = [ctx.bumps.pool_authority];
            token::transfer(
                CpiContext::new_with_signer(
                    program,
                    Transfer {
                        from: ctx.accounts.pool_out.to_account_info(),
                        to: ctx.accounts.destination.to_account_info(),
                        authority: ctx.accounts.pool_authority.to_account_info(),
                    },
                    &[&[POOL_SEED, &bump]],
                ),
                amount_out,
            )?;
        }
        Ok(())
    }

    /// Invokes `remaining_accounts[0]` with the other remaining accounts and `data`.
    pub fn call<'info>(ctx: Context<'info, Call>, data: Vec<u8>) -> Result<()> {
        let (program, accounts) = ctx
            .remaining_accounts
            .split_first()
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        let ix = Instruction {
            program_id: program.key(),
            accounts: accounts
                .iter()
                .map(|a| {
                    if a.is_writable {
                        AccountMeta::new(a.key(), a.is_signer)
                    } else {
                        AccountMeta::new_readonly(a.key(), a.is_signer)
                    }
                })
                .collect(),
            data,
        };
        invoke_signed(&ix, accounts, &[])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_in: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_out: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: the pool's signing PDA.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Call {}
