use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ThesisError,
    events::*,
    state::*,
    utils::{check_return_fits, position_return_raw, priced_legs_mask, sale_return_raw},
};

/// One leg's price, signed for by the settler.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
#[cfg_attr(test, derive(Debug))]
pub struct LegPrice {
    pub leg: u8,
    /// 8 decimals. Prediction legs: odds between 0 and `PRICE_ONE` (entry strictly between).
    pub price: u64,
    /// When the source published this price (unix seconds). Must be the first price at or
    /// after the trade (entry), the horizon end (exit) or the sale, within `max_price_delay_secs`.
    pub published_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecordPricesArgs {
    pub prices: Vec<LegPrice>,
    /// Hash of the market data the settler priced from, kept in the event for audits.
    pub source_hash: [u8; 32],
}

/// The settler records prices for the token this position's owner actually bought.
/// Prices can arrive over several calls; each leg is set once.
#[event_cpi]
#[derive(Accounts)]
pub struct RecordPrices<'info> {
    pub settler: Signer<'info>,
    #[account(has_one = settler)]
    pub config: Account<'info, Config>,
    pub take: Account<'info, Take>,
    #[account(mut, has_one = take)]
    pub position: Account<'info, Position>,
}

/// The settler records sale prices for a position its owner sold (`exit_position`), at or after
/// the sale. Like the other prices, each leg is set once and can arrive over several calls.
#[event_cpi]
#[derive(Accounts)]
pub struct RecordSalePrices<'info> {
    pub settler: Signer<'info>,
    #[account(has_one = settler)]
    pub config: Account<'info, Config>,
    pub take: Account<'info, Take>,
    #[account(has_one = take)]
    pub position: Account<'info, Position>,
    #[account(mut, has_one = position)]
    pub exit: Account<'info, Exit>,
}

#[derive(Clone, Copy, PartialEq)]
#[cfg_attr(test, derive(Debug))]
enum Moment {
    Entry,
    /// At the horizon.
    Exit,
    /// At the owner's sale.
    Sale,
}

pub fn handle_record_entry_prices(
    ctx: Context<RecordPrices>,
    args: RecordPricesArgs,
) -> Result<()> {
    record_on_position(ctx, args, Moment::Entry)
}

pub fn handle_record_exit_prices(ctx: Context<RecordPrices>, args: RecordPricesArgs) -> Result<()> {
    record_on_position(ctx, args, Moment::Exit)
}

pub fn handle_record_sale_prices(
    ctx: Context<RecordSalePrices>,
    args: RecordPricesArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    let exit = &mut ctx.accounts.exit;
    let checked = check_prices(
        take,
        ctx.accounts.position.legs_mask,
        exit.price_set,
        &args.prices,
        exit.exited_at,
        ctx.accounts.config.params.max_price_delay_secs,
        now,
        Moment::Sale,
    )?;
    for &(i, price) in &checked.prices {
        exit.prices[i] = price;
    }
    exit.price_set |= checked.legs;
    let position = &ctx.accounts.position;
    check_return_fits(sale_return_raw(&take.legs, position, exit), position.stake)?;
    emit_cpi!(SalePricesRecorded {
        take: take.key(),
        position: ctx.accounts.position.key(),
        legs: checked.legs,
        source_hash: args.source_hash,
    });
    Ok(())
}

fn record_on_position(
    ctx: Context<RecordPrices>,
    args: RecordPricesArgs,
    moment: Moment,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let take = &ctx.accounts.take;
    let position: &mut Position = &mut ctx.accounts.position;

    let (from, already) = match moment {
        Moment::Entry => (position.opened_at, position.entry_set),
        _ => {
            require!(now >= take.horizon_end, ThesisError::HorizonNotReached);
            (take.horizon_end, position.exit_set)
        }
    };
    let checked = check_prices(
        take,
        position.legs_mask,
        already,
        &args.prices,
        from,
        ctx.accounts.config.params.max_price_delay_secs,
        now,
        moment,
    )?;
    for &(i, price) in &checked.prices {
        match moment {
            Moment::Entry => position.prices[i].entry = price,
            _ => position.prices[i].exit = price,
        }
    }
    match moment {
        Moment::Entry => position.entry_set |= checked.legs,
        _ => position.exit_set |= checked.legs,
    }
    check_return_fits(position_return_raw(&take.legs, position), position.stake)?;

    let take_key = ctx.accounts.take.key();
    let position_key = ctx.accounts.position.key();
    match moment {
        Moment::Entry => emit_cpi!(EntryPricesRecorded {
            take: take_key,
            position: position_key,
            legs: checked.legs,
            source_hash: args.source_hash,
        }),
        _ => emit_cpi!(ExitPricesRecorded {
            take: take_key,
            position: position_key,
            legs: checked.legs,
            source_hash: args.source_hash,
        }),
    }
    Ok(())
}

struct Checked {
    /// Bits of the legs this call records.
    legs: u16,
    prices: Vec<(usize, u64)>,
}

