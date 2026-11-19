use anchor_lang::prelude::*;

#[error_code]
pub enum ThesisError {
    #[msg("New takes and positions are paused")]
    Paused,
    #[msg("Config values are out of range")]
    InvalidConfig,
    #[msg("A take needs at least one leg")]
    NoLegs,
    #[msg("Too many legs")]
    TooManyLegs,
    #[msg("Leg weights must add up to 100%")]
    WeightsMustSumTo100,
    #[msg("The same asset appears twice")]
    DuplicateLeg,
    #[msg("Leverage is only allowed on perp legs")]
    InvalidLeverage,
    #[msg("Horizon is outside the allowed range")]
    HorizonOutOfRange,
    #[msg("Stake is below the minimum")]
    StakeBelowMinimum,
    #[msg("Legs mask is empty or names legs that don't exist")]
    InvalidLegsMask,
    #[msg("A fade can only include legs that can be faded")]
    LegNotFadeable,
    #[msg("This take is closed to new positions")]
    TakeClosed,
    #[msg("This take hasn't reached its horizon yet")]
    HorizonNotReached,
    #[msg("This take is not settled yet")]
    TakeNotSettled,
    #[msg("This take is already settled")]
    TakeAlreadySettled,
    #[msg("This price is already recorded")]
    PriceAlreadySet,
    #[msg("A required price is missing")]
    PriceMissing,
    #[msg("Price was published before the trade or horizon end")]
    PriceTooEarly,
    #[msg("Price was published too long after the trade or horizon end")]
    PriceTooLate,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("This take didn't earn a badge")]
    BadgeNotEarned,
    #[msg("Position id 0 is reserved for the author's buy-in")]
    InvalidPositionId,
    #[msg("Stake must be more than zero")]
    ZeroStake,
    #[msg("Leg settings don't fit its kind")]
    InvalidLeg,
    #[msg("Not enough fees in the vault")]
    InsufficientFees,
    #[msg("Price is out of range for this leg")]
    InvalidPrice,
    #[msg("Account doesn't belong to this take or owner")]
    AccountMismatch,
    #[msg("This take has reached its horizon; positions settle instead of selling")]
    HorizonPassed,
    #[msg("Trade programs must be distinct, at most 8, and never a Token or System program")]
    InvalidTradePrograms,
    #[msg("Must be called directly by the transaction, not from another program")]
    NotTopLevel,
    #[msg("A program in the trade isn't one the config allows")]
    TradeProgramNotAllowed,
    #[msg(
        "A trade step must be closed later in the same transaction by trade_step or the receipt"
    )]
    BracketNotClosed,
    #[msg("A trade step is already open")]
    BracketAlreadyOpen,
    #[msg("No trade step is open in this transaction")]
    NoOpenBracket,
    #[msg("Trade ticket doesn't belong to this owner, position or payer")]
    TicketMismatch,
    #[msg("Output accounts don't match the trade")]
    OutputMismatch,
    #[msg("An output account isn't the owner's token account (or, for a perp leg or short, Phoenix trader account)")]
    InvalidOutputAccount,
    #[msg("The owner's USDC didn't drop by the stake during the trade")]
    StakeNotSpent,
    #[msg("A bought leg's output account didn't grow during the trade")]
    OutputNotBought,
    #[msg("Instructions sysvar is missing or malformed")]
    InvalidInstructionsSysvar,
    #[msg("This instruction of an allowed program can't run inside a trade")]
    TradeInstructionNotAllowed,
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("This key can't do that: wrong admin, or not the proposed one")]
    Unauthorized,
    #[msg("These prices would make the position's return too large to record")]
    ReturnOutOfRange,
    #[msg("A fade can only hold prediction legs and legs shorted on Phoenix")]
    FadeNeedsPredictionLegs,
    #[msg("The badge URI base must be an https:// URL ending in /, at most 128 bytes")]
    InvalidBadgeUriBase,
    #[msg("A take's author can't fade it")]
    AuthorCannotFade,
    #[msg("What's left after a partial sale must be at least the minimum stake; sell all instead")]
    RemainderBelowMinimum,
    #[msg("A partial sale sells 1 to 9,999 bps of what's left, and at least one base unit")]
    InvalidSaleFraction,
    #[msg("This position already has the most partial sales waiting to settle")]
    TooManyOpenSales,
    #[msg("Partial sales settle in order, and before the position itself")]
    PartsNotSettled,
    #[msg("This position is already sold")]
    AlreadySold,
}
