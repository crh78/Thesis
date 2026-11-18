//! Steps 4–5: settler-signed prices, settlement, scoring and rent refunds.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID, PRICE_ONE},
};

const HORIZON: i64 = NOW + 30 * DAY;
const DELAY: i64 = 4 * DAY; // default max_price_delay_secs

fn open(
    env: &mut Env,
    side: Side,
    user: &User,
    take: &Pubkey,
    id: u64,
    stake: u64,
    mask: u16,
) -> Pubkey {
    env.open_position(
        side,
        user,
        take,
        OpenPositionArgs {
            id,
            stake,
            legs_mask: mask,
        },
    )
    .expect("open position");
    position_pda(take, &user.pubkey(), id)
}

fn author_position(take: &Pubkey, author: &User) -> Pubkey {
    position_pda(take, &author.pubkey(), AUTHOR_POSITION_ID)
}

#[test]
fn full_cycle_scores_each_position_on_its_own_prices_and_refunds_rent() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // 60% spot, 40% yield.
    let args = env.take_args(1, vec![spot_leg(6_000), yield_leg(4_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let backer_pos = open(&mut env, Side::Back, &backer, &take, 1, 20 * USDC, 0b11);
    // (Fades are scored in test_escrow and below: they hold prediction legs only, review L-3.)
    let author_pos = author_position(&take, &author);

    // Entry: the backer bought a different issuer's token, priced at $101.
    env.set_time(NOW + 120);
    env.record(
        false,
        &take,
        &author_pos,
        vec![price(0, usd(100.0), NOW + 60), price(1, usd(1.0), NOW + 60)],
    )
    .unwrap();
    env.record(
        false,
        &take,
        &backer_pos,
        vec![price(0, usd(101.0), NOW + 60), price(1, usd(1.0), NOW + 60)],
    )
    .unwrap();

    // Exit: every token is up 20%, and the vault share earned 2.5%.
    env.set_time(HORIZON + 120);
    env.record(
        true,
        &take,
        &author_pos,
        vec![
            price(0, usd(120.0), HORIZON + 60),
            price(1, usd(1.025), HORIZON + 60),
        ],
    )
    .unwrap();
    env.record(
        true,
        &take,
        &backer_pos,
        vec![
            price(0, usd(121.2), HORIZON + 60),
            price(1, usd(1.025), HORIZON + 60),
        ],
    )
    .unwrap();

    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!(t.status, TakeStatus::Settled);
    // 60% × +20% + 40% × +2.5% (yield) = +13%.
    assert_eq!(t.result_bps, 1_300);
    let p: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!(
        (p.takes_settled, p.takes_over_50, p.best_take_bps),
        (1, 0, 1_300)
    );

    let rent_before = env.svm.get_balance(&backer.pubkey()).unwrap();
    let position_rent = env.svm.get_account(&backer_pos).unwrap().lamports;
    for (pos, owner) in [(author_pos, author.pubkey()), (backer_pos, backer.pubkey())] {
        let ix = env.settle_position_ix(&take, &pos, &owner, &owner);
        env.crank(ix).unwrap();
        assert!(!env.exists(&pos), "position closed");
    }
    // The backer paid the rent, so the backer gets it back (the admin paid the network fee).
    assert_eq!(
        env.svm.get_balance(&backer.pubkey()).unwrap(),
        rent_before + position_rent
    );

    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((b.positions_settled, b.scored_positions, b.wins), (1, 1, 1));
    // $20 × 13% = $2.60.
    assert_eq!(b.scored_pnl, 2_600_000);
    let t: Take = env.fetch(&take);
    assert_eq!(t.open_positions, 0);
}

#[test]
fn take_settles_on_the_legs_its_author_bought() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // The author's buy-in skipped the prediction leg (no venue for it yet): it's never priced,
    // and the take's result is the spot leg alone, with no wait for the grace period.
    let mut args = env.take_args(1, vec![spot_leg(6_000), prediction_leg(4_000)], 10 * USDC);
    args.legs_mask = 0b01;
    let take = env.create_take(&author, args);
    let author_pos = author_position(&take, &author);
    let p: Position = env.fetch(&author_pos);
    assert_eq!(p.legs_mask, 0b01);

    env.set_time(NOW + 120);
    env.record(
        false,
        &take,
        &author_pos,
        vec![price(0, usd(100.0), NOW + 60)],
    )
    .unwrap();
    // A leg the buy-in left out takes no price.
    assert_error(
        env.record(
            false,
            &take,
            &author_pos,
            vec![price(1, PRICE_ONE / 2, NOW + 60)],
        ),
        "InvalidLegsMask",
    );
    env.set_time(HORIZON + 120);
    env.record(
        true,
        &take,
        &author_pos,
        vec![price(0, usd(160.0), HORIZON + 60)],
    )
    .unwrap();

    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.result_bps), (TakeStatus::Settled, 6_000));
    let p: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!((p.takes_over_50, p.best_take_bps), (1, 6_000));
}

