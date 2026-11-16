use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::ThesisError, events::*, state::*, utils::transfer_from_vault};

/// The owner sells a whole position before the take's horizon. Goes in the same transaction as
/// the owner's own swaps back to USDC (and Jupiter Lend withdrawals). Thesis never holds the
/// tokens, so this records the decision: the position then scores on the settler's prices at or
/// after this moment instead of at the horizon, and settles as soon as those prices land.
///
/// Each position exits once (the exit account sits at a PDA of the position). No fee: the
/// platform fee is charged on backs and fades only. Works while new positions are paused.
///
/// The author can sell their own buy-in too. Their own score uses the sale, but the take's
/// headline result still runs to the horizon on the buy-in's horizon prices.
///
/// The position's escrowed prediction share comes back here, in full:
/// paper legs aren't paid, so the amount never depends on a price, and the author's buy-in,
/// which settles only with its take, doesn't keep it locked until the horizon.
#[event_cpi]
#[derive(Accounts)]
pub struct ExitPosition<'info> {
    pub owner: Signer<'info>,
    /// Pays the exit's rent and gets it back at settlement.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub take: Account<'info, Take>,
    #[account(
        mut,
        has_one = take @ ThesisError::AccountMismatch,
        has_one = owner @ ThesisError::AccountMismatch
    )]
    pub position: Account<'info, Position>,
    #[account(
        init,
        payer = payer,
        space = Exit::space(take.legs.len()),
        seeds = [EXIT_SEED, position.key().as_ref()],
        bump
    )]
    pub exit: Account<'info, Exit>,
    pub system_program: Program<'info, System>,
    // The escrow return. After the original accounts, so their positions don't change.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = config.escrow_vault @ ThesisError::AccountMismatch)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The owner's USDC account, where the escrow goes back.
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ ThesisError::AccountMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_exit_position(ctx: Context<ExitPosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    require!(
        take.status == TakeStatus::Open,
        ThesisError::TakeAlreadySettled
    );
    require!(now < take.horizon_end, ThesisError::HorizonPassed);

    let escrow_returned = ctx.accounts.position.escrowed;
    let config = &ctx.accounts.config;
    transfer_from_vault(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.escrow_vault.to_account_info(),
        &ctx.accounts.usdc_mint.to_account_info(),
        &ctx.accounts.owner_usdc.to_account_info(),
        &config.to_account_info(),
        config.bump,
        escrow_returned,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let take = &ctx.accounts.take;
    let position = &mut ctx.accounts.position;
    position.exited = true;
    // Returned: settlement has nothing left to pay back.
    position.escrowed = 0;
    let exit = &mut ctx.accounts.exit;
    exit.position = position.key();
    exit.exited_at = now;
    exit.rent_payer = ctx.accounts.payer.key();
    exit.price_set = 0;
    exit.prices = vec![0; take.legs.len()];
    exit.bump = ctx.bumps.exit;

    emit_cpi!(PositionExited {
        take: take.key(),
        position: position.key(),
        owner: position.owner,
        side: position.side,
        exited_at: now,
        escrow_returned,
    });
    Ok(())
}
