use anchor_lang::prelude::*;

use crate::{constants::*, error::ThesisError, state::*};

/// Splits the fee on a stake: `fee` is what the owner pays, `creator` is the part of it credited
/// to the take's author. Each is rounded down from the stake; the platform keeps `fee - creator`.
/// The creator share applies to every back and fade by someone other than the author (fades too:
/// decided); on the author's own stake the platform keeps the whole fee.
pub fn fee_split(stake: u64, params: &ConfigParams, is_author: bool) -> Result<(u64, u64)> {
    let bps_of = |bps: u16| -> Result<u64> {
        let v = (stake as u128)
            .checked_mul(bps as u128)
            .ok_or(ThesisError::MathOverflow)?
            / BPS_DENOMINATOR as u128;
        u64::try_from(v).map_err(|_| error!(ThesisError::MathOverflow))
    };
    let fee = bps_of(params.fee_bps)?;
    let creator = if is_author {
        0
    } else {
        bps_of(params.creator_fee_bps)?
    };
    Ok((fee, creator))
}

/// A badge URI base: `https://` and a host, ending in `/`, printable ASCII with no spaces, at
/// most `MAX_BADGE_URI_BASE_LEN` bytes, so `{base}{slug}.json` is a URL wallets can fetch.
pub fn validate_badge_uri_base(base: &str) -> Result<()> {
    let rest = base.strip_prefix("https://").unwrap_or("");
    require!(
        base.len() <= MAX_BADGE_URI_BASE_LEN
            && !rest.is_empty()
            && !rest.starts_with('/')
            && base.ends_with('/')
            && base.bytes().all(|b| b.is_ascii_graphic()),
        ThesisError::InvalidBadgeUriBase
    );
    Ok(())
}

pub fn validate_params(params: &ConfigParams) -> Result<()> {
    require!(
        params.fee_bps <= MAX_FEE_BPS
            && params.creator_fee_bps <= params.fee_bps
            && params.min_stake > 0
            && params.max_legs >= 1
            && (params.max_legs as usize) <= MAX_LEGS
            && params.min_horizon_secs > 0
            && params.max_horizon_secs >= params.min_horizon_secs
            && params.max_price_delay_secs > 0
            && (params.creator_boost_bps as u64) <= BPS_DENOMINATOR,
        ThesisError::InvalidConfig
    );
    Ok(())
}

/// The trade allowlist: at most `MAX_TRADE_PROGRAMS`, no repeats, and never a program that could
/// move the stake with a plain transfer (Token, Token-2022, System) or Thesis itself.
pub fn validate_trade_programs(programs: &[Pubkey]) -> Result<()> {
    require!(
        programs.len() <= MAX_TRADE_PROGRAMS,
        ThesisError::InvalidTradePrograms
    );
    for (i, p) in programs.iter().enumerate() {
        require!(
            !crate::proof::forbidden_trade_program(p) && !programs[..i].contains(p),
            ThesisError::InvalidTradePrograms
        );
    }
    Ok(())
}

pub fn validate_legs(legs: &[LegSpec], max_legs: u8) -> Result<()> {
    require!(!legs.is_empty(), ThesisError::NoLegs);
    require!(
        legs.len() <= max_legs as usize && legs.len() <= MAX_LEGS,
        ThesisError::TooManyLegs
    );

    let mut weight_total: u64 = 0;
    for (i, leg) in legs.iter().enumerate() {
        require!(leg.weight_bps > 0, ThesisError::WeightsMustSumTo100);
        weight_total += leg.weight_bps as u64;

        require!(leg.leverage >= 1, ThesisError::InvalidLeverage);
        require!(
            leg.leverage == 1 || leg.kind == LegKind::Perp,
            ThesisError::InvalidLeverage
        );

        let fits_kind = match leg.kind {
            LegKind::Spot | LegKind::Perp => leg.fade_via != FadeVia::PredictionNo,
            LegKind::Yield | LegKind::Card => leg.fade_via == FadeVia::None,
            LegKind::Prediction => leg.fade_via != FadeVia::PhoenixShort,
        };
        require!(fits_kind, ThesisError::InvalidLeg);

        require!(
            legs[..i].iter().all(|other| other.asset != leg.asset),
            ThesisError::DuplicateLeg
        );
    }
    require!(
        weight_total == BPS_DENOMINATOR,
        ThesisError::WeightsMustSumTo100
    );
    Ok(())
}