#[test]
fn price_rules_timing_signer_and_legs() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), yield_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let pos = author_position(&take, &author);
    env.set_time(NOW + 120);

    // Before the trade, too late after it, and in the future.
    assert_error(
        env.record(false, &take, &pos, vec![price(0, usd(10.0), NOW - 1)]),
        "PriceTooEarly",
    );
    assert_error(
        env.record(
            false,
            &take,
            &pos,
            vec![price(0, usd(10.0), NOW + DELAY + 1)],
        ),
        "PriceTooLate",
    );
    assert_error(
        env.record(false, &take, &pos, vec![price(0, usd(10.0), NOW + 121)]),
        "PriceTooLate",
    );
    // Zero entry prices aren't allowed, for a yield leg's vault share either.
    assert_error(
        env.record(false, &take, &pos, vec![price(0, 0, NOW + 60)]),
        "InvalidPrice",
    );
    assert_error(
        env.record(false, &take, &pos, vec![price(1, 0, NOW + 60)]),
        "InvalidPrice",
    );
    // Yield legs are priced: one vault share's value.
    env.record(false, &take, &pos, vec![price(1, usd(1.0), NOW + 60)])
        .unwrap();

    // Only the settler can sign.
    let stranger = env.user(0);
    let ix = env.record_prices_ix(
        false,
        &stranger.pubkey(),
        &take,
        &pos,
        vec![price(0, usd(10.0), NOW + 60)],
    );
    assert!(env.send(&[ix], &[&stranger.key]).is_err());

    env.record(false, &take, &pos, vec![price(0, usd(10.0), NOW + 60)])
        .unwrap();
    assert_error(
        env.record(false, &take, &pos, vec![price(0, usd(11.0), NOW + 60)]),
        "PriceAlreadySet",
    );

    // Exit prices wait for the horizon, and must be published at or after it.
    assert_error(
        env.record(true, &take, &pos, vec![price(0, usd(12.0), NOW + 60)]),
        "HorizonNotReached",
    );
    env.set_time(HORIZON + 120);
    assert_error(
        env.record(true, &take, &pos, vec![price(0, usd(12.0), HORIZON - 1)]),
        "PriceTooEarly",
    );
    env.record(true, &take, &pos, vec![price(0, usd(12.0), HORIZON)])
        .unwrap();
}

#[test]
fn positions_only_accept_prices_for_their_own_legs() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), spot_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = open(&mut env, Side::Back, &backer, &take, 1, 10 * USDC, 0b10);
    env.set_time(NOW + 120);
    assert_error(
        env.record(false, &take, &pos, vec![price(0, usd(10.0), NOW + 60)]),
        "InvalidLegsMask",
    );
    env.record(false, &take, &pos, vec![price(1, usd(10.0), NOW + 60)])
        .unwrap();
}

#[test]
fn prediction_legs_pay_out_both_ways_and_can_resolve_at_zero() {
    for (resolved, back_bps, fade_bps) in [(PRICE_ONE, 15_000, -10_000), (0, -10_000, 6_666)] {
        let mut env = Env::new();
        let author = env.user(100 * USDC);
        let args = env.take_args(1, vec![prediction_leg(10_000)], 10 * USDC);
        let take = env.create_take(&author, args);
        let fader = env.user(100 * USDC);
        let fader_pos = open(&mut env, Side::Fade, &fader, &take, 1, 10 * USDC, 0b1);
        let author_pos = author_position(&take, &author);

        // Bought at 40% odds.
        env.set_time(NOW + 120);
        for pos in [author_pos, fader_pos] {
            env.record(false, &take, &pos, vec![price(0, 40_000_000, NOW + 60)])
                .unwrap();
        }
        env.set_time(HORIZON + 120);
        for pos in [author_pos, fader_pos] {
            env.record(true, &take, &pos, vec![price(0, resolved, HORIZON + 60)])
                .unwrap();
        }
        let ix = env.settle_take_ix(&take, &author.pubkey());
        env.crank(ix).unwrap();
        let t: Take = env.fetch(&take);
        assert_eq!(t.result_bps, back_bps);

        let ix = env.settle_position_ix(&take, &fader_pos, &fader.pubkey(), &fader.pubkey());
        env.crank(ix).unwrap();
        let f: Profile = env.fetch(&profile_pda(&fader.pubkey()));
        assert_eq!(f.scored_pnl, 10 * USDC as i64 * fade_bps / 10_000);

        let a: Profile = env.fetch(&profile_pda(&author.pubkey()));
        let won_big = (back_bps >= 10_000) as u32;
        assert_eq!((a.takes_over_50, a.takes_over_100), (won_big, won_big));
    }
}

#[test]
fn leverage_multiplies_moves_but_a_leg_never_loses_more_than_everything() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![perp_leg(10_000, 5)], 10 * USDC);
    let take = env.create_take(&author, args);
    let pos = author_position(&take, &author);
    env.set_time(NOW + 120);
    env.record(false, &take, &pos, vec![price(0, usd(100.0), NOW + 60)])
        .unwrap();
    env.set_time(HORIZON + 120);
    // −30% × 5 = −150%, capped at −100%.
    env.record(true, &take, &pos, vec![price(0, usd(70.0), HORIZON + 60)])
        .unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!(t.result_bps, -10_000);
}

