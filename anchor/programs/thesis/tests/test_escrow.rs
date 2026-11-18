//! Prediction legs are paper-filled: their share of the stake sits in the escrow vault until the
//! position settles, while its paper result counts in the score.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID, PRICE_ONE},
};

const HORIZON: i64 = NOW + 30 * DAY;

fn back(env: &mut Env, user: &User, take: &Pubkey, id: u64, stake: u64, mask: u16) -> Pubkey {
    env.open_position(
        Side::Back,
        user,
        take,
        OpenPositionArgs {
            id,
            stake,
            legs_mask: mask,
        },
    )
    .expect("back");
    position_pda(take, &user.pubkey(), id)
}

#[test]
fn a_back_escrows_its_prediction_share_and_settlement_returns_it() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // 60% spot, 40% prediction.
    let args = env.take_args(1, vec![spot_leg(6_000), prediction_leg(4_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    // The author's own buy-in escrows 40% of its $10.
    assert_eq!(env.fetch::<Position>(&author_pos).escrowed, 4 * USDC);
    assert_eq!(env.balance(&escrow_vault_pda()), 4 * USDC);

    let backer = env.user(100 * USDC);
    let before = env.balance(&backer.usdc);
    let pos = back(&mut env, &backer, &take, 1, 20 * USDC, 0b11);
    let p: Position = env.fetch(&pos);
    assert_eq!(p.escrowed, 8 * USDC);
    assert_eq!(env.balance(&escrow_vault_pda()), 12 * USDC);
    // $12 swapped, $8 escrowed, and the 0.10% fee on the whole $20.
    assert_eq!(before - env.balance(&backer.usdc), 20 * USDC + 20_000);

    // Spot +20%, and the prediction goes from 0.40 to resolved Yes (+150%).
    env.set_time(NOW + 120);
    env.record(
        false,
        &take,
        &pos,
        vec![
            price(0, usd(100.0), NOW + 60),
            price(1, PRICE_ONE * 4 / 10, NOW + 60),
        ],
    )
    .unwrap();
    env.record(
        false,
        &take,
        &author_pos,
        vec![
            price(0, usd(100.0), NOW + 60),
            price(1, PRICE_ONE * 4 / 10, NOW + 60),
        ],
    )
    .unwrap();
    env.set_time(HORIZON + 120);
    for p in [pos, author_pos] {
        env.record(
            true,
            &take,
            &p,
            vec![
                price(0, usd(120.0), HORIZON + 60),
                price(1, PRICE_ONE, HORIZON + 60),
            ],
        )
        .unwrap();
    }
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    let before = env.balance(&backer.usdc);
    let ix = env.settle_position_ix(&take, &pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
    // The escrow comes back at cost; the paper gain isn't paid.
    assert_eq!(env.balance(&backer.usdc) - before, 8 * USDC);
    assert_eq!(env.balance(&escrow_vault_pda()), 4 * USDC);
    // But it counts in the score: 60% × +20% + 40% × +150% = +72% on $20.
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((b.scored_pnl, b.wins), (14_400_000, 1));

    let ix = env.settle_position_ix(&take, &author_pos, &author.pubkey(), &author.pubkey());
    env.crank(ix).unwrap();
    assert_eq!(env.balance(&escrow_vault_pda()), 0);
}

#[test]
fn proof_of_trade_only_needs_the_traded_share() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), prediction_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);

    // A trade that swaps only part of the spot share is still short of the traded share.
    let position = position_pda(&take, &backer.pubkey(), 1);
    let legs = env.fetch::<Take>(&take).legs;
    let mut trade = env.trade(&backer, &legs, 0b11, 18 * USDC, Side::Back);
    let begin = env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &position,
        trade.outputs_mask,
        &trade.outputs,
    );
    let receipt = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 20 * USDC,
            legs_mask: 0b11,
        },
        &trade.outputs,
    );
    let mut ixs = vec![begin];
    ixs.append(&mut trade.swaps);
    ixs.push(receipt);
    // 18 swapped − 9 escrowed by weight = $9 traded, under the $10 the spot leg needs.
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");

    // The honest trade swaps exactly the $10 spot share.
    back(&mut env, &backer, &take, 1, 20 * USDC, 0b11);
}

