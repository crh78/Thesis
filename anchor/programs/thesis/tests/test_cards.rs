//! Collector Crypt card legs are paper-filled: no card NFT is bought, since
//! proof of trade can't count one (Core assets aren't token accounts, pNFT accounts are always
//! frozen). Their share of the stake sits in the escrow vault, like a prediction leg's, and comes
//! back in full; their price, the card's insured value in dollars, counts only in the score.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
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
fn card_legs_are_escrowed_and_need_no_token() {
    let legs = [spot_leg(8_000), card_leg(2_000)];
    let required = thesis::proof::required_outputs(&legs, 0b11, Side::Back);
    assert_eq!((required.tokens, required.phoenix), (0b01, 0));
    assert!(LegKind::Card.is_escrowed() && LegKind::Prediction.is_escrowed());
    assert!(
        !LegKind::Spot.is_escrowed()
            && !LegKind::Yield.is_escrowed()
            && !LegKind::Perp.is_escrowed()
    );
    // 20% of $20, and nothing when the card leg is left out.
    assert_eq!(
        thesis::utils::escrow_share(&legs, 0b11, 20 * USDC).unwrap(),
        4 * USDC
    );
    assert_eq!(
        thesis::utils::escrow_share(&legs, 0b01, 20 * USDC).unwrap(),
        0
    );
}

#[test]
fn a_back_escrows_its_card_share_and_scores_it_in_dollars() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // 80% spot, 20% card.
    let args = env.take_args(1, vec![spot_leg(8_000), card_leg(2_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    assert_eq!(env.fetch::<Position>(&author_pos).escrowed, 2 * USDC);

    let backer = env.user(100 * USDC);
    let before = env.balance(&backer.usdc);
    let pos = back(&mut env, &backer, &take, 1, 20 * USDC, 0b11);
    assert_eq!(env.fetch::<Position>(&pos).escrowed, 4 * USDC);
    assert_eq!(env.balance(&escrow_vault_pda()), 6 * USDC);
    // $16 swapped, $4 escrowed, and the 0.10% fee on the whole $20.
    assert_eq!(before - env.balance(&backer.usdc), 20 * USDC + 20_000);

    // Card prices are dollars, not odds: a $52 card is recorded as $52.
    env.set_time(NOW + 120);
    for p in [pos, author_pos] {
        env.record(
            false,
            &take,
            &p,
            vec![
                price(0, usd(100.0), NOW + 60),
                price(1, usd(52.0), NOW + 60),
            ],
        )
        .unwrap();
    }
    assert!(usd(52.0) > PRICE_ONE);
    // Spot +10%, the card's insured value $52 → $65 (+25%).
    env.set_time(HORIZON + 120);
    for p in [pos, author_pos] {
        env.record(
            true,
            &take,
            &p,
            vec![
                price(0, usd(110.0), HORIZON + 60),
                price(1, usd(65.0), HORIZON + 60),
            ],
        )
        .unwrap();
    }
    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();

    let before = env.balance(&backer.usdc);
    let ix = env.settle_position_ix(&take, &pos, &backer.pubkey(), &backer.pubkey());
    env.crank(ix).unwrap();
    // The escrow comes back at cost; the card's gain isn't paid.
    assert_eq!(env.balance(&backer.usdc) - before, 4 * USDC);
    // But it counts in the score: 80% × +10% + 20% × +25% = +13% on $20.
    let b: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!((b.scored_pnl, b.wins), (2_600_000, 1));

    let ix = env.settle_position_ix(&take, &author_pos, &author.pubkey(), &author.pubkey());
    env.crank(ix).unwrap();
    assert_eq!(env.balance(&escrow_vault_pda()), 0);
}

#[test]
fn a_card_entry_price_must_be_above_zero() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(8_000), card_leg(2_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    env.set_time(NOW + 120);
    let zero = env.record(false, &take, &author_pos, vec![price(1, 0, NOW + 60)]);
    assert_error(zero, "InvalidPrice");
}

#[test]
fn a_sale_returns_the_card_escrow_at_once() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(8_000), card_leg(2_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let backer = env.user(100 * USDC);
    let pos = back(&mut env, &backer, &take, 1, 20 * USDC, 0b11);

    env.set_time(NOW + DAY);
    let before = env.balance(&backer.usdc);
    env.exit_position(&backer, &take, &pos).unwrap();
    assert_eq!(env.balance(&backer.usdc) - before, 4 * USDC);
    let p: Position = env.fetch(&pos);
    assert_eq!((p.exited, p.escrowed), (true, 0));
}

#[test]
fn fades_leave_card_legs_out() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![prediction_leg(8_000), card_leg(2_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    let fader = env.user(100 * USDC);
    let fade = |env: &mut Env, mask: u16, id: u64| {
        env.open_position(
            Side::Fade,
            &fader,
            &take,
            OpenPositionArgs {
                id,
                stake: 10 * USDC,
                legs_mask: mask,
            },
        )
    };
    // A card can't be shorted: a fade that includes it is refused.
    assert_error(fade(&mut env, 0b11, 1), "LegNotFadeable");
    // Without it, the fade goes through on the prediction leg alone.
    fade(&mut env, 0b01, 2).expect("fade without the card");
}