#[test]
fn settlement_order_missing_prices_and_the_grace_period() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let backer_pos = open(&mut env, Side::Back, &backer, &take, 1, 10 * USDC, 0b1);

    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "HorizonNotReached");
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    assert_error(env.crank(ix), "TakeNotSettled");

    // After the horizon but inside the grace period, missing prices block settlement.
    env.set_time(HORIZON + 60);
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "PriceMissing");

    // Once the grace period has passed, it settles at 0% and the position is unscored.
    env.set_time(HORIZON + DELAY + 1);
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.status, t.result_bps), (TakeStatus::Settled, 0));
    let ix = env.settle_take_ix(&take, &author.pubkey());
    assert_error(env.crank(ix), "TakeAlreadySettled");

    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(
        (b.positions_settled, b.scored_positions, b.scored_pnl),
        (1, 0, 0)
    );
    let a: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!((a.takes_settled, a.takes_over_50), (1, 0));
}

#[test]
fn rent_goes_back_to_whoever_paid_it_not_the_caller() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let ixs = env.open_position_ix(
        Side::Back,
        &backer,
        &app_payer.pubkey(),
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 10 * USDC,
            legs_mask: 0b1,
        },
    );
    env.send(&ixs, &[&app_payer, &backer.key]).unwrap();
    let pos = position_pda(&take, &backer.pubkey(), 1);
    let rent = env.svm.get_account(&pos).unwrap().lamports;

    env.set_time(HORIZON + DELAY + 1);
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    // Naming someone else as the rent payer fails.
    let stranger = env.user(0);
    let ix = env.settle_position_ix(&take, &pos, &backer.pubkey(), &stranger.pubkey());
    assert!(env.crank(ix).is_err());

    let before = env.svm.get_balance(&app_payer.pubkey()).unwrap();
    let ix = env.settle_position_ix(&take, &pos, &backer.pubkey(), &app_payer.pubkey());
    env.crank(ix).unwrap();
    assert_eq!(
        env.svm.get_balance(&app_payer.pubkey()).unwrap(),
        before + rent
    );
}

#[test]
fn settlement_rejects_positions_and_profiles_that_belong_to_someone_else() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let other_take = env.create_take(&author, env.take_args(2, vec![spot_leg(10_000)], 10 * USDC));
    let backer = env.user(100 * USDC);
    let backer_pos = open(&mut env, Side::Back, &backer, &take, 1, 10 * USDC, 0b1);
    env.set_time(HORIZON + DELAY + 1);

    // settle_take accounts: config, take, author_position, author_profile, author_exit.
    let swap = |env: &Env, i: usize, key: Pubkey| {
        let mut ix = env.settle_take_ix(&take, &author.pubkey());
        ix.accounts[i].pubkey = key;
        ix
    };
    for (i, key) in [
        (2, backer_pos),                            // not the author's buy-in
        (2, author_position(&other_take, &author)), // the author's buy-in on another take
        (3, profile_pda(&backer.pubkey())),         // someone else's profile
    ] {
        let ix = swap(&env, i, key);
        assert_error(env.crank(ix), "AccountMismatch");
    }
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    // settle_position accounts: config, take, position, owner_profile, rent_payer.
    let mut ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    ix.accounts[3].pubkey = profile_pda(&author.pubkey());
    assert_error(env.crank(ix), "AccountMismatch");
    let ix = env.settle_position_ix(&take, &backer_pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
}

#[test]
fn prices_that_make_a_return_too_large_to_record_are_refused() {
    // Security review L-1: such a return used to read as "price missing", so the position
    // waited out the grace period and settled at 0%, unscored. Now the settler's call fails.
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = open(&mut env, Side::Back, &backer, &take, 1, 20 * USDC, 0b1);
    env.set_time(NOW + 120);
    // An entry at the smallest price the program takes.
    env.record(false, &take, &pos, vec![price(0, 1, NOW + 60)])
        .unwrap();

    env.set_time(HORIZON + 120);
    // The return itself doesn't fit an i64.
    assert_error(
        env.record(true, &take, &pos, vec![price(0, u64::MAX, HORIZON + 60)]),
        "ReturnOutOfRange",
    );
    // The return fits, but its P&L on $20 doesn't (1e16 bps × $20).
    assert_error(
        env.record(
            true,
            &take,
            &pos,
            vec![price(0, 1_000_000_000_000, HORIZON + 60)],
        ),
        "ReturnOutOfRange",
    );
    // A price that fits is still recorded.
    env.record(true, &take, &pos, vec![price(0, 3, HORIZON + 60)])
        .unwrap();
    let p: Position = env.fetch(&pos);
    assert_eq!(p.exit_set, 0b1);
}
