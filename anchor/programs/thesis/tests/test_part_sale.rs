//! Partial sales: `sell_part`, its prices (`record_part_prices`), FIFO settling (`settle_part`),
//! and how they interact with selling the rest (`exit_position`) and `settle_position`.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID, MAX_OPEN_PARTS},
};

const HORIZON: i64 = NOW + 30 * DAY;
const DELAY: i64 = 4 * DAY; // default max_price_delay_secs
const SOLD_AT: i64 = NOW + 10 * DAY;

struct Setup {
    env: Env,
    author: User,
    backer: User,
    take: Pubkey,
    author_pos: Pubkey,
    backer_pos: Pubkey,
}

/// A 60% spot / 40% yield take with a $20 buy-in, a back of both legs for `stake`, and entry
/// prices of $100 (spot) and $1.00 per vault share (yield) for both positions.
fn setup(stake: u64) -> Setup {
    let mut env = Env::new();
    let author = env.user(10_000 * USDC);
    let args = env.take_args(1, vec![spot_leg(6_000), yield_leg(4_000)], 20 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(10_000 * USDC);
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 1,
            stake,
            legs_mask: 0b11,
        },
    )
    .unwrap();
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    let backer_pos = position_pda(&take, &backer.pubkey(), 1);
    env.set_time(NOW + 120);
    for pos in [author_pos, backer_pos] {
        env.record(false, &take, &pos, entry()).unwrap();
    }
    Setup {
        env,
        author,
        backer,
        take,
        author_pos,
        backer_pos,
    }
}

fn entry() -> Vec<thesis::LegPrice> {
    vec![price(0, usd(100.0), NOW + 60), price(1, usd(1.0), NOW + 60)]
}

/// Sale prices for both legs, published `at`.
fn sale(spot: f64, at: i64) -> Vec<thesis::LegPrice> {
    vec![price(0, usd(spot), at), price(1, usd(1.0), at)]
}

#[test]
fn a_partial_sale_lowers_the_remaining_stake_and_scores_its_part() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);

    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 2_500).unwrap();
    let position: Position = env.fetch(&backer_pos);
    assert_eq!(position.stake, 40 * USDC, "the original stake is kept");
    assert_eq!(position.remaining, 30 * USDC);
    assert_eq!((position.parts, position.parts_settled), (1, 0));
    assert!(!position.exited);
    let part: PartSale = env.fetch(&part_sale_pda(&backer_pos, 0));
    assert_eq!(
        (part.position, part.seq, part.bps, part.stake, part.sold_at),
        (backer_pos, 0, 2_500, 10 * USDC, SOLD_AT)
    );
    assert_eq!(part.rent_payer, env.app_payer.pubkey());

    // Not settleable until its prices are in, the yield leg's included.
    env.set_time(SOLD_AT + 120);
    assert_error(
        env.settle_part(&take, &backer_pos, &backer.pubkey(), 0),
        "PriceMissing",
    );
    env.record_part(
        &take,
        &backer_pos,
        0,
        vec![price(0, usd(120.0), SOLD_AT + 60)],
    )
    .unwrap();
    assert_error(
        env.settle_part(&take, &backer_pos, &backer.pubkey(), 0),
        "PriceMissing",
    );
    env.record_part(
        &take,
        &backer_pos,
        0,
        vec![price(1, usd(1.0), SOLD_AT + 60)],
    )
    .unwrap();
    assert_error(
        env.record_part(
            &take,
            &backer_pos,
            0,
            vec![price(0, usd(121.0), SOLD_AT + 61)],
        ),
        "PriceAlreadySet",
    );

    let payer = env.app_payer.pubkey();
    let part_rent = env
        .svm
        .get_account(&part_sale_pda(&backer_pos, 0))
        .unwrap()
        .lamports;
    let payer_sol = env.svm.get_balance(&payer).unwrap();
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    assert!(!env.exists(&part_sale_pda(&backer_pos, 0)));
    assert_eq!(env.svm.get_balance(&payer).unwrap(), payer_sol + part_rent);

    // +20% on the spot leg (60%), flat yield: +12% on the $10 sold.
    let position: Position = env.fetch(&backer_pos);
    assert_eq!(position.parts_settled, 1);
    assert_eq!(position.realized_pnl, 1_200_000);
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(
        (profile.scored_stake, profile.scored_pnl),
        (10 * USDC, 1_200_000)
    );
    // A part isn't a position: those counters move when the position settles.
    assert_eq!(
        (profile.positions_settled, profile.scored_positions),
        (0, 0)
    );
}