/// Every set bit must name an existing leg, and at least one must be set.
pub fn validate_legs_mask(mask: u16, legs: usize) -> Result<()> {
    require!(
        mask != 0 && (mask as u32) >> legs == 0,
        ThesisError::InvalidLegsMask
    );
    Ok(())
}

pub fn included_legs(mask: u16, legs: &[LegSpec]) -> impl Iterator<Item = &LegSpec> {
    legs.iter()
        .enumerate()
        .filter(move |(i, _)| mask & (1 << i) != 0)
        .map(|(_, leg)| leg)
}

/// Moves USDC signed by the user (fees only: Thesis never takes the stake itself).
pub fn transfer_from_user<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    anchor_spl::token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            anchor_spl::token_interface::TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
        ),
        amount,
        decimals,
    )
}

/// The part of `stake` that goes to the position's escrowed legs (prediction and card legs,
/// `LegKind::is_escrowed`), by weight, rounded down. It's held in the escrow vault instead of
/// traded: those legs are paper-filled.
pub fn escrow_share(legs: &[LegSpec], legs_mask: u16, stake: u64) -> Result<u64> {
    let (mut escrowed, mut total) = (0u128, 0u128);
    for (_, leg) in included_legs_indexed(legs_mask, legs) {
        total += leg.weight_bps as u128;
        if leg.kind.is_escrowed() {
            escrowed += leg.weight_bps as u128;
        }
    }
    if total == 0 || escrowed == 0 {
        return Ok(0);
    }
    u64::try_from((stake as u128) * escrowed / total).map_err(|_| error!(ThesisError::MathOverflow))
}

/// Moves USDC out of a program-owned vault, signed by the config PDA.
#[allow(clippy::too_many_arguments)]
pub fn transfer_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    config_bump: u8,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    anchor_spl::token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            anchor_spl::token_interface::TransferChecked {
                from: vault.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: config.clone(),
            },
            &[&[CONFIG_SEED, &[config_bump]]],
        ),
        amount,
        decimals,
    )
}

/// Legs of a position that need a settler price: every included leg. Yield legs are priced as
/// the value of one vault share (yield counts in the score).
pub fn priced_legs_mask(legs: &[LegSpec], legs_mask: u16) -> u16 {
    legs.iter()
        .enumerate()
        .filter(|(i, _)| legs_mask & (1 << i) != 0)
        .fold(0u16, |mask, (i, _)| mask | (1 << i))
}

/// A position's return in bps, entry to exit at the horizon, weighted across its included legs.
/// `None` while a price it needs is missing.
///
/// Per leg: spot, perp, card and yield legs move by `leverage × (exit / entry − 1)` (a yield leg's
/// price is one vault share's value, so this is the interest it earned; its leverage is 1); a
/// prediction "Yes" by `exit / entry − 1`; a fade takes the other side (a short for Phoenix legs,
/// `(1 − exit) / (1 − entry) − 1` for a prediction "No"; yield legs can't be faded).
/// No leg can lose more than 100%.
pub fn position_return_bps(legs: &[LegSpec], position: &Position) -> Option<i64> {
    position_return_raw(legs, position).and_then(|r| i64::try_from(r).ok())
}

/// Like `position_return_bps`, entry to the owner's sale.
pub fn sale_return_bps(legs: &[LegSpec], position: &Position, exit: &Exit) -> Option<i64> {
    sale_return_raw(legs, position, exit).and_then(|r| i64::try_from(r).ok())
}

/// The horizon return before it's narrowed to `i64`; `None` while a price is missing.
pub fn position_return_raw(legs: &[LegSpec], position: &Position) -> Option<i128> {
    return_bps(legs, position, position.exit_set, |i| {
        position.prices[i].exit
    })
}

/// The sale return before it's narrowed to `i64`; `None` while a price is missing.
pub fn sale_return_raw(legs: &[LegSpec], position: &Position, exit: &Exit) -> Option<i128> {
    return_bps(legs, position, exit.price_set, |i| exit.prices[i])
}

