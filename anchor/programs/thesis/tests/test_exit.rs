//! Selling a position before the horizon: `exit_position`, sale prices, early settlement, and
//! the author's sale, which closes the take and settles it early.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID},
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

/// A 60% spot / 40% yield take, a $20 back of both legs, and entry prices of $100 (spot) and
/// $1.00 per vault share (yield).
fn setup() -> Setup {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(6_000), yield_leg(4_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 20 * USDC,
            legs_mask: 0b11,
        },
    )
    .unwrap();
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    let backer_pos = position_pda(&take, &backer.pubkey(), 1);
    env.set_time(NOW + 120);
    for pos in [author_pos, backer_pos] {
        env.record(
            false,
            &take,
            &pos,
            vec![price(0, usd(100.0), NOW + 60), price(1, usd(1.0), NOW + 60)],
        )
        .unwrap();
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

#[test]
fn a_sold_position_scores_at_the_sale_and_settles_before_the_horizon() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup();

    env.set_time(SOLD_AT);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    let exit: Exit = env.fetch(&exit_pda(&backer_pos));
    assert_eq!((exit.position, exit.exited_at), (backer_pos, SOLD_AT));
    assert_eq!(exit.rent_payer, env.app_payer.pubkey());

    // Sale prices must be at or after the sale, like entry prices after the trade.
    env.set_time(SOLD_AT + 120);
    assert_error(
        env.record_sale(&take, &backer_pos, vec![price(0, usd(130.0), SOLD_AT - 1)]),
        "PriceTooEarly",
    );
    // Not settleable until the sale prices are in, the yield leg's included.
    let app_payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &app_payer,
    );
    assert_error(env.crank(ix), "PriceMissing");

    env.record_sale(&take, &backer_pos, vec![price(0, usd(130.0), SOLD_AT + 60)])
        .unwrap();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &app_payer,
    );
    assert_error(env.crank(ix), "PriceMissing");
    env.record_sale(&take, &backer_pos, vec![price(1, usd(1.01), SOLD_AT + 60)])
        .unwrap();
    assert_error(
        env.record_sale(&take, &backer_pos, vec![price(0, usd(131.0), SOLD_AT + 61)]),
        "PriceAlreadySet",
    );

    // The exit's rent goes back to whoever paid it, not to anyone else.
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &backer.pubkey(),
    );
    assert_error(env.crank(ix), "AccountMismatch");

    let position_rent = env.svm.get_account(&backer_pos).unwrap().lamports;
    let exit_rent = env
        .svm
        .get_account(&exit_pda(&backer_pos))
        .unwrap()
        .lamports;
    let backer_sol = env.svm.get_balance(&backer.pubkey()).unwrap();
    let payer_sol = env.svm.get_balance(&app_payer).unwrap();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &app_payer,
    );
    env.crank(ix).unwrap();

    assert!(!env.exists(&backer_pos) && !env.exists(&exit_pda(&backer_pos)));
    assert_eq!(
        env.svm.get_balance(&backer.pubkey()).unwrap(),
        backer_sol + position_rent
    );
    assert_eq!(
        env.svm.get_balance(&app_payer).unwrap(),
        payer_sol + exit_rent
    );
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    // 60% × +30% + 40% × +1% (the vault share's interest) = +18.4% on $20.
    assert_eq!((b.positions_settled, b.scored_positions, b.wins), (1, 1, 1));
    assert_eq!((b.scored_stake, b.scored_pnl), (20 * USDC, 3_680_000));
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.open_positions), (TakeStatus::Open, 1));
}

#[test]
fn exit_rules() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        backer_pos,
        ..
    } = setup();

    // Only the owner can sell.
    let payer = env.app_payer.insecure_clone();
    let ix = env.exit_position_ix(&author.pubkey(), &payer.pubkey(), &take, &backer_pos);
    assert_error(env.send(&[ix], &[&payer, &author.key]), "AccountMismatch");

    // Once.
    env.set_time(SOLD_AT);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    assert!(env.exit_position(&backer, &take, &backer_pos).is_err());

    // A held position still waits for the take.
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    let ix = env.settle_position_ix(&take, &author_pos, &author.pubkey(), &author.pubkey());
    assert_error(env.crank(ix), "TakeNotSettled");

    // Not at or after the horizon: positions settle instead.
    env.set_time(HORIZON);
    assert_error(
        env.exit_position(&author, &take, &author_pos),
        "HorizonPassed",
    );
}