#[test]
fn the_fraction_must_be_a_real_part() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    for bps in [0, 10_000, 10_001] {
        assert_error(
            env.sell_part(&backer, &take, &backer_pos, bps),
            "InvalidSaleFraction",
        );
    }
    // 1 bps of $40 is 4,000 base units: allowed.
    env.sell_part(&backer, &take, &backer_pos, 1).unwrap();
    assert_eq!(
        env.fetch::<PartSale>(&part_sale_pda(&backer_pos, 0)).stake,
        4_000
    );
}

#[test]
fn what_is_left_must_stay_at_the_minimum_stake() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(20 * USDC);
    env.set_time(SOLD_AT);
    // $20: half leaves exactly $10, the minimum; a bit more leaves less.
    assert_error(
        env.sell_part(&backer, &take, &backer_pos, 5_001),
        "RemainderBelowMinimum",
    );
    env.sell_part(&backer, &take, &backer_pos, 5_000).unwrap();
    assert_eq!(env.fetch::<Position>(&backer_pos).remaining, 10 * USDC);
    // Now at the minimum: only "sell all" is left.
    assert_error(
        env.sell_part(&backer, &take, &backer_pos, 1),
        "RemainderBelowMinimum",
    );
    env.exit_position(&backer, &take, &backer_pos).unwrap();
}

#[test]
fn a_ten_dollar_position_can_only_sell_all() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(10 * USDC);
    env.set_time(SOLD_AT);
    for bps in [1, 2_500, 9_999] {
        assert_error(
            env.sell_part(&backer, &take, &backer_pos, bps),
            "RemainderBelowMinimum",
        );
    }
    env.exit_position(&backer, &take, &backer_pos).unwrap();
}

#[test]
fn a_partial_sale_returns_that_fraction_of_the_escrow() {
    let mut env = Env::new();
    let author = env.user(1_000 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), prediction_leg(5_000)], 20 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(1_000 * USDC);
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 33 * USDC + 3,
            legs_mask: 0b11,
        },
    )
    .unwrap();
    let pos = position_pda(&take, &backer.pubkey(), 1);
    let escrowed = env.fetch::<Position>(&pos).escrowed;
    assert_eq!(escrowed, (33 * USDC + 3) / 2);

    env.set_time(SOLD_AT);
    let usdc = env.balance(&backer.usdc);
    let vault = env.balance(&escrow_vault_pda());
    env.sell_part(&backer, &take, &pos, 3_333).unwrap();
    let returned = escrowed * 3_333 / 10_000;
    assert_eq!(env.balance(&backer.usdc), usdc + returned);
    assert_eq!(env.balance(&escrow_vault_pda()), vault - returned);
    let position: Position = env.fetch(&pos);
    assert_eq!(position.escrowed, escrowed - returned);
    assert_eq!(
        env.fetch::<PartSale>(&part_sale_pda(&pos, 0))
            .escrow_returned,
        returned
    );

    // Selling the rest returns the rest: nothing is left behind in the vault for this position.
    env.exit_position(&backer, &take, &pos).unwrap();
    assert_eq!(env.balance(&backer.usdc), usdc + escrowed);
    assert_eq!(env.fetch::<Position>(&pos).escrowed, 0);
}

