use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    state::*,
    utils::{part_return_bps, position_return_bps, sale_return_bps, transfer_from_vault},
};

/// Badge thresholds tracked on the author's profile, in bps.
const OVER_50_BPS: i64 = 5_000;
const OVER_100_BPS: i64 = 10_000;
const OVER_1000_BPS: i64 = 100_000;

/// Finalizes a take: its headline result is the author's buy-in, entry to exit. Anyone can call
/// it. Must run before held positions and the author's buy-in are settled.
///
/// Once the author has sold (the take is `Closed`), it settles on the sale's prices, before the
/// horizon. Otherwise it settles at the horizon, on the buy-in's horizon prices.
///
/// If the author's prices are still missing once `max_price_delay_secs` has passed since the
/// sale (or the horizon end), the take settles at 0% so its positions aren't stuck.
#[event_cpi]
#[derive(Accounts)]
pub struct SettleTake<'info> {
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub take: Account<'info, Take>,
    #[account(
        has_one = take @ ThesisError::AccountMismatch,
        constraint = author_position.owner == take.author
            && author_position.id == AUTHOR_POSITION_ID @ ThesisError::AccountMismatch
    )]
    pub author_position: Account<'info, Position>,
    #[account(mut, constraint = author_profile.owner == take.author @ ThesisError::AccountMismatch)]
    pub author_profile: Account<'info, Profile>,
    /// The author's buy-in's exit account (its PDA; clients always pass it).
    /// CHECK: read only once the take is closed, then it must be an `Exit` naming the author's
    /// buy-in. Only the author's `exit_position` closes a take, and it always creates this
    /// account, so a closed take can't settle on horizon prices instead.
    pub author_exit: UncheckedAccount<'info>,
}

pub fn handle_settle_take(ctx: Context<SettleTake>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    let author_position = &ctx.accounts.author_position;
    let (priced, prices_from) = match take.status {
        TakeStatus::Settled => return err!(ThesisError::TakeAlreadySettled),
        TakeStatus::Open => {
            require!(now >= take.horizon_end, ThesisError::HorizonNotReached);
            (
                position_return_bps(&take.legs, author_position),
                take.horizon_end,
            )
        }
        TakeStatus::Closed => {
            let info = ctx.accounts.author_exit.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, ThesisError::AccountMismatch);
            let exit = Exit::try_deserialize(&mut &info.try_borrow_data()?[..])?;
            require_keys_eq!(
                exit.position,
                author_position.key(),
                ThesisError::AccountMismatch
            );
            (
                sale_return_bps(&take.legs, author_position, &exit),
                exit.exited_at,
            )
        }
    };
    let result_bps = match priced {
        Some(r) => r,
        None => {
            require!(
                grace_passed(prices_from, &ctx.accounts.config, now)?,
                ThesisError::PriceMissing
            );
            0
        }
    };

    let take = &mut ctx.accounts.take;
    take.status = TakeStatus::Settled;
    take.result_bps = result_bps;

    let profile = &mut ctx.accounts.author_profile;
    profile.takes_settled += 1;
    if priced.is_some() {
        profile.takes_over_50 += (result_bps >= OVER_50_BPS) as u32;
        profile.takes_over_100 += (result_bps >= OVER_100_BPS) as u32;
        profile.takes_over_1000 += (result_bps >= OVER_1000_BPS) as u32;
    }
    profile.best_take_bps = if profile.takes_settled == 1 {
        result_bps
    } else {
        profile.best_take_bps.max(result_bps)
    };

    emit_cpi!(TakeSettled {
        take: take.key(),
        author: take.author,
        result_bps,
    });
    Ok(())
}