#[test]
fn a_sold_position_settles_on_its_sale_even_after_the_horizon() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        author_pos,
        backer_pos,
    } = setup();

    env.set_time(SOLD_AT);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    env.set_time(SOLD_AT + 120);
    env.record_sale(
        &take,
        &backer_pos,
        vec![
            price(0, usd(90.0), SOLD_AT + 60),
            price(1, usd(1.002), SOLD_AT + 60),
        ],
    )
    .unwrap();

    // The token recovers by the horizon, and horizon prices land for every position.
    env.set_time(HORIZON + 120);
    for pos in [author_pos, backer_pos] {
        env.record(
            true,
            &take,
            &pos,
            vec![
                price(0, usd(150.0), HORIZON + 60),
                price(1, usd(1.05), HORIZON + 60),
            ],
        )
        .unwrap();
    }
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    // The backer sold at −10% on the spot leg and +0.2% on the yield leg, so it scores
    // 60% × −10% + 40% × +0.2% = −5.92%, not the horizon's +30%.
    let app_payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &app_payer,
    );
    env.crank(ix).unwrap();
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((b.scored_pnl, b.wins), (-1_184_000, 0));
}

#[test]
fn the_authors_sale_closes_the_take_and_settles_it_early() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        author_pos,
        backer_pos,
    } = setup();
    // A second backer, who sells after the take has settled.
    let seller = env.user(100 * USDC);
    let args = OpenPositionArgs {
        id: 1,
        stake: 20 * USDC,
        legs_mask: 0b11,
    };
    env.open_position(Side::Back, &seller, &take, args).unwrap();
    let seller_pos = position_pda(&take, &seller.pubkey(), 1);
    env.record(
        false,
        &take,
        &seller_pos,
        vec![
            price(0, usd(100.0), NOW + 120),
            price(1, usd(1.0), NOW + 120),
        ],
    )
    .unwrap();

    // Before the sale the take is open and can't settle.
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "HorizonNotReached");

    env.set_time(SOLD_AT);
    env.exit_position(&author, &take, &author_pos).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.closed_at), (TakeStatus::Closed, SOLD_AT));

    // Closed: no new backs or fades.
    let late = env.user(100 * USDC);
    for (side, legs_mask) in [(Side::Back, 0b11), (Side::Fade, 0b01)] {
        let args = OpenPositionArgs {
            id: 1,
            stake: 10 * USDC,
            legs_mask,
        };
        assert_error(env.open_position(side, &late, &take, args), "TakeClosed");
    }

    // The take settles on the sale's prices, once all of them are in.
    env.set_time(SOLD_AT + 120);
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "PriceMissing");
    env.record_sale(&take, &author_pos, vec![price(0, usd(110.0), SOLD_AT + 60)])
        .unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "PriceMissing");
    env.record_sale(&take, &author_pos, vec![price(1, usd(1.0), SOLD_AT + 60)])
        .unwrap();

    // Only the author's own exit account settles it.
    env.set_time(SOLD_AT + DAY);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    let mut ix = env.settle_take_ix(&take, &author.pubkey());
    ix.accounts[4].pubkey = exit_pda(&backer_pos); // author_exit
    assert_error(env.crank(ix), "AccountMismatch");

    // 60% × +10% on the spot leg, flat yield: +6%, well before the horizon.
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!(
        (t.status, t.result_bps, t.closed_at),
        (TakeStatus::Settled, 600, SOLD_AT)
    );
    let p: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!((p.takes_settled, p.best_take_bps), (1, 600));
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "TakeAlreadySettled");

    // The author's buy-in settles on the same sale: +6% on $10.
    let app_payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &author_pos,
        &author.pubkey(),
        &author.pubkey(),
        &app_payer,
    );
    env.crank(ix).unwrap();
    let p: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!((p.scored_pnl, p.wins), (600_000, 1));
    assert!(!env.exists(&author_pos) && !env.exists(&exit_pda(&author_pos)));

    // A holder can still sell after the early settlement, and settles on that sale.
    env.set_time(SOLD_AT + 2 * DAY);
    env.exit_position(&seller, &take, &seller_pos).unwrap();
    env.set_time(SOLD_AT + 2 * DAY + 120);
    env.record_sale(
        &take,
        &seller_pos,
        vec![
            price(0, usd(120.0), SOLD_AT + 2 * DAY + 60),
            price(1, usd(1.0), SOLD_AT + 2 * DAY + 60),
        ],
    )
    .unwrap();
    let ix = env.settle_sold_position_ix(
        &take,
        &seller_pos,
        &seller.pubkey(),
        &seller.pubkey(),
        &app_payer,
    );
    env.crank(ix).unwrap();
    let s: Profile = env.fetch(&profile_pda(&seller.pubkey()));
    // 60% × +20% on $20.
    assert_eq!((s.scored_pnl, s.wins), (2_400_000, 1));

    // Left: the backer's sale, waiting for its prices.
    assert_eq!(env.fetch::<Take>(&take).open_positions, 1);
}