#[test]
fn the_authors_partial_sale_keeps_the_take_open_and_selling_the_rest_closes_it() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        author_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&author, &take, &author_pos, 4_000).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.closed_at), (TakeStatus::Open, 0));
    // Still open: new backs land.
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 2,
            stake: 10 * USDC,
            legs_mask: 0b11,
        },
    )
    .unwrap();
    // The author's part settles without waiting for the take.
    env.set_time(SOLD_AT + 120);
    env.record_part(&take, &author_pos, 0, sale(110.0, SOLD_AT + 60))
        .unwrap();
    env.settle_part(&take, &author_pos, &author.pubkey(), 0)
        .unwrap();

    env.set_time(SOLD_AT + DAY);
    env.exit_position(&author, &take, &author_pos).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.closed_at), (TakeStatus::Closed, SOLD_AT + DAY));

    // The headline is the basket's return to the author's final sale, whatever the parts did.
    env.set_time(SOLD_AT + DAY + 120);
    env.record_sale(&take, &author_pos, sale(150.0, SOLD_AT + DAY + 60))
        .unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    assert_eq!(env.fetch::<Take>(&take).result_bps, 3_000);
    let payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &author_pos,
        &author.pubkey(),
        &author.pubkey(),
        &payer,
    );
    env.crank(ix).unwrap();
    // The author's own P&L counts the part ($8 at +6%) and the rest ($12 at +30%).
    let profile: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!(profile.scored_stake, 20 * USDC);
    assert_eq!(profile.scored_pnl, 480_000 + 3_600_000);
    assert_eq!((profile.scored_positions, profile.wins), (1, 1));
}

#[test]
fn part_prices_must_be_at_or_after_the_part_sale_and_within_the_delay() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 2_500).unwrap();
    env.set_time(SOLD_AT + DELAY + 10);
    assert_error(
        env.record_part(&take, &backer_pos, 0, sale(120.0, SOLD_AT - 1)),
        "PriceTooEarly",
    );
    assert_error(
        env.record_part(&take, &backer_pos, 0, sale(120.0, SOLD_AT + DELAY + 1)),
        "PriceTooLate",
    );
    // Only the settler signs prices.
    let backer_key = backer.key.insecure_clone();
    let ix = env.record_part_prices_ix(
        &backer_key.pubkey(),
        &take,
        &backer_pos,
        0,
        sale(120.0, SOLD_AT),
    );
    assert!(env.send(&[ix], &[&backer_key]).is_err());
    env.record_part(&take, &backer_pos, 0, sale(120.0, SOLD_AT + DELAY))
        .unwrap();
}

#[test]
fn parts_settle_in_order_and_before_the_position() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 2_500).unwrap();
    env.set_time(SOLD_AT + HOUR);
    env.sell_part(&backer, &take, &backer_pos, 2_000).unwrap();
    assert_eq!(env.fetch::<Position>(&backer_pos).remaining, 24 * USDC);
    env.set_time(SOLD_AT + 2 * HOUR);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    // Selling all of what's left records that stake.
    let position: Position = env.fetch(&backer_pos);
    assert!(position.exited);
    assert_eq!(position.remaining, 24 * USDC);
    // Nothing more to sell.
    assert_error(
        env.sell_part(&backer, &take, &backer_pos, 1_000),
        "AlreadySold",
    );

    env.set_time(SOLD_AT + 3 * HOUR);
    env.record_part(&take, &backer_pos, 0, sale(110.0, SOLD_AT + 60))
        .unwrap();
    env.record_part(&take, &backer_pos, 1, sale(90.0, SOLD_AT + HOUR + 60))
        .unwrap();
    env.record_sale(&take, &backer_pos, sale(130.0, SOLD_AT + 2 * HOUR + 60))
        .unwrap();

    let payer = env.app_payer.pubkey();
    let settle_position = |env: &Env| {
        env.settle_sold_position_ix(
            &take,
            &backer_pos,
            &backer.pubkey(),
            &backer.pubkey(),
            &payer,
        )
    };
    let ix = settle_position(&env);
    assert_error(env.crank(ix), "PartsNotSettled");
    assert_error(
        env.settle_part(&take, &backer_pos, &backer.pubkey(), 1),
        "PartsNotSettled",
    );
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    let ix = settle_position(&env);
    assert_error(env.crank(ix), "PartsNotSettled");
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 1)
        .unwrap();
    let ix = settle_position(&env);
    env.crank(ix).unwrap();
    assert!(!env.exists(&backer_pos));

    // $10 at +6%, $6 at −6%, $24 at +18%: every dollar of the stake scored once.
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(profile.scored_stake, 40 * USDC);
    assert_eq!(profile.scored_pnl, 600_000 - 360_000 + 4_320_000);
    assert_eq!(
        (
            profile.positions_settled,
            profile.scored_positions,
            profile.wins
        ),
        (1, 1, 1)
    );
}