/// Folds a position's result into its owner's profile, then closes the position and refunds
/// its rent to whoever paid it. Anyone can call it; the rent never goes to the caller.
///
/// A held position settles after its take, on its horizon prices (so after the horizon, even when
/// the take settled early on the author's sale). A sold one (`exit_position`) settles on its sale
/// prices, as soon as they're recorded, and its exit account closes with it. The author's buy-in
/// still waits for the take, whose headline result it sets.
///
/// A position whose prices never arrived (past the grace period) settles at 0% and unscored.
///
/// After partial sales (`sell_part`) it waits for every one to settle (`settle_part`), then
/// scores what's left (`remaining`); it counts as a win when its partial sales' P&L plus this
/// one's is above 0.
#[event_cpi]
#[derive(Accounts)]
pub struct SettlePosition<'info> {
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub take: Account<'info, Take>,
    #[account(mut, has_one = take, has_one = rent_payer, close = rent_payer)]
    pub position: Account<'info, Position>,
    #[account(mut, constraint = owner_profile.owner == position.owner @ ThesisError::AccountMismatch)]
    pub owner_profile: Account<'info, Profile>,
    #[account(mut)]
    pub rent_payer: SystemAccount<'info>,
    /// The position's exit account if the owner sold it (any account otherwise: pass `rent_payer`).
    /// CHECK: read only for a sold position, then it must be an `Exit` naming this position.
    /// `exit_position` is the only way to mark a position sold, and it always creates this
    /// account at its PDA, so a sold position can't settle at the horizon instead.
    #[account(mut)]
    pub exit: UncheckedAccount<'info>,
    /// Gets the exit's rent back. Any account when there's no exit (pass `rent_payer`).
    #[account(mut)]
    pub exit_rent_payer: SystemAccount<'info>,
    /// Pays the position's escrowed prediction share back (nothing moves when it's 0).
    #[account(mut, address = config.escrow_vault @ ThesisError::AccountMismatch)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The owner's USDC account, where the escrow goes back.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = position.owner,
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ ThesisError::AccountMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_settle_position(ctx: Context<SettlePosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let exit_info = ctx.accounts.exit.to_account_info();
    let exit = if ctx.accounts.position.exited {
        require_keys_eq!(*exit_info.owner, crate::ID, ThesisError::AccountMismatch);
        let exit = Exit::try_deserialize(&mut &exit_info.try_borrow_data()?[..])?;
        require_keys_eq!(
            exit.position,
            ctx.accounts.position.key(),
            ThesisError::AccountMismatch
        );
        Some(exit)
    } else {
        None
    };
    let take = &ctx.accounts.take;
    let position = &ctx.accounts.position;
    // Partial sales settle first: their P&L feeds the position's win.
    require!(
        position.parts_settled == position.parts,
        ThesisError::PartsNotSettled
    );
    let is_author_buy_in = position.id == AUTHOR_POSITION_ID && position.owner == take.author;
    if exit.is_none() || is_author_buy_in {
        require!(
            take.status == TakeStatus::Settled,
            ThesisError::TakeNotSettled
        );
    }

    let (priced, prices_from) = match &exit {
        Some(e) => (sale_return_bps(&take.legs, position, e), e.exited_at),
        None => (position_return_bps(&take.legs, position), take.horizon_end),
    };
    let (return_bps, scored) = match priced {
        Some(r) => (r, position.scored),
        None => {
            require!(
                grace_passed(prices_from, &ctx.accounts.config, now)?,
                ThesisError::PriceMissing
            );
            (0, false)
        }
    };
    // Scored on what's left after any partial sales (each scored its own part).
    let stake = position.remaining;
    let pnl = i64::try_from((stake as i128) * (return_bps as i128) / BPS_DENOMINATOR as i128)
        .map_err(|_| error!(ThesisError::MathOverflow))?;
    // A win counts the whole position: its partial sales' P&L plus this one.
    let total_pnl = position
        .realized_pnl
        .checked_add(pnl)
        .ok_or(ThesisError::MathOverflow)?;

    let profile = &mut ctx.accounts.owner_profile;
    profile.positions_settled += 1;
    if scored {
        profile.scored_positions += 1;
        profile.scored_stake = profile
            .scored_stake
            .checked_add(stake)
            .ok_or(ThesisError::MathOverflow)?;
        profile.scored_pnl = profile
            .scored_pnl
            .checked_add(pnl)
            .ok_or(ThesisError::MathOverflow)?;
        profile.wins += (total_pnl > 0) as u32;
    }

    let take_key = ctx.accounts.take.key();
    let take = &mut ctx.accounts.take;
    take.open_positions = take.open_positions.saturating_sub(1);

    let exited = exit.is_some();
    if let Some(e) = exit {
        require_keys_eq!(
            e.rent_payer,
            ctx.accounts.exit_rent_payer.key(),
            ThesisError::AccountMismatch
        );
        close_account(&exit_info, &ctx.accounts.exit_rent_payer.to_account_info())?;
    }

    // The prediction and card share comes back in full: its paper result only counts in the
    // score. A sold position got it back at the sale, so this is 0 for it.
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

    emit_cpi!(PositionSettled {
        take: take_key,
        position: ctx.accounts.position.key(),
        owner: ctx.accounts.position.owner,
        side: ctx.accounts.position.side,
        return_bps,
        pnl,
        scored,
        exited,
        escrow_returned,
        stake,
    });
    Ok(())
}

