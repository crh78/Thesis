use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    state::*,
    utils::{validate_badge_uri_base, validate_params, validate_trade_programs},
};

/// Creates the config and both fee vaults. Run once, right after deploying, by the program's
/// upgrade authority: otherwise anyone could call it first and become admin (security review H-1).
/// So initialize before making the program immutable.
#[event_cpi]
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [FEE_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
        token::token_program = token_program
    )]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [CREATOR_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
        token::token_program = token_program
    )]
    pub creator_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(
        init,
        payer = admin,
        seeds = [ESCROW_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
        token::token_program = token_program
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,
    /// This program's ProgramData (upgradeable loader): its upgrade authority must be `admin`.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ ThesisError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_init_config(
    ctx: Context<InitConfig>,
    settler: Pubkey,
    allowlist_admin: Pubkey,
    params: ConfigParams,
    trade_programs: Vec<Pubkey>,
) -> Result<()> {
    validate_params(&params)?;
    validate_trade_programs(&trade_programs)?;
    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        allowlist_admin,
        pending_admin: None,
        pending_allowlist_admin: None,
        settler,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        fee_vault: ctx.accounts.fee_vault.key(),
        creator_vault: ctx.accounts.creator_vault.key(),
        escrow_vault: ctx.accounts.escrow_vault.key(),
        params,
        bump: ctx.bumps.config,
        fee_vault_bump: ctx.bumps.fee_vault,
        creator_vault_bump: ctx.bumps.creator_vault,
        escrow_vault_bump: ctx.bumps.escrow_vault,
        trade_programs,
        badge_uri_base: DEFAULT_BADGE_URI_BASE.to_string(),
    });
    let event = config_event(config);
    emit_cpi!(event);
    Ok(())
}

fn config_event(config: &Config) -> ConfigUpdated {
    ConfigUpdated {
        admin: config.admin,
        allowlist_admin: config.allowlist_admin,
        pending_admin: config.pending_admin,
        pending_allowlist_admin: config.pending_allowlist_admin,
        settler: config.settler,
        params: config.params,
        trade_programs: config.trade_programs.clone(),
        badge_uri_base: config.badge_uri_base.clone(),
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateConfigArgs {
    pub params: ConfigParams,
    /// Proposes a new admin, who takes over by signing `accept_admin` (a mistyped key can't
    /// lose the role). Proposing again replaces the proposal; propose yourself to cancel it.
    pub new_admin: Option<Pubkey>,
    pub new_settler: Option<Pubkey>,
    /// Where badge metadata lives from now on (`{base}{slug}.json`). Badges already minted keep theirs.
    pub new_badge_uri_base: Option<String>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_params(&args.params)?;
    let config = &mut ctx.accounts.config;
    config.params = args.params;
    if let Some(admin) = args.new_admin {
        config.pending_admin = Some(admin);
    }
    if let Some(settler) = args.new_settler {
        config.settler = settler;
    }
    if let Some(base) = args.new_badge_uri_base {
        validate_badge_uri_base(&base)?;
        config.badge_uri_base = base;
    }
    let event = config_event(config);
    emit_cpi!(event);
    Ok(())
}

/// The proposed admin takes over (second step of the hand-over).
#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        constraint = config.pending_admin == Some(new_admin.key()) @ ThesisError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.new_admin.key();
    config.pending_admin = None;
    let event = config_event(config);
    emit_cpi!(event);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateAllowlistArgs {
    /// Replaces the whole trade allowlist when set.
    pub new_trade_programs: Option<Vec<Pubkey>>,
    /// Proposes a new allowlist admin, who takes over by signing `accept_allowlist_admin`.
    pub new_allowlist_admin: Option<Pubkey>,
}

/// The allowlist admin's instruction: the programs a trade may call, and its own hand-over.
#[event_cpi]
#[derive(Accounts)]
pub struct UpdateAllowlist<'info> {
    pub allowlist_admin: Signer<'info>,
    #[account(mut, has_one = allowlist_admin @ ThesisError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn handle_update_allowlist(
    ctx: Context<UpdateAllowlist>,
    args: UpdateAllowlistArgs,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(programs) = args.new_trade_programs {
        validate_trade_programs(&programs)?;
        config.trade_programs = programs;
    }
    if let Some(key) = args.new_allowlist_admin {
        config.pending_allowlist_admin = Some(key);
    }
    let event = config_event(config);
    emit_cpi!(event);
    Ok(())
}

/// The proposed allowlist admin takes over.
#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAllowlistAdmin<'info> {
    pub new_allowlist_admin: Signer<'info>,
    #[account(
        mut,
        constraint = config.pending_allowlist_admin == Some(new_allowlist_admin.key())
            @ ThesisError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_accept_allowlist_admin(ctx: Context<AcceptAllowlistAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.allowlist_admin = ctx.accounts.new_allowlist_admin.key();
    config.pending_allowlist_admin = None;
    let event = config_event(config);
    emit_cpi!(event);
    Ok(())
}

/// Moves platform fees out of the fee vault. Creator fees sit in their own vault and can't be
/// withdrawn here.
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin, has_one = fee_vault, has_one = usdc_mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    require!(amount > 0, ThesisError::NothingToClaim);
    require!(
        amount <= ctx.accounts.fee_vault.amount,
        ThesisError::InsufficientFees
    );
    let config = &ctx.accounts.config;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.fee_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: config.to_account_info(),
            },
            &[&[CONFIG_SEED, &[config.bump]]],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;
    emit_cpi!(FeesWithdrawn {
        destination: ctx.accounts.destination.key(),
        amount,
    });
    Ok(())
}