#[test]
fn a_win_counts_the_whole_position() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    // Half sold at +30% ($20 → +$3.60), the rest at −10% ($20 → −$1.20): a win overall.
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 5_000).unwrap();
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    env.set_time(SOLD_AT + 120);
    env.record_part(&take, &backer_pos, 0, sale(150.0, SOLD_AT))
        .unwrap();
    env.record_sale(&take, &backer_pos, sale(100.0 * (1.0 - 0.1 / 0.6), SOLD_AT))
        .unwrap();
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    let payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &payer,
    );
    env.crank(ix).unwrap();
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert!(profile.scored_pnl > 0);
    assert_eq!(profile.wins, 1);
}

#[test]
fn a_part_with_no_prices_settles_at_zero_unscored_after_the_grace_period() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 2_500).unwrap();
    env.set_time(SOLD_AT + DELAY);
    assert_error(
        env.settle_part(&take, &backer_pos, &backer.pubkey(), 0),
        "PriceMissing",
    );
    env.set_time(SOLD_AT + DELAY + 1);
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    let position: Position = env.fetch(&backer_pos);
    assert_eq!((position.parts_settled, position.realized_pnl), (1, 0));
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((profile.scored_stake, profile.scored_pnl), (0, 0));
}

#[test]
fn at_most_eight_parts_wait_to_settle() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(400 * USDC);
    env.set_time(SOLD_AT);
    for _ in 0..MAX_OPEN_PARTS {
        env.sell_part(&backer, &take, &backer_pos, 1_000).unwrap();
    }
    assert_error(
        env.sell_part(&backer, &take, &backer_pos, 1_000),
        "TooManyOpenSales",
    );
    env.set_time(SOLD_AT + DELAY + 1);
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    env.set_time(SOLD_AT + DELAY + 2);
    env.sell_part(&backer, &take, &backer_pos, 1_000).unwrap();
    let position: Position = env.fetch(&backer_pos);
    assert_eq!((position.parts, position.parts_settled), (9, 1));
}

#[test]
fn a_parts_rent_goes_back_only_to_its_payer() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 2_500).unwrap();
    env.set_time(SOLD_AT + DELAY + 1);
    let ix = env.settle_part_ix(&take, &backer_pos, &backer.pubkey(), 0, &backer.pubkey());
    assert_error(env.crank(ix), "AccountMismatch");
    // Another owner's profile can't take the part's score.
    let other = env.user(0);
    let payer = env.app_payer.pubkey();
    let ix = env.settle_part_ix(&take, &backer_pos, &other.pubkey(), 0, &payer);
    assert!(env.crank(ix).is_err());
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
}

