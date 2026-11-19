use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    state::*,
    utils::{part_sale_split, transfer_from_vault},
};

/// The owner sells part of a position before the take's horizon: `bps` of what's left (1 to
/// 9,999; selling all is `exit_position`). Goes in the same transaction as the owner's own swaps
/// of that fraction back to USDC (Jupiter Lend withdrawals, Phoenix reductions). Like
/// `exit_position`, Thesis never holds the tokens, so this records the decision: the part scores
/// on the settler's prices at or after this moment (`record_part_prices`), on the cost basis sold,
/// and settles on its own (`settle_part`), while the rest of the position runs on.
///
/// What's left must stay at least the config's minimum stake (`RemainderBelowMinimum`: sell all
/// instead), and at most `MAX_OPEN_PARTS` partial sales can wait to settle at once. No fee. Works
/// while new positions are paused. Never closes the take, even for the author's buy-in: only
/// selling all of it does.
///
/// The sold fraction of the escrowed prediction and card share comes back here (paper legs aren't
/// paid, so the amount never depends on a price).
#[event_cpi]
#[derive(Accounts)]
pub struct SellPart<'info> {
    pub owner: Signer<'info>,
    /// Pays the part's rent and gets it back when the part settles.
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
        space = PartSale::space(take.legs.len()),
        seeds = [PART_SALE_SEED, position.key().as_ref(), &position.parts.to_le_bytes()],
        bump
    )]
    pub part_sale: Account<'info, PartSale>,
    pub system_program: Program<'info, System>,
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

pub fn handle_sell_part(ctx: Context<SellPart>, bps: u16) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < ctx.accounts.take.horizon_end,
        ThesisError::HorizonPassed
    );
    let position = &ctx.accounts.position;
    require!(!position.exited, ThesisError::AlreadySold);
    require!(
        position.parts.saturating_sub(position.parts_settled) < MAX_OPEN_PARTS,
        ThesisError::TooManyOpenSales
    );
    let config = &ctx.accounts.config;
    let (sold, left) = part_sale_split(position.remaining, bps)?;
    require!(
        left >= config.params.min_stake,
        ThesisError::RemainderBelowMinimum
    );
    let escrow_returned =
        u64::try_from((position.escrowed as u128) * (bps as u128) / BPS_DENOMINATOR as u128)
            .map_err(|_| error!(ThesisError::MathOverflow))?;
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
    let seq = position.parts;
    position.remaining = left;
    position.escrowed -= escrow_returned;
    position.parts = seq.checked_add(1).ok_or(ThesisError::MathOverflow)?;

    let part = &mut ctx.accounts.part_sale;
    part.position = position.key();
    part.seq = seq;
    part.bps = bps;
    part.stake = sold;
    part.escrow_returned = escrow_returned;
    part.sold_at = now;
    part.rent_payer = ctx.accounts.payer.key();
    part.price_set = 0;
    part.prices = vec![0; take.legs.len()];
    part.bump = ctx.bumps.part_sale;

    emit_cpi!(PositionPartSold {
        take: take.key(),
        position: position.key(),
        owner: position.owner,
        side: position.side,
        seq,
        bps,
        stake_sold: sold,
        remaining_stake: left,
        escrow_returned,
        sold_at: now,
    });
    Ok(())
}
