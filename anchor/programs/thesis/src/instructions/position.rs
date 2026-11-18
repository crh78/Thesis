use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    proof::{close_bracket, finish_trade, required_outputs, INSTRUCTIONS_SYSVAR_ID},
    state::*,
    utils::{escrow_share, fee_split, included_legs, transfer_from_user, validate_legs_mask},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenPositionArgs {
    /// Chosen by the client; with the take and owner, it fixes the position's address.
    /// 0 is reserved for the author's buy-in.
    pub id: u64,
    /// USDC base units.
    pub stake: u64,
    /// Bit i set = leg i is included. The Blink includes only spot and yield legs;
    /// a fade includes only fadeable legs.
    pub legs_mask: u16,
}

/// Shared by `back` and `fade`. Goes last in the owner's trade, after `begin_trade` and the swaps
/// (and in the trade's last transaction when it takes several). It closes the trade's last
/// bracket and requires the owner's USDC to have dropped by at least the stake inside the
/// trade's brackets, and each included leg's output account to have grown: a token account for
/// a back's spot, yield and card legs, a Phoenix trader account for its perp legs and for a
/// fade's Phoenix shorts. Remaining accounts: the output accounts the last bracket opened with, in leg order.
#[event_cpi]
#[derive(Accounts)]
#[instruction(args: OpenPositionArgs)]
pub struct OpenPosition<'info> {
    pub owner: Signer<'info>,
    /// Pays rent and gets it back at settlement: the app's fee payer for Privy users,
    /// otherwise the owner.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = fee_vault, has_one = creator_vault, has_one = usdc_mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub take: Account<'info, Take>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub owner_profile: Account<'info, Profile>,
    #[account(
        init,
        payer = payer,
        space = Position::space(take.legs.len()),
        seeds = [POSITION_SEED, take.key().as_ref(), owner.key().as_ref(), &args.id.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub creator_vault: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// From `begin_trade`. Tickets exist only at their PDA (`[TICKET_SEED, owner, position]`), so
    /// the stored owner and position identify it. Closed here, refunding its rent to the payer.
    #[account(
        mut,
        close = payer,
        constraint = ticket.owner == owner.key()
            && ticket.position == position.key()
            && ticket.rent_payer == payer.key()
            && ticket.owner_usdc == owner_usdc.key() @ ThesisError::TicketMismatch
    )]
    pub ticket: Box<Account<'info, TradeTicket>>,
    /// CHECK: the Instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// Receives the stake's prediction share (see `escrow_share`), returned at a sale or settlement.
    #[account(mut, address = config.escrow_vault @ ThesisError::AccountMismatch)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

pub fn handle_back<'info>(
    ctx: Context<'info, OpenPosition<'info>>,
    args: OpenPositionArgs,
) -> Result<()> {
    open_position(ctx, args, Side::Back)
}

pub fn handle_fade<'info>(
    ctx: Context<'info, OpenPosition<'info>>,
    args: OpenPositionArgs,
) -> Result<()> {
    open_position(ctx, args, Side::Fade)
}

