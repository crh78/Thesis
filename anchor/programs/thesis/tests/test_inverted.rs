// Inverted takes: a take that bets against its basket ("crypto sucks" over a BTC perp). The
// author's buy-in, and everyone who agrees, hold the fade; a back disagrees.
mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID},
};

const HORIZON: i64 = NOW + 30 * DAY;

fn args(id: u64, stake: u64, legs_mask: u16) -> OpenPositionArgs {
    OpenPositionArgs {
        id,
        stake,
        legs_mask,
    }
}

/// An author and an inverted take on a perp and a prediction market, with a $10 buy-in.
fn env_with_inverted_take() -> (Env, User, Pubkey) {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take_args = env.inverted_take_args(
        1,
        vec![perp_leg(6_000, 2), prediction_leg(4_000)],
        10 * USDC,
    );
    let take = env.create_take(&author, take_args);
    (env, author, take)
}

#[test]
fn an_inverted_take_records_the_authors_buy_in_as_a_fade() {
    let (env, author, take) = env_with_inverted_take();
    let t: Take = env.fetch(&take);
    assert!(t.inverted);
    assert_eq!(t.agree_side(), Side::Fade);
    assert_eq!((t.backers, t.faders, t.open_positions), (0, 1, 1));
    assert_eq!((t.total_backed, t.total_faded), (0, 10 * USDC));

    let p: Position = env.fetch(&position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID));
    assert_eq!(p.side, Side::Fade);
    assert_eq!(p.legs_mask, 0b11);
    // The prediction share is escrowed, as on any fade.
    assert_eq!(p.escrowed, 4 * USDC);
}

#[test]
fn an_inverted_take_needs_every_leg_fadeable() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    // Cash can't be faded, even when the author's buy-in leaves it out.
    let mut a = env.inverted_take_args(1, vec![perp_leg(7_500, 1), yield_leg(2_500)], 10 * USDC);
    a.legs_mask = 0b01;
    assert_error(env.try_create_take(&author, a), "LegNotFadeable");
    let a = env.inverted_take_args(2, vec![card_leg(10_000)], 10 * USDC);
    assert_error(env.try_create_take(&author, a), "LegNotFadeable");
    // A plain take with the same legs is fine.
    let a = env.take_args(3, vec![perp_leg(7_500, 1), yield_leg(2_500)], 10 * USDC);
    env.create_take(&author, a);
}

#[test]
fn the_author_can_add_to_their_side_but_not_take_the_other() {
    let (mut env, author, take) = env_with_inverted_take();
    // Backing their own inverted take bets against it.
    assert_error(
        env.open_position(Side::Back, &author, &take, args(1, 10 * USDC, 0b11)),
        "AuthorCannotFade",
    );
    // Adding to the fade agrees with it.
    env.open_position(Side::Fade, &author, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    // Anyone can disagree with a back.
    let doubter = env.user(100 * USDC);
    env.open_position(Side::Back, &doubter, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    let t: Take = env.fetch(&take);
    assert_eq!((t.backers, t.faders, t.open_positions), (1, 2, 3));
}

#[test]
fn the_creator_boost_counts_the_side_that_agrees() {
    let (mut env, _author, take) = env_with_inverted_take();
    let agree = env.user(100 * USDC);
    env.open_position(Side::Fade, &agree, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    let after_fade: Take = env.fetch(&take);
    assert!(after_fade.platform_fees_from_backs > 0);

    let disagree = env.user(100 * USDC);
    env.open_position(Side::Back, &disagree, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    let after_back: Take = env.fetch(&take);
    assert_eq!(
        after_back.platform_fees_from_backs,
        after_fade.platform_fees_from_backs
    );
    // Both pay the creator.
    assert!(after_back.creator_fees_unclaimed > after_fade.creator_fees_unclaimed);
}

#[test]
fn an_inverted_take_wins_when_its_basket_falls() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take = env.create_take(
        &author,
        env.inverted_take_args(1, vec![perp_leg(10_000, 1)], 10 * USDC),
    );
    let pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);

    env.set_time(NOW + 120);
    env.record(false, &take, &pos, vec![price(0, usd(100.0), NOW + 60)])
        .unwrap();
    env.set_time(HORIZON + 120);
    env.record(true, &take, &pos, vec![price(0, usd(80.0), HORIZON + 60)])
        .unwrap();

    let ix = env.settle_take_ix(&take, &author.pubkey());
    env.crank(ix).unwrap();
    let t: Take = env.fetch(&take);
    // The perp fell 20%: the fade, and so the take, made 20%.
    assert_eq!((t.status, t.result_bps), (TakeStatus::Settled, 2_000));
}

#[test]
fn a_plain_take_is_unchanged() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take = env.create_take(
        &author,
        env.take_args(1, vec![perp_leg(10_000, 1)], 10 * USDC),
    );
    let t: Take = env.fetch(&take);
    assert!(!t.inverted);
    assert_eq!((t.backers, t.faders), (1, 0));
    assert_error(
        env.open_position(Side::Fade, &author, &take, args(1, 10 * USDC, 0b1)),
        "AuthorCannotFade",
    );
}
