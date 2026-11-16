use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    error::ThesisError,
    proof::{close_bracket, open_bracket, INSTRUCTIONS_SYSVAR_ID},
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct BeginTradeArgs {
    /// Legs whose output accounts this transaction's swaps fill (bit i = leg i), passed as
    /// remaining accounts in leg order. An account the swaps create (an associated token
    /// account) may not exist yet.
    pub outputs_mask: u16,
}

/// Goes first in a trade, before the owner's swaps: creates the position's trade ticket and
/// opens the first bracket (see `proof.rs`). The receipt (`create_take`, `back`, `fade`) checks
/// the ticket and closes it.
#[derive(Accounts)]
pub struct BeginTrade<'info> {
    pub owner: Signer<'info>,
    /// Pays the ticket's rent; the receipt's payer must be the same account, and gets it back.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: the position the receipt will create; only its address is used here. The receipt
    /// checks it's the position it opens.
    pub position: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + TradeTicket::INIT_SPACE,
        seeds = [TICKET_SEED, owner.key().as_ref(), position.key().as_ref()],
        bump
    )]
    pub ticket: Box<Account<'info, TradeTicket>>,
    #[account(
        constraint = owner_usdc.mint == config.usdc_mint
            && owner_usdc.owner == owner.key() @ ThesisError::TicketMismatch
    )]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the Instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_begin_trade<'info>(
    ctx: Context<'info, BeginTrade<'info>>,
    args: BeginTradeArgs,
) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let payer = ctx.accounts.payer.key();
    let ticket = &mut ctx.accounts.ticket;
    // A ticket left by a trade that never finished (a later transaction failed) starts over.
    // Only its owner can reach it (the owner is in its seeds), and only with the same payer, who
    // still gets the rent back.
    if ticket.owner != Pubkey::default() {
        require!(ticket.rent_payer == payer, ThesisError::TicketMismatch);
    }
    ticket.set_inner(TradeTicket {
        owner,
        position: ctx.accounts.position.key(),
        rent_payer: payer,
        owner_usdc: ctx.accounts.owner_usdc.key(),
        outputs: [Pubkey::default(); MAX_LEGS],
        spent: 0,
        grown: 0,
        received: [0; MAX_LEGS],
        named: 0,
        phoenix: 0,
        open_ix: TradeTicket::NO_BRACKET,
        open_mask: 0,
        usdc_start: 0,
        outputs_start: [0; MAX_LEGS],
        bump: ctx.bumps.ticket,
    });
    let key = ctx.accounts.ticket.key();
    open_bracket(
        &mut ctx.accounts.ticket,
        &key,
        &ctx.accounts.instructions,
        &ctx.accounts.config,
        ctx.accounts.owner_usdc.amount,
        args.outputs_mask,
        ctx.remaining_accounts,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TradeStepArgs {
    /// Opens a bracket (first in a later transaction of the trade) or closes one (last in a
    /// transaction that isn't the trade's last).
    pub open: bool,
    /// Legs whose output accounts this bracket watches, as in `begin_trade`. Closing must name
    /// the same legs it opened with.
    pub outputs_mask: u16,
}

/// A trade that doesn't fit in one transaction: every transaction but the last ends with
/// `trade_step` (closing its bracket), and every one but the first starts with it (opening one).
#[derive(Accounts)]
pub struct TradeStep<'info> {
    pub owner: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = owner @ ThesisError::TicketMismatch,
        has_one = owner_usdc @ ThesisError::TicketMismatch
    )]
    pub ticket: Box<Account<'info, TradeTicket>>,
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the Instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_trade_step<'info>(
    ctx: Context<'info, TradeStep<'info>>,
    args: TradeStepArgs,
) -> Result<()> {
    let key = ctx.accounts.ticket.key();
    let usdc = ctx.accounts.owner_usdc.amount;
    if args.open {
        open_bracket(
            &mut ctx.accounts.ticket,
            &key,
            &ctx.accounts.instructions,
            &ctx.accounts.config,
            usdc,
            args.outputs_mask,
            ctx.remaining_accounts,
        )
    } else {
        require!(
            args.outputs_mask == ctx.accounts.ticket.open_mask,
            ThesisError::OutputMismatch
        );
        close_bracket(
            &mut ctx.accounts.ticket,
            &key,
            &ctx.accounts.instructions,
            &ctx.accounts.config.usdc_mint,
            usdc,
            ctx.remaining_accounts,
        )
    }
}

/// Closes a ticket whose trade was abandoned, refunding its rent to whoever paid it.
#[derive(Accounts)]
pub struct CancelTrade<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = rent_payer,
        has_one = owner @ ThesisError::TicketMismatch,
        has_one = rent_payer @ ThesisError::TicketMismatch
    )]
    pub ticket: Box<Account<'info, TradeTicket>>,
    /// CHECK: the ticket's stored rent payer.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_cancel_trade(_ctx: Context<CancelTrade>) -> Result<()> {
    Ok(())
}