/// Validates a batch of prices for one position: each names a priced leg not yet set, was
/// published at or after `from` and within `max_delay` of it, and is in range for its leg.
#[allow(clippy::too_many_arguments)]
fn check_prices(
    take: &Take,
    legs_mask: u16,
    already: u16,
    prices: &[LegPrice],
    from: i64,
    max_delay: i64,
    now: i64,
    moment: Moment,
) -> Result<Checked> {
    let until = from
        .checked_add(max_delay)
        .ok_or(ThesisError::MathOverflow)?;
    let priced = priced_legs_mask(&take.legs, legs_mask);

    let mut out = Checked {
        legs: 0,
        prices: Vec::with_capacity(prices.len()),
    };
    for p in prices {
        let i = p.leg as usize;
        let bit = 1u16.checked_shl(p.leg as u32).unwrap_or(0);
        require!(
            i < take.legs.len() && priced & bit != 0,
            ThesisError::InvalidLegsMask
        );
        require!(p.published_at >= from, ThesisError::PriceTooEarly);
        require!(
            p.published_at <= until && p.published_at <= now,
            ThesisError::PriceTooLate
        );
        let valid = match (take.legs[i].kind, moment) {
            (LegKind::Prediction, Moment::Entry) => p.price > 0 && p.price < PRICE_ONE,
            (LegKind::Prediction, _) => p.price <= PRICE_ONE,
            (_, Moment::Entry) => p.price > 0,
            (_, _) => true,
        };
        require!(valid, ThesisError::InvalidPrice);
        require!(
            (already | out.legs) & bit == 0,
            ThesisError::PriceAlreadySet
        );
        out.legs |= bit;
        out.prices.push((i, p.price));
    }
    Ok(out)
}

/// Property tests for the price checks (`proptest`; `PROPTEST_CASES` runs more cases): a batch is
/// accepted exactly when a plain model of the rules accepts it.
#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    fn take(kinds: &[LegKind]) -> Take {
        Take {
            author: Pubkey::default(),
            id: 1,
            claim_hash: [0; 32],
            risk: Risk::Medium,
            created_at: 0,
            horizon_end: 0,
            legs: kinds
                .iter()
                .enumerate()
                .map(|(i, &kind)| LegSpec {
                    kind,
                    asset: Pubkey::new_from_array([i as u8 + 1; 32]),
                    weight_bps: 1,
                    leverage: 1,
                    fade_via: FadeVia::None,
                })
                .collect(),
            backers: 1,
            faders: 0,
            total_backed: 0,
            total_faded: 0,
            open_positions: 1,
            creator_fees_unclaimed: 0,
            platform_fees_from_backs: 0,
            status: TakeStatus::Open,
            result_bps: 0,
            bump: 0,
            closed_at: 0,
        }
    }

    /// The rules, written out plainly.
    #[allow(clippy::too_many_arguments)]
    fn model(
        t: &Take,
        mask: u16,
        already: u16,
        prices: &[LegPrice],
        from: i64,
        delay: i64,
        now: i64,
        moment: Moment,
    ) -> Option<u16> {
        let until = from.checked_add(delay)?;
        let mut seen = 0u16;
        for p in prices {
            let i = p.leg as usize;
            if i >= t.legs.len() || i >= 16 || mask & (1 << i) == 0 {
                return None;
            }
            if p.published_at < from || p.published_at > until || p.published_at > now {
                return None;
            }
            let ok = match (t.legs[i].kind, moment) {
                (LegKind::Prediction, Moment::Entry) => p.price > 0 && p.price < PRICE_ONE,
                (LegKind::Prediction, _) => p.price <= PRICE_ONE,
                (_, Moment::Entry) => p.price > 0,
                _ => true,
            };
            let bit = 1u16 << i;
            if !ok || (already | seen) & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        Some(seen)
    }

    fn moment() -> impl Strategy<Value = Moment> {
        prop_oneof![Just(Moment::Entry), Just(Moment::Exit), Just(Moment::Sale)]
    }

    fn kind() -> impl Strategy<Value = LegKind> {
        prop_oneof![
            Just(LegKind::Spot),
            Just(LegKind::Perp),
            Just(LegKind::Prediction),
            Just(LegKind::Yield),
            Just(LegKind::Card)
        ]
    }

    /// Prices near the interesting edges: around the window, 0, and the odds limit.
    fn price() -> impl Strategy<Value = LegPrice> {
        (
            0u8..12,
            prop_oneof![
                Just(0u64),
                Just(1),
                Just(PRICE_ONE - 1),
                Just(PRICE_ONE),
                Just(PRICE_ONE + 1),
                any::<u64>()
            ],
            -5i64..=110,
        )
            .prop_map(|(leg, price, t)| LegPrice {
                leg,
                price,
                published_at: 1_000 + t,
            })
    }

    proptest! {
        #[test]
        fn check_prices_matches_the_rules(
            kinds in prop::collection::vec(kind(), 1..=MAX_LEGS),
            mask in any::<u16>(),
            already in any::<u16>(),
            prices in prop::collection::vec(price(), 0..6),
            delay in 0i64..=120,
            now in 990i64..=1_120,
            moment in moment(),
        ) {
            let t = take(&kinds);
            let got = check_prices(&t, mask, already, &prices, 1_000, delay, now, moment);
            let want = model(&t, mask, already, &prices, 1_000, delay, now, moment);
            prop_assert_eq!(got.as_ref().ok().map(|c| c.legs), want);
            if let Ok(c) = got {
                // Every accepted price is recorded for its own leg, once.
                prop_assert_eq!(c.prices.len(), prices.len());
                for (p, (i, v)) in prices.iter().zip(&c.prices) {
                    prop_assert_eq!((p.leg as usize, p.price), (*i, *v));
                }
            }
        }

        /// A window that would overflow `i64` is an error, not a panic.
        #[test]
        fn check_prices_never_overflows(from in any::<i64>(), delay in any::<i64>(), prices in prop::collection::vec(price(), 0..3)) {
            let t = take(&[LegKind::Spot, LegKind::Prediction]);
            let _ = check_prices(&t, 0b11, 0, &prices, from, delay, i64::MAX, Moment::Exit);
        }
    }
}
