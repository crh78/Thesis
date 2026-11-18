//! Compute and rent budget for every instruction, on a 3-leg take (a typical basket).
//! Prints a table with `cargo test --test test_compute -- --nocapture`, and fails if an
//! instruction grows past its ceiling, so regressions show up in CI.
//!
//! Compute depends on the keys, because finding a PDA's bump takes a variable number of hashes.
//! So the flow runs once per fixed seed (reproducible) and each ceiling applies to the worst run.
// LiteSVM's failure type is large; fine in tests.
#![allow(clippy::result_large_err)]

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_lang::Space,
    common::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs, AUTHOR_POSITION_ID, PRICE_ONE},
};

/// Compute ceilings: about 10% above the worst seed (15% for the 10-leg price records, since
/// the same records cost about 5% more on a Surfpool fork). They include the program's events:
/// each is a self-CPI (`emit_cpi!`), about 2,700 CU. Keep `THESIS_COMPUTE_UNITS` in
/// packages/chain/src/constants.ts in step: clients use it to set transaction compute limits,
/// the price records use the 10-leg ceilings, the most any take can need, `exitPosition` the
/// author's sale and `settleTake` the closed 10-leg take.
const CEILINGS: &[(&str, u64)] = &[
    ("begin_trade", 19_500),
    ("create_take", 65_600),
    ("back", 57_500),
    ("back (2nd, profile exists)", 54_800),
    ("fade", 55_800),
    ("begin_trade (split trade)", 19_500),
    ("trade_step (close)", 9_800),
    ("trade_step (open)", 9_800),
    ("back (split trade)", 56_000),
    ("record_entry_prices", 10_200),
    ("record_entry_prices (10 legs)", 13_400),
    ("record_exit_prices", 11_700),
    ("record_exit_prices (10 legs)", 18_000),
    ("exit_position", 36_600),
    ("exit_position (author)", 37_300),
    ("record_sale_prices", 11_800),
    ("record_sale_prices (10 legs)", 18_000),
    ("settle_position (sold)", 21_500),
    ("settle_take", 12_800),
    ("settle_take (closed)", 19_700),
    ("settle_position", 22_900),
    ("claim_creator_fees", 14_600),
    ("mint_badge", 90_000),
];

const RUNS: usize = 24;