/// Settles one partial sale (`sell_part`): folds its P&L, entry to its sale, on the cost basis it
/// sold, into the owner's profile and the position's `realized_pnl`, then closes it and refunds
/// its rent to whoever paid it. Anyone can call it. A position's partial sales settle in order
/// (seq = `parts_settled`), each as soon as its prices are in, before the position itself.
///
/// It doesn't wait for the take, even for the author's buy-in: the take's headline result is the
/// basket's return to the author's final sale, which a partial sale doesn't set.
///
/// A part whose prices never arrived (past the grace period after its sale) settles at 0% and
/// unscored.
#[event_cpi]
#[derive(Accounts)]
pub struct SettlePart<'info> {
    pub config: Account<'info, Config>,
    pub take: Account<'info, Take>,
    #[account(mut, has_one = take @ ThesisError::AccountMismatch)]
    pub position: Account<'info, Position>,
    #[account(mut, constraint = owner_profile.owner == position.owner @ ThesisError::AccountMismatch)]
    pub owner_profile: Account<'info, Profile>,
    #[account(
        mut,
        has_one = position @ ThesisError::AccountMismatch,
        has_one = rent_payer @ ThesisError::AccountMismatch,
        close = rent_payer
    )]
    pub part_sale: Account<'info, PartSale>,
    #[account(mut)]
    pub rent_payer: SystemAccount<'info>,
}

pub fn handle_settle_part(ctx: Context<SettlePart>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    let position = &ctx.accounts.position;
    let part = &ctx.accounts.part_sale;
    require!(
        part.seq == position.parts_settled,
        ThesisError::PartsNotSettled
    );
    let (return_bps, scored) = match part_return_bps(&take.legs, position, part) {
        Some(r) => (r, position.scored),
        None => {
            require!(
                grace_passed(part.sold_at, &ctx.accounts.config, now)?,
                ThesisError::PriceMissing
            );
            (0, false)
        }
    };
    let pnl = i64::try_from((part.stake as i128) * (return_bps as i128) / BPS_DENOMINATOR as i128)
        .map_err(|_| error!(ThesisError::MathOverflow))?;

    if scored {
        let profile = &mut ctx.accounts.owner_profile;
        profile.scored_stake = profile
            .scored_stake
            .checked_add(part.stake)
            .ok_or(ThesisError::MathOverflow)?;
        profile.scored_pnl = profile
            .scored_pnl
            .checked_add(pnl)
            .ok_or(ThesisError::MathOverflow)?;
    }

    let (seq, stake) = (part.seq, part.stake);
    let position = &mut ctx.accounts.position;
    position.realized_pnl = position
        .realized_pnl
        .checked_add(pnl)
        .ok_or(ThesisError::MathOverflow)?;
    position.parts_settled += 1;

    emit_cpi!(PartSettled {
        take: ctx.accounts.take.key(),
        position: position.key(),
        owner: position.owner,
        side: position.side,
        seq,
        stake,
        return_bps,
        pnl,
        scored,
    });
    Ok(())
}

/// True once the settler has had `max_price_delay_secs` after `from` (the horizon end, or a
/// sale) to post prices.
fn grace_passed(from: i64, config: &Config, now: i64) -> Result<bool> {
    let grace_end = from
        .checked_add(config.params.max_price_delay_secs)
        .ok_or(ThesisError::MathOverflow)?;
    Ok(now > grace_end)
}

/// Closes a program-owned account the way Anchor's `close` constraint does: lamports to
/// `destination`, then the account back to the system program with no data.
fn close_account<'info>(info: &AccountInfo<'info>, destination: &AccountInfo<'info>) -> Result<()> {
    let lamports = info.lamports();
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(lamports)
        .ok_or(ThesisError::MathOverflow)?;
    **info.try_borrow_mut_lamports()? = 0;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
    Ok(())
}
