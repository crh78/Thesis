pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod proof;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe");

/// Thesis: non-custodial receipts for takes. Users trade from their own wallets; this program
/// records each take, back and fade in the same transaction, splits the fee, records oracle
/// prices, settles results into profiles and mints "called it" badges.
#[program]
pub mod thesis {
    use super::*;

    // Admin

    pub fn init_config(
        ctx: Context<InitConfig>,
        settler: Pubkey,
        allowlist_admin: Pubkey,
        params: ConfigParams,
        trade_programs: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::admin::handle_init_config(
            ctx,
            settler,
            allowlist_admin,
            params,
            trade_programs,
        )
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::admin::handle_update_config(ctx, args)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    pub fn update_allowlist(
        ctx: Context<UpdateAllowlist>,
        args: UpdateAllowlistArgs,
    ) -> Result<()> {
        instructions::admin::handle_update_allowlist(ctx, args)
    }

    pub fn accept_allowlist_admin(ctx: Context<AcceptAllowlistAdmin>) -> Result<()> {
        instructions::admin::handle_accept_allowlist_admin(ctx)
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        instructions::admin::handle_withdraw_fees(ctx, amount)
    }

    // Proof of trade

    pub fn begin_trade<'info>(
        ctx: Context<'info, BeginTrade<'info>>,
        args: BeginTradeArgs,
    ) -> Result<()> {
        instructions::trade::handle_begin_trade(ctx, args)
    }

    pub fn trade_step<'info>(
        ctx: Context<'info, TradeStep<'info>>,
        args: TradeStepArgs,
    ) -> Result<()> {
        instructions::trade::handle_trade_step(ctx, args)
    }

    pub fn cancel_trade(ctx: Context<CancelTrade>) -> Result<()> {
        instructions::trade::handle_cancel_trade(ctx)
    }

    // Takes and positions

    pub fn create_take<'info>(
        ctx: Context<'info, CreateTake<'info>>,
        args: CreateTakeArgs,
    ) -> Result<()> {
        instructions::take::handle_create_take(ctx, args)
    }

    pub fn back<'info>(
        ctx: Context<'info, OpenPosition<'info>>,
        args: OpenPositionArgs,
    ) -> Result<()> {
        instructions::position::handle_back(ctx, args)
    }

    pub fn fade<'info>(
        ctx: Context<'info, OpenPosition<'info>>,
        args: OpenPositionArgs,
    ) -> Result<()> {
        instructions::position::handle_fade(ctx, args)
    }

    pub fn exit_position(ctx: Context<ExitPosition>) -> Result<()> {
        instructions::exit::handle_exit_position(ctx)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::position::handle_claim_creator_fees(ctx)
    }

    // Prices

    pub fn record_entry_prices(ctx: Context<RecordPrices>, args: RecordPricesArgs) -> Result<()> {
        instructions::prices::handle_record_entry_prices(ctx, args)
    }

    pub fn record_exit_prices(ctx: Context<RecordPrices>, args: RecordPricesArgs) -> Result<()> {
        instructions::prices::handle_record_exit_prices(ctx, args)
    }

    pub fn record_sale_prices(
        ctx: Context<RecordSalePrices>,
        args: RecordPricesArgs,
    ) -> Result<()> {
        instructions::prices::handle_record_sale_prices(ctx, args)
    }

    // Settlement

    pub fn settle_take(ctx: Context<SettleTake>) -> Result<()> {
        instructions::settle::handle_settle_take(ctx)
    }

    pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
        instructions::settle::handle_settle_position(ctx)
    }

    pub fn mint_badge(ctx: Context<MintBadge>, kind: BadgeKind) -> Result<()> {
        instructions::badge::handle_mint_badge(ctx, kind)
    }
}