/// Refuses prices that would make a complete return, or its P&L on `stake`, too large to
/// record (security review L-1). Without this, such a return reads as "price missing" and the
/// position settles at 0%, unscored, after the grace period; now the settler's call fails with
/// its own error instead. A return still missing a price passes.
pub fn check_return_fits(raw: Option<i128>, stake: u64) -> Result<()> {
    if let Some(r) = raw {
        let r = i64::try_from(r).map_err(|_| error!(ThesisError::ReturnOutOfRange))?;
        i64::try_from((stake as i128) * (r as i128) / BPS_DENOMINATOR as i128)
            .map_err(|_| error!(ThesisError::ReturnOutOfRange))?;
    }
    Ok(())
}

fn return_bps(
    legs: &[LegSpec],
    position: &Position,
    exit_set: u16,
    exit_price: impl Fn(usize) -> u64,
) -> Option<i128> {
    let needed = priced_legs_mask(legs, position.legs_mask);
    if position.entry_set & needed != needed || exit_set & needed != needed {
        return None;
    }
    let bps = BPS_DENOMINATOR as i128;
    let one = PRICE_ONE as i128;
    let mut weighted: i128 = 0;
    let mut weight_total: i128 = 0;
    for (i, leg) in included_legs_indexed(position.legs_mask, legs) {
        let weight = leg.weight_bps as i128;
        weight_total += weight;
        let entry = position.prices[i].entry as i128;
        let exit = exit_price(i) as i128;
        let leverage = leg.leverage as i128;
        let move_bps = match (position.side, leg.kind) {
            (Side::Back, LegKind::Prediction) => (exit - entry) * bps / entry,
            (Side::Back, _) => leverage * (exit - entry) * bps / entry,
            (Side::Fade, LegKind::Prediction) => (entry - exit) * bps / (one - entry),
            (Side::Fade, _) => leverage * (entry - exit) * bps / entry,
        };
        weighted += move_bps.max(-bps) * weight;
    }
    if weight_total == 0 {
        return Some(0);
    }
    Some(weighted / weight_total)
}

pub fn included_legs_indexed(
    mask: u16,
    legs: &[LegSpec],
) -> impl Iterator<Item = (usize, &LegSpec)> {
    legs.iter()
        .enumerate()
        .filter(move |(i, _)| mask & (1 << i) != 0)
}