#[test]
fn a_held_position_settles_at_the_horizon_after_an_early_settlement() {
    let Setup {
        mut env,
        author,
        backer,
        take,
        author_pos,
        backer_pos,
    } = setup();
    env.set_time(SOLD_AT);
    env.exit_position(&author, &take, &author_pos).unwrap();
    env.set_time(SOLD_AT + 120);
    env.record_sale(
        &take,
        &author_pos,
        vec![
            price(0, usd(110.0), SOLD_AT + 60),
            price(1, usd(1.0), SOLD_AT + 60),
        ],
    )
    .unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    // The take is settled, but the backer's position runs on: no horizon prices yet.
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    assert_error(env.crank(ix), "PriceMissing");
    assert_error(
        env.record(
            true,
            &take,
            &backer_pos,
            vec![price(0, usd(150.0), SOLD_AT + 60)],
        ),
        "HorizonNotReached",
    );

    env.set_time(HORIZON + 120);
    env.record(
        true,
        &take,
        &backer_pos,
        vec![
            price(0, usd(150.0), HORIZON + 60),
            price(1, usd(1.0), HORIZON + 60),
        ],
    )
    .unwrap();
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
    // 60% × +50% on $20, from the horizon: the author's sale doesn't settle anyone else.
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((b.scored_pnl, b.wins), (6_000_000, 1));
    // The take's headline stays at the sale.
    assert_eq!(env.fetch::<Take>(&take).result_bps, 600);
}

#[test]
fn a_closed_take_without_sale_prices_settles_at_zero_after_the_grace_period() {
    let Setup {
        mut env,
        author,
        take,
        author_pos,
        ..
    } = setup();
    env.set_time(SOLD_AT);
    env.exit_position(&author, &take, &author_pos).unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());

    // The grace period runs from the sale, not the horizon.
    env.set_time(SOLD_AT + DELAY);
    assert_error(env.crank(ix.clone()), "PriceMissing");
    env.set_time(SOLD_AT + DELAY + 1);
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.result_bps), (TakeStatus::Settled, 0));
    let p: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!(
        (p.takes_settled, p.takes_over_50, p.best_take_bps),
        (1, 0, 0)
    );
}

#[test]
fn missing_sale_prices_settle_at_zero_after_the_grace_period() {
    let Setup {
        mut env,
        backer,
        take,
        backer_pos,
        ..
    } = setup();

    env.set_time(SOLD_AT);
    env.exit_position(&backer, &take, &backer_pos).unwrap();
    let app_payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(
        &take,
        &backer_pos,
        &backer.pubkey(),
        &backer.pubkey(),
        &app_payer,
    );

    env.set_time(SOLD_AT + DELAY);
    assert_error(env.crank(ix.clone()), "PriceMissing");
    // Still before the horizon: the grace period runs from the sale.
    env.set_time(SOLD_AT + DELAY + 1);
    env.crank(ix).unwrap();
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(
        (b.positions_settled, b.scored_positions, b.scored_pnl),
        (1, 0, 0)
    );
}

#[test]
fn a_yield_only_position_settles_on_its_sale_prices() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(6_000), yield_leg(4_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 20 * USDC,
            legs_mask: 0b10,
        },
    )
    .unwrap();
    let pos = position_pda(&take, &backer.pubkey(), 1);

    env.set_time(NOW + 120);
    env.record(false, &take, &pos, vec![price(1, usd(1.0), NOW + 60)])
        .unwrap();
    env.set_time(SOLD_AT);
    env.exit_position(&backer, &take, &pos).unwrap();
    let app_payer = env.app_payer.pubkey();
    let ix =
        env.settle_sold_position_ix(&take, &pos, &backer.pubkey(), &backer.pubkey(), &app_payer);
    // Yield counts: the sale waits for the vault share's value.
    assert_error(env.crank(ix.clone()), "PriceMissing");
    env.set_time(SOLD_AT + 120);
    env.record_sale(&take, &pos, vec![price(1, usd(1.002), SOLD_AT + 60)])
        .unwrap();
    env.crank(ix).unwrap();
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    // +0.2% interest on $20: scored, a small profit, a win.
    assert_eq!((b.scored_positions, b.scored_pnl, b.wins), (1, 40_000, 1));
}