fn open_position<'info>(
    ctx: Context<'info, OpenPosition<'info>>,
    args: OpenPositionArgs,
    side: Side,
) -> Result<()> {
    let params = ctx.accounts.config.params;
    require!(!params.paused, ThesisError::Paused);
    require!(
        args.id != AUTHOR_POSITION_ID,
        ThesisError::InvalidPositionId
    );
    require!(args.stake > 0, ThesisError::ZeroStake);

    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    require!(
        take.status == TakeStatus::Open && now < take.horizon_end,
        ThesisError::TakeClosed
    );
    let legs = take.legs.len();
    validate_legs_mask(args.legs_mask, legs)?;
    if side == Side::Fade {
        // An author can't bet against their own call.
        require_keys_neq!(
            ctx.accounts.owner.key(),
            take.author,
            ThesisError::AuthorCannotFade
        );
        require!(
            included_legs(args.legs_mask, &take.legs).all(|leg| leg.fade_via != FadeVia::None),
            ThesisError::LegNotFadeable
        );
        // Security review L-3: a fade holds the other side of each leg, and the program checks
        // it. Prediction legs are escrowed in full; legs shorted on Phoenix need a short the
        // trade opened (`required_outputs`). Nothing else can fade.
        require!(
            included_legs(args.legs_mask, &take.legs).all(|leg| leg.kind == LegKind::Prediction
                || leg.fade_via == FadeVia::PhoenixShort),
            ThesisError::FadeNeedsPredictionLegs
        );
    }

    // The prediction and card share isn't traded: it's held in escrow (paper fills at Gemini's
    // prices and at cards' insured values).
    let escrowed = escrow_share(&take.legs, args.legs_mask, args.stake)?;

    // Proof of trade, before the fee moves: the balance read here is the one the swaps left.
    let required = required_outputs(&take.legs, args.legs_mask, side);
    let ticket_key = ctx.accounts.ticket.key();
    close_bracket(
        &mut ctx.accounts.ticket,
        &ticket_key,
        &ctx.accounts.instructions,
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.owner_usdc.amount,
        ctx.remaining_accounts,
    )?;
    let proved = finish_trade(&ctx.accounts.ticket, args.stake - escrowed, required)?;
    emit_cpi!(proved);

    let take = &ctx.accounts.take;
    let owner = ctx.accounts.owner.key();
    let is_author = owner == take.author;
    let (fee, creator_fee) = fee_split(args.stake, &params, is_author)?;
    let platform_fee = fee - creator_fee;

    let token_program = ctx.accounts.token_program.to_account_info();
    let from = ctx.accounts.owner_usdc.to_account_info();
    let mint = ctx.accounts.usdc_mint.to_account_info();
    let authority = ctx.accounts.owner.to_account_info();
    let decimals = ctx.accounts.usdc_mint.decimals;
    transfer_from_user(
        &token_program,
        &from,
        &mint,
        &ctx.accounts.fee_vault.to_account_info(),
        &authority,
        platform_fee,
        decimals,
    )?;
    transfer_from_user(
        &token_program,
        &from,
        &mint,
        &ctx.accounts.creator_vault.to_account_info(),
        &authority,
        creator_fee,
        decimals,
    )?;
    transfer_from_user(
        &token_program,
        &from,
        &mint,
        &ctx.accounts.escrow_vault.to_account_info(),
        &authority,
        escrowed,
        decimals,
    )?;

    let scored = args.stake >= params.min_stake;
    let take_key = ctx.accounts.take.key();

    let take = &mut ctx.accounts.take;
    match side {
        Side::Back => {
            take.backers += 1;
            take.total_backed = take
                .total_backed
                .checked_add(args.stake)
                .ok_or(ThesisError::MathOverflow)?;
            take.platform_fees_from_backs = take
                .platform_fees_from_backs
                .checked_add(platform_fee)
                .ok_or(ThesisError::MathOverflow)?;
        }
        Side::Fade => {
            take.faders += 1;
            take.total_faded = take
                .total_faded
                .checked_add(args.stake)
                .ok_or(ThesisError::MathOverflow)?;
        }
    }
    take.open_positions += 1;
    take.creator_fees_unclaimed = take
        .creator_fees_unclaimed
        .checked_add(creator_fee)
        .ok_or(ThesisError::MathOverflow)?;

    let profile = &mut ctx.accounts.owner_profile;
    if profile.owner == Pubkey::default() {
        profile.owner = owner;
        profile.bump = ctx.bumps.owner_profile;
    }
    profile.positions_opened += 1;

    ctx.accounts.position.set_inner(Position {
        owner,
        take: take_key,
        id: args.id,
        rent_payer: ctx.accounts.payer.key(),
        side,
        stake: args.stake,
        opened_at: now,
        legs_mask: args.legs_mask,
        prices: vec![LegPrices::default(); legs],
        entry_set: 0,
        exit_set: 0,
        scored,
        exited: false,
        escrowed,
        bump: ctx.bumps.position,
    });

    emit_cpi!(PositionOpened {
        take: take_key,
        position: ctx.accounts.position.key(),
        owner,
        side,
        stake: args.stake,
        legs_mask: args.legs_mask,
        fee,
        creator_fee,
        scored,
        escrowed,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    pub author: Signer<'info>,
    #[account(has_one = creator_vault, has_one = usdc_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = author)]
    pub take: Account<'info, Take>,
    #[account(mut)]
    pub creator_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint, token::authority = author)]
    pub author_usdc: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let amount = ctx.accounts.take.creator_fees_unclaimed;
    require!(amount > 0, ThesisError::NothingToClaim);
    ctx.accounts.take.creator_fees_unclaimed = 0;

    let config = &ctx.accounts.config;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.creator_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.author_usdc.to_account_info(),
                authority: config.to_account_info(),
            },
            &[&[CONFIG_SEED, &[config.bump]]],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit_cpi!(CreatorFeesClaimed {
        take: ctx.accounts.take.key(),
        author: ctx.accounts.take.author,
        amount,
    });
    Ok(())
}