/// Property tests for the fee and return math (`proptest`; `PROPTEST_CASES` runs more cases).
#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    fn params(fee_bps: u16, creator_fee_bps: u16) -> ConfigParams {
        ConfigParams {
            fee_bps,
            creator_fee_bps,
            min_stake: 10_000_000,
            max_legs: MAX_LEGS as u8,
            min_horizon_secs: 3_600,
            max_horizon_secs: 3_600 * 24 * 365 * 5,
            max_price_delay_secs: 4 * 86_400,
            creator_boost_bps: 0,
            paused: false,
        }
    }

    proptest! {
        /// The fee and the creator's share never exceed the stake, the share never exceeds the
        /// fee, both round down, and every stake but the author's own pays a share.
        #[test]
        fn fee_split_is_bounded_and_rounds_down(
            stake in any::<u64>(),
            fee_bps in 0u16..=10_000,
            creator in 0u16..=10_000,
            is_author in any::<bool>(),
        ) {
            let creator_fee_bps = creator.min(fee_bps);
            let (fee, share) = fee_split(stake, &params(fee_bps, creator_fee_bps), is_author).unwrap();
            prop_assert!(fee <= stake);
            prop_assert!(share <= fee);
            prop_assert_eq!(fee as u128, stake as u128 * fee_bps as u128 / 10_000);
            if is_author {
                prop_assert_eq!(share, 0);
            } else {
                prop_assert_eq!(share as u128, stake as u128 * creator_fee_bps as u128 / 10_000);
            }
        }
    }

    /// A leg and its prices, as generated for the return properties.
    #[derive(Clone, Debug)]
    struct GenLeg {
        kind: LegKind,
        weight: u16,
        leverage: u8,
        entry: u64,
        exit: u64,
    }

    fn gen_leg() -> impl Strategy<Value = GenLeg> {
        let kind = prop_oneof![
            Just(LegKind::Spot),
            Just(LegKind::Perp),
            Just(LegKind::Prediction),
            Just(LegKind::Yield),
            Just(LegKind::Card),
        ];
        (
            kind,
            1u16..=10_000,
            1u8..=20,
            1u64..=1_000_000 * PRICE_ONE,
            any::<u64>(),
        )
            .prop_map(|(kind, weight, lev, entry, exit)| match kind {
                // Prediction prices are odds: entry strictly inside (0, 1), exit within [0, 1].
                LegKind::Prediction => GenLeg {
                    kind,
                    weight,
                    leverage: 1,
                    entry: 1 + entry % (PRICE_ONE - 1),
                    exit: exit % (PRICE_ONE + 1),
                },
                _ => GenLeg {
                    kind,
                    weight,
                    leverage: if kind == LegKind::Perp { lev } else { 1 },
                    entry,
                    // Up to 100× the entry, so moves stay in a realistic range.
                    exit: exit % (entry.saturating_mul(100).max(1)),
                },
            })
    }

    fn position(legs: &[GenLeg], mask: u16, side: Side) -> (Vec<LegSpec>, Position) {
        let specs: Vec<LegSpec> = legs
            .iter()
            .enumerate()
            .map(|(i, l)| LegSpec {
                kind: l.kind,
                asset: Pubkey::new_from_array([i as u8 + 1; 32]),
                weight_bps: l.weight,
                leverage: l.leverage,
                fade_via: FadeVia::None,
            })
            .collect();
        let all = ((1u32 << legs.len()) - 1) as u16;
        let p = Position {
            owner: Pubkey::default(),
            take: Pubkey::default(),
            id: 1,
            rent_payer: Pubkey::default(),
            side,
            stake: 10_000_000,
            opened_at: 0,
            legs_mask: mask,
            prices: legs
                .iter()
                .map(|l| LegPrices {
                    entry: l.entry,
                    exit: l.exit,
                })
                .collect(),
            entry_set: all,
            exit_set: all,
            scored: true,
            exited: false,
            escrowed: 0,
            bump: 0,
        };
        (specs, p)
    }

    /// One leg's move in bps, as the program computes it (before weighting).
    fn leg_move(l: &GenLeg, side: Side) -> i128 {
        let bps = BPS_DENOMINATOR as i128;
        let (entry, exit, lev) = (l.entry as i128, l.exit as i128, l.leverage as i128);
        let one = PRICE_ONE as i128;
        let m = match (side, l.kind) {
            (Side::Back, LegKind::Prediction) => (exit - entry) * bps / entry,
            (Side::Back, _) => lev * (exit - entry) * bps / entry,
            (Side::Fade, LegKind::Prediction) => (entry - exit) * bps / (one - entry),
            (Side::Fade, _) => lev * (entry - exit) * bps / entry,
        };
        m.max(-bps)
    }

    /// Spot, perp, card and yield legs whose exit stays within `entry × (1 ± 1/leverage)`, so
    /// neither a back nor a fade of any leg moves past −100%.
    fn unfloored_basket() -> impl Strategy<Value = (Vec<GenLeg>, u16)> {
        let kind = prop_oneof![
            Just(LegKind::Spot),
            Just(LegKind::Perp),
            Just(LegKind::Card),
            Just(LegKind::Yield)
        ];
        let leg = (
            kind,
            1u16..=10_000,
            1u8..=20,
            1_000u64..=1_000_000 * PRICE_ONE,
            0u64..=2_000_000,
        )
            .prop_map(|(kind, weight, lev, entry, t)| {
                let leverage = if kind == LegKind::Perp { lev } else { 1 };
                // t ∈ [0, 2e6] maps to a move in [−1/leverage, +1/leverage] of the entry.
                let band = entry as i128 / leverage as i128;
                let exit = (entry as i128 - band + band * t as i128 / 1_000_000).max(0) as u64;
                GenLeg {
                    kind,
                    weight,
                    leverage,
                    entry,
                    exit,
                }
            });
        prop::collection::vec(leg, 1..=MAX_LEGS).prop_flat_map(|legs| {
            let all = (1u32 << legs.len()) - 1;
            (Just(legs), (1u32..=all).prop_map(|m| m as u16))
        })
    }

    fn basket() -> impl Strategy<Value = (Vec<GenLeg>, u16)> {
        prop::collection::vec(gen_leg(), 1..=MAX_LEGS).prop_flat_map(|legs| {
            let all = (1u32 << legs.len()) - 1;
            (Just(legs), (1u32..=all).prop_map(|m| m as u16))
        })
    }

    proptest! {
        /// No position loses more than 100%, and its return is a weighted average of its legs'
        /// moves (so it lies between the smallest and largest of them).
        #[test]
        fn returns_are_bounded_weighted_averages((legs, mask) in basket(), fade in any::<bool>()) {
            let side = if fade { Side::Fade } else { Side::Back };
            let (specs, p) = position(&legs, mask, side);
            let r = position_return_bps(&specs, &p).expect("all prices set") as i128;
            prop_assert!(r >= -(BPS_DENOMINATOR as i128));
            let moves: Vec<i128> = legs
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, l)| leg_move(l, side))
                .collect();
            prop_assert!(r >= *moves.iter().min().unwrap() && r <= *moves.iter().max().unwrap());
        }

        /// A fade mirrors a back exactly when no leg reaches the −100% floor on either side.
        #[test]
        fn fades_mirror_backs((legs, mask) in unfloored_basket()) {
            let (specs, back) = position(&legs, mask, Side::Back);
            let (_, fade) = position(&legs, mask, Side::Fade);
            prop_assert_eq!(position_return_bps(&specs, &fade), position_return_bps(&specs, &back).map(|r| -r));
        }

        /// Leverage multiplies a leg's move (to within rounding), until the −100% floor.
        #[test]
        fn leverage_multiplies(entry in 1u64..=1_000_000 * PRICE_ONE, exit_ratio in 0u64..=300, lev in 1u8..=20) {
            let exit = (entry as u128 * exit_ratio as u128 / 100) as u64;
            let leg = |leverage| GenLeg { kind: LegKind::Perp, weight: 10_000, leverage, entry, exit };
            let (specs1, p1) = position(&[leg(1)], 1, Side::Back);
            let (specs, p) = position(&[leg(lev)], 1, Side::Back);
            let one = position_return_bps(&specs1, &p1).unwrap() as i128;
            let levered = position_return_bps(&specs, &p).unwrap() as i128;
            let expected = (one * lev as i128).max(-10_000);
            prop_assert!((levered - expected).abs() <= lev as i128, "{} vs {}", levered, expected);
        }

        /// Every included leg needs its prices (yield legs too): a missing one
        /// leaves the return unknown.
        #[test]
        fn missing_prices_give_no_result((legs, mask) in basket(), hole in 0usize..MAX_LEGS) {
            let (specs, mut p) = position(&legs, mask, Side::Back);
            let i = hole % legs.len();
            let needed = mask & (1 << i) != 0;
            p.exit_set &= !(1 << i);
            prop_assert_eq!(position_return_bps(&specs, &p).is_none(), needed);
        }

        /// Any prices at all (the full u64 range, leverage up to 255) give a result or `None`,
        /// never a panic or a wrapped number.
        #[test]
        fn returns_never_panic(
            raw in prop::collection::vec((0usize..5, any::<u16>(), any::<u8>(), any::<u64>(), any::<u64>()), 1..=MAX_LEGS),
            mask in any::<u16>(),
            fade in any::<bool>(),
        ) {
            let kinds = [LegKind::Spot, LegKind::Perp, LegKind::Prediction, LegKind::Yield, LegKind::Card];
            let legs: Vec<GenLeg> = raw
                .iter()
                .map(|&(k, weight, leverage, entry, exit)| GenLeg {
                    kind: kinds[k],
                    weight,
                    leverage,
                    // The program never stores a 0 entry for a priced leg, nor one ≥ PRICE_ONE for a prediction.
                    entry: if kinds[k] == LegKind::Prediction { 1 + entry % (PRICE_ONE - 1) } else { entry.max(1) },
                    exit,
                })
                .collect();
            let mask = mask & (((1u32 << legs.len()) - 1) as u16);
            let side = if fade { Side::Fade } else { Side::Back };
            let (specs, p) = position(&legs, mask, side);
            if let Some(r) = position_return_bps(&specs, &p) {
                prop_assert!(r >= -10_000);
            }
        }

        /// A sale scores like a horizon exit at the same prices.
        #[test]
        fn sales_score_like_exits((legs, mask) in basket(), fade in any::<bool>()) {
            let side = if fade { Side::Fade } else { Side::Back };
            let (specs, p) = position(&legs, mask, side);
            let exit = Exit {
                position: Pubkey::default(),
                exited_at: 0,
                rent_payer: Pubkey::default(),
                price_set: p.exit_set,
                prices: legs.iter().map(|l| l.exit).collect(),
                bump: 0,
            };
            prop_assert_eq!(sale_return_bps(&specs, &p, &exit), position_return_bps(&specs, &p));
        }
    }
}