type Sizes = [(&'static str, (usize, u64)); 6];

fn run_once(seed: u8) -> (Vec<(&'static str, u64)>, Sizes) {
    let mut env = Env::new();
    let key = |n: u8| Keypair::new_from_array([seed.wrapping_mul(3).wrapping_add(n); 32]);
    let author = env.user_with_key(key(1), 1_000 * USDC);
    let backer = env.user_with_key(key(2), 1_000 * USDC);
    let fader = env.user_with_key(key(3), 1_000 * USDC);
    let horizon = NOW + 30 * DAY;
    let mut used: Vec<(&'static str, u64)> = Vec::new();

    let legs = vec![spot_leg(4_000), perp_leg(3_000, 2), prediction_leg(3_000)];
    let args = env.take_args(1, legs, 10 * USDC);
    let take = take_pda(&author.pubkey(), 1);
    let ixs = env.create_take_ix(&author, &author.pubkey(), args);
    let meta = env.send(&ixs, &[&author.key]).expect("create_take");
    let units = thesis_units(&meta);
    used.push(("begin_trade", units[0]));
    used.push(("create_take", units[1]));

    let back = |id| OpenPositionArgs {
        id,
        stake: 100 * USDC,
        legs_mask: 0b111,
    };
    let meta = env
        .open_position(Side::Back, &backer, &take, back(1))
        .expect("back");
    used.push(("back", thesis_units(&meta)[1]));
    let meta = env
        .open_position(Side::Back, &backer, &take, back(2))
        .expect("back");
    used.push(("back (2nd, profile exists)", thesis_units(&meta)[1]));
    // A fade holds only prediction legs (security review L-3): leg 2, its stake all escrowed.
    let fade = OpenPositionArgs {
        legs_mask: 0b100,
        ..back(1)
    };
    let meta = env
        .open_position(Side::Fade, &fader, &take, fade)
        .expect("fade");
    used.push(("fade", thesis_units(&meta)[1]));

    // A back split over two transactions: the first leg, then the other two.
    let legs = env.fetch::<Take>(&take).legs;
    let split = back(3);
    let position = position_pda(&take, &backer.pubkey(), 3);
    let trade = env.trade(&backer, &legs, split.legs_mask, split.stake, Side::Back);
    let (first, rest) = trade.swaps.split_at(1);
    // The spot leg (0) leaves a token, bought in the first transaction; the perp leg (1) leaves a
    // Phoenix position, opened in the second (its collateral swap, then its order).
    let spot_out = [trade.outputs[0]];
    let perp_out = [trade.outputs[1]];
    let tx1 = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &spot_out),
        first[0].clone(),
        env.trade_step_ix(&backer, &position, false, 0b1, &spot_out),
    ];
    let meta = env.send(&tx1, &[&backer.key]).expect("split 1");
    let units = thesis_units(&meta);
    used.push(("begin_trade (split trade)", units[0]));
    used.push(("trade_step (close)", units[1]));
    let mut tx2 = vec![env.trade_step_ix(&backer, &position, true, 0b10, &perp_out)];
    tx2.extend(rest.iter().cloned());
    tx2.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        split,
        &perp_out,
    ));
    let meta = env.send(&tx2, &[&backer.key]).expect("split 2");
    let units = thesis_units(&meta);
    used.push(("trade_step (open)", units[0]));
    used.push(("back (split trade)", units[1]));

    let author_pos = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
    let entry = vec![
        price(0, usd(100.0), NOW),
        price(1, usd(50.0), NOW),
        price(2, usd(0.4), NOW),
    ];
    let meta = env
        .record(false, &take, &author_pos, entry.clone())
        .expect("entry");
    used.push(("record_entry_prices", meta.compute_units_consumed));

    // The worst case for price records: a take with the most legs it can hold, every leg priced
    // in one call. The cost grows with the take's legs and the prices sent, so clients budget for
    // this one (a 3-leg budget ran out on a 4-leg take on the fork).
    let wide_args = env.take_args(1, (0..10).map(|_| spot_leg(1_000)).collect(), 10 * USDC);
    let wide = env.create_take(&fader, wide_args);
    let wide_pos = position_pda(&wide, &fader.pubkey(), AUTHOR_POSITION_ID);
    let wide_entry: Vec<_> = (0..10u8)
        .map(|i| price(i, usd(100.0 + f64::from(i)), NOW))
        .collect();
    let meta = env
        .record(false, &wide, &wide_pos, wide_entry.clone())
        .expect("entry (10 legs)");
    used.push(("record_entry_prices (10 legs)", meta.compute_units_consumed));
    // A back of every leg, sold below to measure a 10-leg sale.
    let wide_back = OpenPositionArgs {
        id: 1,
        stake: 100 * USDC,
        legs_mask: 0b11_1111_1111,
    };
    env.open_position(Side::Back, &backer, &wide, wide_back)
        .expect("back (10 legs)");
    let wide_sold = position_pda(&wide, &backer.pubkey(), 1);
    env.record(false, &wide, &wide_sold, wide_entry)
        .expect("entry (10 legs, sold)");

    // The backer sells their second position a day in.
    let sold = position_pda(&take, &backer.pubkey(), 2);
    env.record(false, &take, &sold, entry).expect("entry");
    env.set_time(NOW + DAY);
    let meta = env
        .exit_position(&backer, &take, &sold)
        .expect("exit_position");
    used.push(("exit_position", meta.compute_units_consumed));
    let sale = vec![
        price(0, usd(120.0), NOW + DAY),
        price(1, usd(55.0), NOW + DAY),
        price(2, usd(0.5), NOW + DAY),
    ];
    let meta = env.record_sale(&take, &sold, sale).expect("sale");
    used.push(("record_sale_prices", meta.compute_units_consumed));
    env.exit_position(&backer, &wide, &wide_sold)
        .expect("exit_position (10 legs)");
    let wide_sale = (0..10u8)
        .map(|i| price(i, usd(105.0 + f64::from(i)), NOW + DAY))
        .collect();
    let meta = env
        .record_sale(&wide, &wide_sold, wide_sale)
        .expect("sale (10 legs)");
    used.push(("record_sale_prices (10 legs)", meta.compute_units_consumed));
    // The wide take's author sells their buy-in, which closes the take (one more event), and the
    // take settles on that sale.
    let meta = env
        .exit_position(&fader, &wide, &wide_pos)
        .expect("exit_position (author)");
    used.push(("exit_position (author)", meta.compute_units_consumed));
    let author_sale = (0..10u8)
        .map(|i| price(i, usd(106.0 + f64::from(i)), NOW + DAY))
        .collect();
    env.record_sale(&wide, &wide_pos, author_sale)
        .expect("author sale (10 legs)");
    let ix = env.settle_take_ix(&wide, &fader.pubkey());
    let meta = env.crank(ix).expect("settle_take (closed)");
    used.push(("settle_take (closed)", meta.compute_units_consumed));
    let payer = env.app_payer.pubkey();
    let ix = env.settle_sold_position_ix(&take, &sold, &backer.pubkey(), &backer.pubkey(), &payer);
    let meta = env.crank(ix).expect("settle sold");
    used.push(("settle_position (sold)", meta.compute_units_consumed));

    env.set_time(horizon + HOUR);
    let exit = vec![
        price(0, usd(200.0), horizon),
        price(1, usd(60.0), horizon),
        price(2, PRICE_ONE, horizon),
    ];
    let meta = env.record(true, &take, &author_pos, exit).expect("exit");
    used.push(("record_exit_prices", meta.compute_units_consumed));
    let wide_exit = (0..10u8)
        .map(|i| price(i, usd(110.0 + f64::from(i)), horizon))
        .collect();
    let meta = env
        .record(true, &wide, &wide_pos, wide_exit)
        .expect("exit (10 legs)");
    used.push(("record_exit_prices (10 legs)", meta.compute_units_consumed));

    let ix = env.settle_take_ix(&take, &author.pubkey());
    let meta = env.crank(ix).expect("settle_take");
    used.push(("settle_take", meta.compute_units_consumed));

    let ix = env.settle_position_ix(&take, &author_pos, &author.pubkey(), &author.pubkey());
    let meta = env.crank(ix).expect("settle_position");
    used.push(("settle_position", meta.compute_units_consumed));

    let ix = env.claim_creator_fees_ix(&author, &take);
    let meta = env.send(&[ix], &[&author.key]).expect("claim");
    used.push(("claim_creator_fees", meta.compute_units_consumed));

    let meta = mint_badge(&mut env, &author.pubkey(), BadgeKind::FirstOver50).expect("badge");
    used.push(("mint_badge", meta.compute_units_consumed));

    let size = |env: &Env, k: &Pubkey| env.svm.get_account(k).map(|a| (a.data.len(), a.lamports));
    let position = size(&env, &position_pda(&take, &backer.pubkey(), 1)).unwrap();
    let take_acc = size(&env, &take).unwrap();
    let profile = size(&env, &profile_pda(&backer.pubkey())).unwrap();
    let badge = size(&env, &badge_mint(&author.pubkey(), BadgeKind::FirstOver50)).unwrap();
    // An exit on a 3-leg take, measured without sending one.
    let exit_len = Exit::space(3);
    let exit = (
        exit_len,
        env.svm.minimum_balance_for_rent_exemption(exit_len),
    );

    // A trade ticket: open only while a trade runs, refunded by its receipt.
    let ticket_len = 8 + TradeTicket::INIT_SPACE;
    let ticket = (
        ticket_len,
        env.svm.minimum_balance_for_rent_exemption(ticket_len),
    );

    let sizes = [
        ("trade ticket (refunded)", ticket),
        ("position", position),
        ("take", take_acc),
        ("profile", profile),
        ("badge mint", badge),
        ("exit", exit),
    ];
    (used, sizes)
}

#[test]
fn compute_and_rent_budget() {
    let runs: Vec<_> = (0..RUNS as u8).map(run_once).collect();
    let sizes = runs[0].1;

    println!(
        "\n{:<28} {:>8} {:>8} {:>8}",
        "instruction", "median", "max", "ceiling"
    );
    let mut over = Vec::new();
    for (i, (name, _)) in runs[0].0.iter().enumerate() {
        let mut cus: Vec<u64> = runs.iter().map(|(used, _)| used[i].1).collect();
        cus.sort_unstable();
        let (median, max) = (cus[cus.len() / 2], cus[cus.len() - 1]);
        let ceiling = CEILINGS.iter().find(|(n, _)| n == name).unwrap().1;
        println!("{name:<28} {median:>8} {max:>8} {ceiling:>8}");
        if max > ceiling {
            over.push(*name);
        }
    }
    println!(
        "\n{:<28} {:>8} {:>12}",
        "account (3 legs)", "bytes", "rent (SOL)"
    );
    for (name, (len, lamports)) in sizes {
        println!("{name:<28} {len:>8} {:>12.6}", lamports as f64 / 1e9);
    }
    assert!(over.is_empty(), "over their compute ceiling: {over:?}");
}
