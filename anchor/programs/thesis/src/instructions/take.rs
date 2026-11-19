use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    proof::{close_bracket, finish_trade, required_outputs, INSTRUCTIONS_SYSVAR_ID},
    state::*,
    utils::{escrow_share, fee_split, transfer_from_user, validate_legs, validate_legs_mask},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateTakeArgs {
    /// Chosen by the client; with the author, it fixes the take's address.
    pub id: u64,
    pub claim_hash: [u8; 32],
    pub risk: Risk,
    pub horizon_end: i64,
    pub legs: Vec<LegSpec>,
    /// The author's required buy-in, in USDC base units.
    pub stake: u64,
    /// Legs the author's buy-in actually bought (bit `i` = leg `i`), as on a back: a leg with no
    /// venue yet (or no route right now) is left out, so it never needs a price and the take's
    /// result is the author's real basket.
    pub legs_mask: u16,
}

/// Creates the take and the author's buy-in position in one step: buying in is required to post.
/// Goes last in the author's trade, with the same proof-of-trade checks as `back` (the ticket is
/// for the author's buy-in position). Remaining accounts: the output accounts the trade's last
/// bracket opened with, in leg order.
#[event_cpi]
#[derive(Accounts)]
#[instruction(args: CreateTakeArgs)]
pub struct CreateTake<'info> {
    pub author: Signer<'info>,
    /// Pays rent: the app's fee payer for Privy users, otherwise the author.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = fee_vault, has_one = usdc_mint)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, author.key().as_ref()],
        bump
    )]
    pub author_profile: Account<'info, Profile>,
    #[account(
        init,
        payer = payer,
        space = Take::space(args.legs.len().min(MAX_LEGS)),
        seeds = [TAKE_SEED, author.key().as_ref(), &args.id.to_le_bytes()],
        bump
    )]
    pub take: Account<'info, Take>,
    #[account(
        init,
        payer = payer,
        space = Position::space(args.legs.len().min(MAX_LEGS)),
        seeds = [
            POSITION_SEED,
            take.key().as_ref(),
            author.key().as_ref(),
            &AUTHOR_POSITION_ID.to_le_bytes()
        ],
        bump
    )]
    pub author_position: Account<'info, Position>,
    #[account(mut, token::mint = usdc_mint, token::authority = author)]
    pub author_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// From `begin_trade`, for the author's buy-in position. Closed here, refunding the payer.
    #[account(
        mut,
        close = payer,
        constraint = ticket.owner == author.key()
            && ticket.position == author_position.key()
            && ticket.rent_payer == payer.key()
            && ticket.owner_usdc == author_usdc.key() @ ThesisError::TicketMismatch
    )]
    pub ticket: Box<Account<'info, TradeTicket>>,
    /// CHECK: the Instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// Receives the stake's prediction share (see `escrow_share`), returned at a sale or settlement.
    #[account(mut, address = config.escrow_vault @ ThesisError::AccountMismatch)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

pub fn handle_create_take<'info>(
    ctx: Context<'info, CreateTake<'info>>,
    args: CreateTakeArgs,
) -> Result<()> {
    let params = ctx.accounts.config.params;
    require!(!params.paused, ThesisError::Paused);
    validate_legs(&args.legs, params.max_legs)?;
    validate_legs_mask(args.legs_mask, args.legs.len())?;

    let now = Clock::get()?.unix_timestamp;
    let horizon = args
        .horizon_end
        .checked_sub(now)
        .ok_or(ThesisError::MathOverflow)?;
    require!(
        horizon >= params.min_horizon_secs && horizon <= params.max_horizon_secs,
        ThesisError::HorizonOutOfRange
    );
    require!(
        args.stake >= params.min_stake,
        ThesisError::StakeBelowMinimum
    );

    // The prediction share is held in escrow, not traded (paper fills at Gemini's prices).
    let escrowed = escrow_share(&args.legs, args.legs_mask, args.stake)?;

    // Proof of trade, before the fee moves.
    let ticket_key = ctx.accounts.ticket.key();
    close_bracket(
        &mut ctx.accounts.ticket,
        &ticket_key,
        &ctx.accounts.instructions,
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.author_usdc.amount,
        ctx.remaining_accounts,
    )?;
    let proved = finish_trade(
        &ctx.accounts.ticket,
        args.stake - escrowed,
        required_outputs(&args.legs, args.legs_mask, Side::Back),
    )?;
    emit_cpi!(proved);

    // The author's own buy-in pays the fee, with no creator share.
    let (fee, _) = fee_split(args.stake, &params, true)?;
    transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.author_usdc.to_account_info(),
        &ctx.accounts.usdc_mint.to_account_info(),
        &ctx.accounts.fee_vault.to_account_info(),
        &ctx.accounts.author.to_account_info(),
        fee,
        ctx.accounts.usdc_mint.decimals,
    )?;
    transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.author_usdc.to_account_info(),
        &ctx.accounts.usdc_mint.to_account_info(),
        &ctx.accounts.escrow_vault.to_account_info(),
        &ctx.accounts.author.to_account_info(),
        escrowed,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let author = ctx.accounts.author.key();
    let take_key = ctx.accounts.take.key();
    let legs_mask = args.legs_mask;

    let profile = &mut ctx.accounts.author_profile;
    if profile.owner == Pubkey::default() {
        profile.owner = author;
        profile.bump = ctx.bumps.author_profile;
    }
    profile.takes_created += 1;
    profile.positions_opened += 1;

    ctx.accounts.take.set_inner(Take {
        author,
        id: args.id,
        claim_hash: args.claim_hash,
        risk: args.risk,
        created_at: now,
        horizon_end: args.horizon_end,
        legs: args.legs.clone(),
        backers: 1,
        faders: 0,
        total_backed: args.stake,
        total_faded: 0,
        open_positions: 1,
        creator_fees_unclaimed: 0,
        platform_fees_from_backs: 0,
        status: TakeStatus::Open,
        result_bps: 0,
        bump: ctx.bumps.take,
        closed_at: 0,
    });

    ctx.accounts.author_position.set_inner(Position {
        owner: author,
        take: take_key,
        id: AUTHOR_POSITION_ID,
        rent_payer: ctx.accounts.payer.key(),
        side: Side::Back,
        stake: args.stake,
        opened_at: now,
        legs_mask,
        prices: vec![LegPrices::default(); args.legs.len()],
        entry_set: 0,
        exit_set: 0,
        scored: true,
        exited: false,
        escrowed,
        bump: ctx.bumps.author_position,
        remaining: args.stake,
        parts: 0,
        parts_settled: 0,
        realized_pnl: 0,
    });

    emit_cpi!(TakeCreated {
        take: take_key,
        author,
        claim_hash: args.claim_hash,
        risk: args.risk,
        horizon_end: args.horizon_end,
        legs: args.legs.len() as u8,
        stake: args.stake,
    });
    emit_cpi!(PositionOpened {
        take: take_key,
        position: ctx.accounts.author_position.key(),
        owner: author,
        side: Side::Back,
        stake: args.stake,
        legs_mask,
        fee,
        creator_fee: 0,
        scored: true,
        escrowed,
    });
    Ok(())
}