#[test]
fn no_partial_sale_at_or_after_the_horizon_or_by_someone_else() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        backer_pos,
        ..
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    // The author can't sell the backer's position.
    let payer = env.app_payer.insecure_clone();
    let ix = env.sell_part_ix(
        &author.pubkey(),
        &payer.pubkey(),
        &take,
        &backer_pos,
        0,
        2_500,
    );
    assert_error(env.send(&[ix], &[&payer, &author.key]), "AccountMismatch");
    env.set_time(HORIZON);
    assert_error(
        env.sell_part(&backer, &take, &backer_pos, 2_500),
        "HorizonPassed",
    );
}

#[test]
fn a_held_position_after_parts_settles_its_remainder_at_the_horizon() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        author_pos,
        backer_pos,
    } = setup(40 * USDC);
    env.set_time(SOLD_AT);
    env.sell_part(&backer, &take, &backer_pos, 5_000).unwrap();
    env.set_time(HORIZON + HOUR);
    env.record_part(&take, &backer_pos, 0, sale(120.0, SOLD_AT))
        .unwrap();
    for pos in [author_pos, backer_pos] {
        env.record(true, &take, &pos, sale(110.0, HORIZON)).unwrap();
    }
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    assert_error(env.crank(ix), "PartsNotSettled");
    env.settle_part(&take, &backer_pos, &backer.pubkey(), 0)
        .unwrap();
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
    // $20 at +12% and $20 at +6%.
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(profile.scored_stake, 40 * USDC);
    assert_eq!(profile.scored_pnl, 2_400_000 + 1_200_000);
}

/// At equal prices, a position sold in parts scores what it would have scored sold whole, to
/// within a base unit per sale (each P&L rounds down).
#[test]
fn parts_plus_the_rest_score_the_whole_stake_at_equal_prices() {
    let sequences: &[&[u16]] = &[
        &[2_500],
        &[5_000, 5_000],
        &[1, 9_000, 3_333],
        &[1_234, 4_321, 777, 2_000, 6_666],
        &[9_999],
    ];
    for (n, bps_seq) in sequences.iter().enumerate() {
        for spot in [37.0, 100.0, 163.7] {
            let stake = 1_000 * USDC + 777;
            let Setup {
                mut env,
                backer,
                take,
                backer_pos,
                ..
            } = setup(stake);
            env.set_time(SOLD_AT);
            let mut sold = 0;
            for &bps in bps_seq.iter() {
                let remaining = env.fetch::<Position>(&backer_pos).remaining;
                if (remaining - remaining * bps as u64 / 10_000) < 10 * USDC {
                    continue;
                }
                env.sell_part(&backer, &take, &backer_pos, bps).unwrap();
                sold += 1;
            }
            env.exit_position(&backer, &take, &backer_pos).unwrap();
            env.set_time(SOLD_AT + 60);
            let prices = sale(spot, SOLD_AT);
            for seq in 0..sold {
                env.record_part(&take, &backer_pos, seq, prices.clone())
                    .unwrap();
                env.settle_part(&take, &backer_pos, &backer.pubkey(), seq)
                    .unwrap();
            }
            env.record_sale(&take, &backer_pos, prices).unwrap();
            let payer = env.app_payer.pubkey();
            let ix = env.settle_sold_position_ix(
                &take,
                &backer_pos,
                &backer.pubkey(),
                &backer.pubkey(),
                &payer,
            );
            env.crank(ix).unwrap();

            let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
            assert_eq!(profile.scored_stake, stake, "sequence {n}");
            // The program's return: the spot leg's move, weighted 60%; the yield leg is flat.
            let (entry, exit) = (usd(100.0) as i128, usd(spot) as i128);
            let r = (exit - entry) * 10_000 / entry * 6_000 / 10_000;
            let whole = (stake as i128 * r / 10_000) as i64;
            let diff = (profile.scored_pnl - whole).abs();
            assert!(
                diff <= sold as i64 + 1,
                "sequence {n} at {spot}: {} vs {whole}",
                profile.scored_pnl
            );
        }
    }
}