#[test]
fn a_prediction_only_fade_escrows_the_whole_stake_and_scores_on_no() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), prediction_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let fader = env.user(100 * USDC);
    let before = env.balance(&fader.usdc);
    // Only the prediction leg can be faded without Phoenix.
    env.open_position(
        Side::Fade,
        &fader,
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 10 * USDC,
            legs_mask: 0b10,
        },
    )
    .expect("fade");
    let pos = position_pda(&take, &fader.pubkey(), 1);
    assert_eq!(env.fetch::<Position>(&pos).escrowed, 10 * USDC);
    // Nothing traded: the whole stake is escrowed, plus the fee.
    assert_eq!(before - env.balance(&fader.usdc), 10 * USDC + 10_000);

    // Yes goes from 0.40 to resolved No: "No" from 0.60 to 1.00 is +66.66%.
    env.set_time(NOW + 120);
    env.record(
        false,
        &take,
        &pos,
        vec![price(1, PRICE_ONE * 4 / 10, NOW + 60)],
    )
    .unwrap();
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    env.record(
        false,
        &take,
        &author_pos,
        vec![
            price(0, usd(100.0), NOW + 60),
            price(1, PRICE_ONE * 4 / 10, NOW + 60),
        ],
    )
    .unwrap();
    env.set_time(HORIZON + 120);
    env.record(true, &take, &pos, vec![price(1, 0, HORIZON + 60)])
        .unwrap();
    env.record(
        true,
        &take,
        &author_pos,
        vec![
            price(0, usd(100.0), HORIZON + 60),
            price(1, 0, HORIZON + 60),
        ],
    )
    .unwrap();
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let before = env.balance(&fader.usdc);
    let ix = env.settle_position_ix(&take, &pos, &fader.pubkey(), &fader.pubkey());
    env.crank(ix).unwrap();
    assert_eq!(env.balance(&fader.usdc) - before, 10 * USDC);
    let f: Profile = env.fetch(&profile_pda(&fader.pubkey()));
    assert_eq!((f.scored_pnl, f.wins), (6_666_000, 1));
}

#[test]
fn a_sale_returns_the_escrow_at_once() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), prediction_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = back(&mut env, &backer, &take, 1, 20 * USDC, 0b11);
    env.set_time(NOW + 120);
    env.record(
        false,
        &take,
        &pos,
        vec![
            price(0, usd(100.0), NOW + 60),
            price(1, PRICE_ONE / 2, NOW + 60),
        ],
    )
    .unwrap();

    // The sale itself pays the $10 escrow back, in full, whatever the prices.
    let sold_at = NOW + DAY;
    env.set_time(sold_at);
    let vault_before = env.balance(&escrow_vault_pda());
    let before = env.balance(&backer.usdc);
    env.exit_position(&backer, &take, &pos).unwrap();
    assert_eq!(env.balance(&backer.usdc) - before, 10 * USDC);
    assert_eq!(vault_before - env.balance(&escrow_vault_pda()), 10 * USDC);
    let p: Position = env.fetch(&pos);
    assert_eq!((p.exited, p.escrowed), (true, 0));

    env.set_time(sold_at + 120);
    env.record_sale(
        &take,
        &pos,
        vec![
            price(0, usd(110.0), sold_at + 60),
            price(1, PRICE_ONE * 6 / 10, sold_at + 60),
        ],
    )
    .unwrap();
    let before = env.balance(&backer.usdc);
    let payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(&take, &pos, &backer.pubkey(), &backer.pubkey(), &payer);
    env.crank(ix).unwrap();
    // Settlement pays nothing more back; the sale scored 50% × +10% + 50% × +20%.
    assert_eq!(env.balance(&backer.usdc) - before, 0);
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(b.scored_pnl, 3_000_000);
}

#[test]
fn an_author_who_sells_gets_the_escrow_back_before_the_horizon() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(5_000), prediction_leg(5_000)], 20 * USDC);
    let take = env.create_take(&author, args);
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    assert_eq!(env.fetch::<Position>(&author_pos).escrowed, 10 * USDC);

    // The buy-in settles only with its take (its sale sets the headline), but the sale pays its
    // escrow back at once.
    env.set_time(NOW + DAY);
    let before = env.balance(&author.usdc);
    env.exit_position(&author, &take, &author_pos).unwrap();
    assert_eq!(env.balance(&author.usdc) - before, 10 * USDC);
    assert_eq!(env.fetch::<Position>(&author_pos).escrowed, 0);
    let t: Take = env.fetch(&take);
    assert_eq!(t.status, TakeStatus::Closed);
}

#[test]
fn a_sale_with_no_prediction_legs_moves_no_usdc() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = back(&mut env, &backer, &take, 1, 20 * USDC, 0b1);
    env.set_time(NOW + DAY);
    let before = env.balance(&backer.usdc);
    env.exit_position(&backer, &take, &pos).unwrap();
    assert_eq!(env.balance(&backer.usdc), before);
}

#[test]
fn the_share_rounds_down_and_legs_left_out_dont_count() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // A third prediction; the backer skips the second spot leg.
    let legs = vec![spot_leg(3_334), prediction_leg(3_333), spot_leg(3_333)];
    let args = env.take_args(1, legs, 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = back(&mut env, &backer, &take, 1, 10 * USDC + 1, 0b011);
    // 3,333 / 6,667 of 10.000001 USDC, rounded down.
    assert_eq!(
        env.fetch::<Position>(&pos).escrowed,
        (10 * USDC + 1) * 3_333 / 6_667
    );
    // No prediction leg included: nothing escrowed.
    let other = env.user(100 * USDC);
    let pos = back(&mut env, &other, &take, 1, 10 * USDC, 0b101);
    assert_eq!(env.fetch::<Position>(&pos).escrowed, 0);
}
