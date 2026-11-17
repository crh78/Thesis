//! Proof of trade: `begin_trade`, `trade_step` and the receipt's checks. The honest trades, and
//! a failing test for every attack in docs/hardening-plan.md (item 1).
// LiteSVM's failure type is large; fine in tests.
#![allow(clippy::result_large_err)]

mod common;

use {
    anchor_lang::{
        prelude::{AccountMeta, Pubkey},
        solana_program::instruction::Instruction,
        system_program,
    },
    common::*,
    solana_signer::Signer,
    thesis::{state::*, OpenPositionArgs},
};

fn args(id: u64, stake: u64, legs_mask: u16) -> OpenPositionArgs {
    OpenPositionArgs {
        id,
        stake,
        legs_mask,
    }
}

/// A config, and a take whose author bought a spot leg (60%) and a perp leg (40%).
fn setup() -> (Env, User, Pubkey) {
    let mut env = Env::new();
    let author = env.user(1_000 * USDC);
    let take_args = env.take_args(1, vec![spot_leg(6_000), perp_leg(4_000, 2)], 10 * USDC);
    let take = env.create_take(&author, take_args);
    (env, author, take)
}

fn legs(env: &Env, take: &Pubkey) -> Vec<LegSpec> {
    env.fetch::<Take>(take).legs
}

/// A plain SPL Token transfer, signed by `authority`.
fn transfer_ix(from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: token_program(),
        accounts: vec![
            AccountMeta::new(*from, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// The Associated Token program's idempotent create.
fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> (Pubkey, Instruction) {
    let ata = get_associated_token_address_with_program_id(owner, mint, &token_program());
    let ix = Instruction {
        program_id: anchor_spl::associated_token::ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(token_program(), false),
        ],
        data: vec![1],
    };
    (ata, ix)
}

fn ticket_of(env: &Env, owner: &User, take: &Pubkey, id: u64) -> Pubkey {
    let _ = env;
    ticket_pda(&owner.pubkey(), &position_pda(take, &owner.pubkey(), id))
}

// The honest trade

#[test]
fn honest_back_in_one_transaction_records_and_closes_the_ticket() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let payer_before = env.svm.get_balance(&app_payer.pubkey()).unwrap();

    let ixs = env.open_position_ix(
        Side::Back,
        &backer,
        &app_payer.pubkey(),
        &take,
        args(1, 20 * USDC, 0b11),
    );
    env.send(&ixs, &[&app_payer, &backer.key]).unwrap();

    let position: Position = env.fetch(&position_pda(&take, &backer.pubkey(), 1));
    assert_eq!(position.stake, 20 * USDC);
    // The ticket is gone, and its rent came back in the same transaction: the app payer paid
    // only the position's and the new profile's rent, and the network fee (two signatures).
    assert!(!env.exists(&ticket_of(&env, &backer, &take, 1)));
    let rent = |env: &Env, k: &Pubkey| env.svm.get_account(k).unwrap().lamports;
    let kept = rent(&env, &position_pda(&take, &backer.pubkey(), 1))
        + rent(&env, &profile_pda(&backer.pubkey()));
    let spent = payer_before - env.svm.get_balance(&app_payer.pubkey()).unwrap();
    assert_eq!(spent, kept + 10_000);
    // The backer holds the spot token; the stake and the fee left their USDC.
    let spot = env.holding(&backer.pubkey(), &legs(&env, &take)[0].asset);
    assert_eq!(env.balance(&spot), 12 * USDC);
    assert_eq!(env.balance(&backer.usdc), 100 * USDC - 20 * USDC - 20_000);
}

#[test]
fn honest_create_take_with_a_new_associated_token_account() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take_args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = take_pda(&author.pubkey(), 1);
    let position = position_pda(&take, &author.pubkey(), 0);
    let (mint, pool_out) = env.market(&take_args.legs[0].asset);
    // The output account doesn't exist when the trade begins: the swap's setup creates it,
    // as Jupiter's does.
    let (ata, create) = create_ata_ix(&author.pubkey(), &author.pubkey(), &mint);
    let ixs = vec![
        env.begin_trade_ix(&author, &author.pubkey(), &position, 0b1, &[ata]),
        create,
        env.swap_ix(
            &author.pubkey(),
            &author.usdc,
            10 * USDC,
            &pool_out,
            &ata,
            7,
        ),
        env.create_take_receipt_ix(&author, &author.pubkey(), take_args, &[ata]),
    ];
    env.send(&ixs, &[&author.key]).unwrap();
    assert_eq!(env.fetch::<Take>(&take).total_backed, 10 * USDC);
    assert_eq!(env.balance(&ata), 7);
}

#[test]
fn honest_back_split_over_three_transactions() {
    let mut env = Env::new();
    let author = env.user(1_000 * USDC);
    let basket = vec![spot_leg(4_000), spot_leg(3_000), yield_leg(3_000)];
    let take_args = env.take_args(1, basket.clone(), 10 * USDC);
    let take = env.create_take(&author, take_args);
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &basket, 0b111, 30 * USDC, Side::Back);
    let o = &trade.outputs;

    // One leg per transaction, each bracketed; the receipt rides with the last leg.
    let tx1 = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b001, &o[0..1]),
        trade.swaps[0].clone(),
        env.trade_step_ix(&backer, &position, false, 0b001, &o[0..1]),
    ];
    env.send(&tx1, &[&backer.key]).unwrap();
    let ticket: TradeTicket = env.fetch(&ticket_pda(&backer.pubkey(), &position));
    assert_eq!((ticket.spent, ticket.grown), (12 * USDC, 0b001));
    assert_eq!(
        ticket.received[0],
        12 * USDC,
        "the mock pays one token per USDC"
    );
    assert_eq!(ticket.open_ix, TradeTicket::NO_BRACKET);

    let tx2 = [
        env.trade_step_ix(&backer, &position, true, 0b010, &o[1..2]),
        trade.swaps[1].clone(),
        env.trade_step_ix(&backer, &position, false, 0b010, &o[1..2]),
    ];
    env.send(&tx2, &[&backer.key]).unwrap();

    // Between transactions, money comes and goes outside any bracket: it doesn't count.
    let friend = env.user(50 * USDC);
    env.send(
        &[transfer_ix(
            &friend.usdc,
            &backer.usdc,
            &friend.pubkey(),
            5 * USDC,
        )],
        &[&friend.key],
    )
    .unwrap();

    let tx3 = [
        env.trade_step_ix(&backer, &position, true, 0b100, &o[2..3]),
        trade.swaps[2].clone(),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 30 * USDC, 0b111),
            &o[2..3],
        ),
    ];
    env.send(&tx3, &[&backer.key]).unwrap();
    assert_eq!(env.fetch::<Take>(&take).total_backed, 40 * USDC);
    assert!(!env.exists(&ticket_pda(&backer.pubkey(), &position)));
}

#[test]
fn fades_of_spot_and_perp_legs_need_phoenix_shorts() {
    // Security review L-3: a fade of a spot or perp leg must open a short on Phoenix in the
    // trade. Spending the stake anywhere else (into Jupiter Lend, say) would pad the fade counters.
    let (mut env, _author, take) = setup();
    let fader = env.user(100 * USDC);
    let legs = legs(&env, &take);

    // The stake spent, but no short opened: refused.
    let position = position_pda(&take, &fader.pubkey(), 1);
    let shorts: Vec<Pubkey> = legs
        .iter()
        .map(|l| env.phoenix_account(&fader.pubkey(), &l.asset))
        .collect();
    let (_, pool_out) = env.market(&legs[0].asset);
    let sink = env.holding(&Pubkey::new_unique(), &legs[0].asset);
    let ixs = [
        env.begin_trade_ix(&fader, &fader.pubkey(), &position, 0b11, &shorts),
        env.swap_ix(&fader.pubkey(), &fader.usdc, 10 * USDC, &pool_out, &sink, 0),
        env.receipt_ix(
            Side::Fade,
            &fader,
            &fader.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &shorts,
        ),
    ];
    assert_error(env.send(&ixs, &[&fader.key]), "OutputNotBought");

    // A token bought instead of a short: refused, though the account grew.
    let trade = env.trade(&fader, &legs, 0b11, 10 * USDC, Side::Back);
    let mut ixs =
        vec![env.begin_trade_ix(&fader, &fader.pubkey(), &position, 0b11, &trade.outputs)];
    ixs.extend(trade.swaps);
    ixs.push(env.receipt_ix(
        Side::Fade,
        &fader,
        &fader.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &trade.outputs,
    ));
    assert_error(env.send(&ixs, &[&fader.key]), "InvalidOutputAccount");
    assert_eq!(env.fetch::<Take>(&take).faders, 0);

    // Shorts on Phoenix: recorded.
    env.open_position(Side::Fade, &fader, &take, args(2, 10 * USDC, 0b11))
        .unwrap();
    for leg in &legs {
        let account = env.phoenix_account(&fader.pubkey(), &leg.asset);
        assert!(env.phoenix_position(&account) < 0);
    }
    let t = env.fetch::<Take>(&take);
    assert_eq!((t.faders, t.total_faded), (1, 10 * USDC));
}

// Phoenix legs

#[test]
fn honest_back_with_a_perp_leg_opens_a_phoenix_position() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    env.open_position(Side::Back, &backer, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    let legs = legs(&env, &take);
    let perp = env.phoenix_account(&backer.pubkey(), &legs[1].asset);
    assert_eq!(env.phoenix_position(&perp), 4 * USDC as i64);
    // The author's buy-in did the same for the perp leg (create_take checks it too).
    let author_perp = env.phoenix_account(&_author.pubkey(), &legs[1].asset);
    assert!(env.phoenix_position(&author_perp) > 0);
}

/// The take's perp leg traded with these instructions in place of the honest ones.
fn back_with_perp(
    env: &mut Env,
    backer: &User,
    take: &Pubkey,
    perp_output: Pubkey,
    perp_ixs: Vec<Instruction>,
) -> TxResult {
    let legs = legs(env, take);
    let spot_trade = env.trade(backer, &legs, 0b01, 6 * USDC, Side::Back);
    let outputs = [spot_trade.outputs[0], perp_output];
    let position = position_pda(take, &backer.pubkey(), 1);
    let mut ixs = vec![env.begin_trade_ix(backer, &backer.pubkey(), &position, 0b11, &outputs)];
    ixs.extend(spot_trade.swaps);
    ixs.extend(perp_ixs);
    ixs.push(env.receipt_ix(
        Side::Back,
        backer,
        &backer.pubkey(),
        take,
        args(1, 10 * USDC, 0b11),
        &outputs,
    ));
    env.send(&ixs, &[&backer.key])
}

/// 4 USDC into the venue, as a perp leg's collateral would go.
fn collateral_ix(env: &mut Env, backer: &User, take: &Pubkey) -> Instruction {
    let asset = legs(env, take)[1].asset;
    let (_, pool_out) = env.market(&asset);
    let sink = env.holding(&Pubkey::new_unique(), &asset);
    env.swap_ix(
        &backer.pubkey(),
        &backer.usdc,
        4 * USDC,
        &pool_out,
        &sink,
        0,
    )
}

#[test]
fn collateral_that_never_trades_is_not_a_perp_position() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let asset = legs(&env, &take)[1].asset;
    let account = env.phoenix_account(&backer.pubkey(), &asset);
    let deposit = collateral_ix(&mut env, &backer, &take);
    assert_error(
        back_with_perp(&mut env, &backer, &take, account, vec![deposit]),
        "OutputNotBought",
    );
}

#[test]
fn a_position_opened_before_the_trade_does_not_count() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let asset = legs(&env, &take)[1].asset;
    let account = env.phoenix_account(&backer.pubkey(), &asset);
    let order = env.place_market_order_ix(&backer.pubkey(), &account, 4 * USDC as i64);
    env.send(&[order], &[&backer.key]).unwrap();
    let deposit = collateral_ix(&mut env, &backer, &take);
    assert_error(
        back_with_perp(&mut env, &backer, &take, account, vec![deposit]),
        "OutputNotBought",
    );
}

#[test]
fn a_perp_leg_needs_a_phoenix_account_of_the_owner() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let friend = env.user(0);
    let asset = legs(&env, &take)[1].asset;

    // The friend's Phoenix account.
    let theirs = env.phoenix_account(&friend.pubkey(), &asset);
    let deposit = collateral_ix(&mut env, &backer, &take);
    let order = env.place_market_order_ix(&backer.pubkey(), &theirs, 4 * USDC as i64);
    assert_error(
        back_with_perp(&mut env, &backer, &take, theirs, vec![deposit, order]),
        "InvalidOutputAccount",
    );

    // A token account that grew, standing in for the perp leg.
    let token = env.holding(&backer.pubkey(), &asset);
    let (_, pool_out) = env.market(&asset);
    let buy = env.swap_ix(
        &backer.pubkey(),
        &backer.usdc,
        4 * USDC,
        &pool_out,
        &token,
        4 * USDC,
    );
    assert_error(
        back_with_perp(&mut env, &backer, &take, token, vec![buy]),
        "InvalidOutputAccount",
    );

    // An account Phoenix owns that isn't a trader account.
    let not_trader = Pubkey::new_unique();
    let mut data = phoenix_trader_data(&backer.pubkey());
    data[0] ^= 0xff;
    env.set_phoenix_account(not_trader, data);
    let deposit = collateral_ix(&mut env, &backer, &take);
    assert_error(
        back_with_perp(&mut env, &backer, &take, not_trader, vec![deposit]),
        "InvalidOutputAccount",
    );
}

#[test]
fn a_spot_leg_cannot_be_proved_with_a_phoenix_position() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let legs = legs(&env, &take);
    let long = env.phoenix_account(&backer.pubkey(), &legs[0].asset);
    let perp = env.trade(&backer, &legs, 0b10, 4 * USDC, Side::Back);
    let (_, pool_out) = env.market(&legs[0].asset);
    let sink = env.holding(&Pubkey::new_unique(), &legs[0].asset);
    let outputs = [long, perp.outputs[0]];
    let position = position_pda(&take, &backer.pubkey(), 1);
    let mut ixs = vec![
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b11, &outputs),
        env.swap_ix(
            &backer.pubkey(),
            &backer.usdc,
            6 * USDC,
            &pool_out,
            &sink,
            0,
        ),
        env.place_market_order_ix(&backer.pubkey(), &long, 6 * USDC as i64),
    ];
    ixs.extend(perp.swaps);
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &outputs,
    ));
    assert_error(env.send(&ixs, &[&backer.key]), "InvalidOutputAccount");
}

/// `sha256("global:<name>")[..8]`, the prefix Phoenix's and Ember's instructions start with
/// (computed off-line: the tests have no hasher).
fn ix_prefix(name: &str) -> Vec<u8> {
    match name {
        "deposit_funds" => vec![202, 39, 52, 211, 53, 20, 250, 88],
        "place_market_order" => vec![90, 118, 192, 252, 192, 99, 39, 145],
        "register_trader" => vec![75, 243, 224, 167, 1, 5, 51, 32],
        "sync_parent_to_child" => vec![175, 137, 217, 11, 235, 39, 150, 19],
        "withdraw_funds" => vec![241, 36, 29, 111, 208, 31, 104, 217],
        "transfer_collateral" => vec![157, 163, 63, 27, 242, 72, 251, 97],
        "transfer_collateral_child_to_parent" => vec![51, 100, 177, 115, 139, 135, 247, 139],
        "place_limit_order" => vec![108, 176, 33, 186, 146, 229, 1, 197],
        "create_escrow_request" => vec![116, 164, 236, 204, 187, 132, 195, 219],
        "deposit" => vec![242, 35, 198, 137, 82, 225, 242, 182],
        "withdraw" => vec![183, 18, 70, 156, 148, 109, 161, 34],
        _ => unreachable!("{name}"),
    }
}

#[test]
fn only_trading_instructions_of_phoenix_run_inside_a_trade() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let asset = legs(&env, &take)[1].asset;
    let account = env.phoenix_account(&backer.pubkey(), &asset);
    let deposit = collateral_ix(&mut env, &backer, &take);
    let order = env.place_market_order_ix(&backer.pubkey(), &account, 4 * USDC as i64);
    let phoenix_ix = |name: &str| Instruction {
        program_id: PHOENIX,
        accounts: vec![
            AccountMeta::new_readonly(backer.pubkey(), true),
            AccountMeta::new(account, false),
        ],
        data: ix_prefix(name),
    };
    // A withdrawal could take the collateral straight back out after it counted as spent.
    assert_error(
        back_with_perp(
            &mut env,
            &backer,
            &take,
            account,
            vec![deposit.clone(), order.clone(), phoenix_ix("withdraw_funds")],
        ),
        "TradeInstructionNotAllowed",
    );
    // The deposit itself is allowed.
    back_with_perp(
        &mut env,
        &backer,
        &take,
        account,
        vec![deposit, phoenix_ix("deposit_funds"), order],
    )
    .unwrap();
}

#[test]
fn phoenix_and_ember_instruction_filters() {
    use thesis::proof::{allowed_instruction, EMBER_PROGRAM_ID, PHOENIX_PROGRAM_ID};
    let d = ix_prefix;
    for ok in [
        "deposit_funds",
        "place_market_order",
        "register_trader",
        "sync_parent_to_child",
    ] {
        assert!(
            allowed_instruction(PHOENIX_PROGRAM_ID.as_ref(), &d(ok)),
            "{ok}"
        );
    }
    for no in [
        "withdraw_funds",
        "transfer_collateral",
        "transfer_collateral_child_to_parent",
        "place_limit_order",
        "create_escrow_request",
    ] {
        assert!(
            !allowed_instruction(PHOENIX_PROGRAM_ID.as_ref(), &d(no)),
            "{no}"
        );
    }
    assert!(!allowed_instruction(PHOENIX_PROGRAM_ID.as_ref(), &[]));
    assert!(allowed_instruction(
        EMBER_PROGRAM_ID.as_ref(),
        &d("deposit")
    ));
    assert!(!allowed_instruction(
        EMBER_PROGRAM_ID.as_ref(),
        &d("withdraw")
    ));
}

// 1. A receipt with no swaps

#[test]
fn receipt_with_no_swaps_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let spot = env.holding(&backer.pubkey(), &legs(&env, &take)[0].asset);
    let ixs = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[spot],
        ),
    ];
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");
}

#[test]
fn receipt_without_begin_trade_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let ix = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[],
    );
    assert_error(env.send(&[ix], &[&backer.key]), "AccountNotInitialized");
}

#[test]
fn spending_one_unit_less_than_the_stake_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC - 1, Side::Back);
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &position,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps);
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &trade.outputs,
    ));
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");
}

// 2. Spending the USDC somewhere else

#[test]
fn plain_transfer_inside_the_trade_is_refused() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let friend = env.user(0);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let spot = env.holding(&backer.pubkey(), &legs(&env, &take)[0].asset);
    let (_, pool_out) = env.market(&legs(&env, &take)[0].asset);
    let ixs = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        // A dust swap so the output grows, and the rest of the stake to a friend.
        env.swap_ix(&backer.pubkey(), &backer.usdc, 1, &pool_out, &spot, 1),
        transfer_ix(&backer.usdc, &friend.usdc, &backer.pubkey(), 10 * USDC),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[spot],
        ),
    ];
    assert_error(env.send(&ixs, &[&backer.key]), "TradeProgramNotAllowed");
}

#[test]
fn plain_transfer_before_the_trade_does_not_count() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let friend = env.user(0);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let spot = env.holding(&backer.pubkey(), &legs(&env, &take)[0].asset);
    let (_, pool_out) = env.market(&legs(&env, &take)[0].asset);
    let ixs = [
        transfer_ix(&backer.usdc, &friend.usdc, &backer.pubkey(), 10 * USDC),
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        env.swap_ix(&backer.pubkey(), &backer.usdc, 1, &pool_out, &spot, 1),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[spot],
        ),
    ];
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");
}

// 3. A swap whose output goes to another wallet

#[test]
fn swap_output_to_another_wallet_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let friend = env.user(0);
    let asset = legs(&env, &take)[0].asset;
    let position = position_pda(&take, &backer.pubkey(), 1);
    let spot = env.holding(&backer.pubkey(), &asset);
    let friends = env.holding(&friend.pubkey(), &asset);
    let (_, pool_out) = env.market(&asset);
    let perp_swap = env
        .trade(&backer, &legs(&env, &take), 0b10, 4 * USDC, Side::Back)
        .swaps;

    // Naming the backer's own account: it didn't grow.
    let mut ixs = vec![
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        env.swap_ix(
            &backer.pubkey(),
            &backer.usdc,
            6 * USDC,
            &pool_out,
            &friends,
            6 * USDC,
        ),
    ];
    ixs.extend(perp_swap.clone());
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[spot],
    ));
    assert_error(env.send(&ixs, &[&backer.key]), "OutputNotBought");

    // Naming the friend's account: it isn't the backer's.
    let mut ixs = vec![
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[friends]),
        env.swap_ix(
            &backer.pubkey(),
            &backer.usdc,
            6 * USDC,
            &pool_out,
            &friends,
            6 * USDC,
        ),
    ];
    ixs.extend(perp_swap);
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[friends],
    ));
    assert_error(env.send(&ixs, &[&backer.key]), "InvalidOutputAccount");
}

#[test]
fn a_usdc_account_cannot_be_an_output() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let second_usdc = env.usdc_account(&backer.pubkey());
    let position = position_pda(&take, &backer.pubkey(), 1);
    let ixs = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[second_usdc]),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[second_usdc],
        ),
    ];
    assert_error(env.send(&ixs, &[&backer.key]), "InvalidOutputAccount");
}

#[test]
fn one_account_cannot_stand_in_for_two_legs() {
    let mut env = Env::new();
    let author = env.user(1_000 * USDC);
    let basket = vec![spot_leg(5_000), spot_leg(5_000)];
    let take_args = env.take_args(1, basket.clone(), 10 * USDC);
    let take = env.create_take(&author, take_args);
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let spot = env.holding(&backer.pubkey(), &basket[0].asset);
    let ix = env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b11, &[spot, spot]);
    let receipt = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[spot, spot],
    );
    assert_error(env.send(&[ix, receipt], &[&backer.key]), "OutputMismatch");
}

#[test]
fn every_bought_leg_needs_its_output() {
    let mut env = Env::new();
    let author = env.user(1_000 * USDC);
    let basket = vec![spot_leg(5_000), yield_leg(5_000)];
    let take_args = env.take_args(1, basket.clone(), 10 * USDC);
    let take = env.create_take(&author, take_args);
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    // The whole stake into the spot leg, nothing into the yield leg it claims.
    let trade = env.trade(&backer, &basket, 0b01, 10 * USDC, Side::Back);
    let mut ixs =
        vec![env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b01, &trade.outputs)];
    ixs.extend(trade.swaps);
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &trade.outputs,
    ));
    assert_error(env.send(&ixs, &[&backer.key]), "OutputNotBought");
}

#[test]
fn tokens_moved_in_outside_the_trade_are_not_counted_as_received() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let asset = legs(&env, &take)[0].asset;
    let (mint, pool_out) = env.market(&asset);
    let spot = env.holding(&backer.pubkey(), &asset);
    // The backer's other wallet already holds the token.
    let alt = env.user(0);
    let alt_tokens = env.token_account(&mint, &alt.pubkey(), 1_000 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let tx = [
        transfer_ix(&alt_tokens, &spot, &alt.pubkey(), 1_000 * USDC),
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        env.swap_ix(
            &backer.pubkey(),
            &backer.usdc,
            6 * USDC,
            &pool_out,
            &spot,
            3,
        ),
        env.trade_step_ix(&backer, &position, false, 0b1, &[spot]),
    ];
    env.send(&tx, &[&backer.key, &alt.key]).unwrap();
    // Only the swap's 3 units count: the receipt's TradeProved event reports this, and the
    // settler values the leg on it.
    let ticket: TradeTicket = env.fetch(&ticket_pda(&backer.pubkey(), &position));
    assert_eq!(ticket.received[0], 3);
    assert_eq!(env.balance(&spot), 1_000 * USDC + 3);
}

#[test]
fn the_receipt_emits_what_the_proof_measured() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let ixs = env.open_position_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
    );
    let meta = env.send(&ixs, &[&backer.key]).unwrap();
    // Events are self-CPIs (`emit_cpi!`): an inner Thesis instruction whose data is Anchor's
    // event tag, then the event's discriminator and borsh, so the validator's log limit can't drop it.
    let disc = <thesis::events::TradeProved as anchor_lang::Discriminator>::DISCRIMINATOR;
    let encoded: Vec<u8> = {
        use anchor_lang::AnchorSerialize;
        let spot = env.holding(&backer.pubkey(), &legs(&env, &take)[0].asset);
        let perp = env.phoenix_account(&backer.pubkey(), &legs(&env, &take)[1].asset);
        let mut v = anchor_lang::event::EVENT_IX_TAG_LE.to_vec();
        v.extend_from_slice(disc);
        // The spot leg's tokens, and the perp leg's position in base lots (the mock opens one lot
        // per USDC base unit of collateral).
        thesis::events::TradeProved {
            position: position_pda(&take, &backer.pubkey(), 1),
            owner: backer.pubkey(),
            spent: 10 * USDC,
            outputs_mask: 0b11,
            outputs: vec![spot, perp],
            received: vec![6 * USDC, 4 * USDC],
        }
        .serialize(&mut v)
        .unwrap();
        v
    };
    let inner: Vec<_> = meta
        .inner_instructions
        .iter()
        .flatten()
        .map(|ix| &ix.instruction.data)
        .collect();
    assert!(inner.contains(&&encoded), "inner instructions: {inner:#?}");
    // Nothing is left in the logs for the limit to cut.
    assert!(
        !meta.logs.iter().any(|l| l.starts_with("Program data: ")),
        "logs: {:#?}",
        meta.logs
    );
}

#[test]
fn recovering_a_nested_token_account_cannot_count_as_bought() {
    // Security review H-2: the owner parks NVDAx in a nested account (an associated account owned
    // by one of their associated accounts), then recovers it into their NVDAx account inside the
    // trade, while the stake goes into an allowed spend they keep.
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let asset = legs(&env, &take)[0].asset;
    let (nvdax, _) = env.market(&asset);
    let ata = |owner: &Pubkey, mint: &Pubkey| {
        get_associated_token_address_with_program_id(owner, mint, &token_program())
    };
    let other_mint = env.market(&Pubkey::new_unique()).0;
    let owner_ata = ata(&backer.pubkey(), &other_mint);
    let nested = ata(&owner_ata, &nvdax);
    let output = ata(&backer.pubkey(), &nvdax);
    env.token_account_at(owner_ata, &other_mint, &backer.pubkey(), 0);
    env.token_account_at(nested, &nvdax, &owner_ata, 1_000 * USDC);
    env.token_account_at(output, &nvdax, &backer.pubkey(), 0);
    let recover = Instruction {
        program_id: anchor_spl::associated_token::ID,
        accounts: vec![
            AccountMeta::new(nested, false),
            AccountMeta::new_readonly(nvdax, false),
            AccountMeta::new(output, false),
            AccountMeta::new_readonly(owner_ata, false),
            AccountMeta::new_readonly(other_mint, false),
            AccountMeta::new(backer.pubkey(), true),
            AccountMeta::new_readonly(token_program(), false),
        ],
        data: vec![2], // RecoverNested
    };
    // The stake "spent" into the venue's pool with nothing back, standing in for a deposit kept.
    let (_, pool_out) = env.market(&asset);
    let sink = env.usdc_account(&pool_authority());
    let spend = env.swap_ix(
        &backer.pubkey(),
        &backer.usdc,
        10 * USDC,
        &pool_out,
        &sink,
        0,
    );
    let position = position_pda(&take, &backer.pubkey(), 1);
    let ixs = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[output]),
        spend,
        recover.clone(),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[output],
        ),
    ];
    assert_error(env.send(&ixs, &[&backer.key]), "TradeInstructionNotAllowed");

    // Outside the trade, the recovery itself works: it's the bracket that refuses it.
    env.send(&[recover], &[&backer.key]).unwrap();
    assert_eq!(env.balance(&output), 1_000 * USDC);
}

#[test]
fn associated_token_creates_stay_allowed() {
    use thesis::proof::allowed_instruction;
    let ata = anchor_spl::associated_token::ID;
    assert!(allowed_instruction(ata.as_ref(), &[]));
    assert!(allowed_instruction(ata.as_ref(), &[0]));
    assert!(allowed_instruction(ata.as_ref(), &[1]));
    assert!(!allowed_instruction(ata.as_ref(), &[2]));
    assert!(!allowed_instruction(ata.as_ref(), &[3]));
    // Other programs aren't filtered by instruction.
    assert!(allowed_instruction(MOCK_VENUE.as_ref(), &[2]));
}

// 5. Trades split across transactions

#[test]
fn usdc_moved_between_split_transactions_does_not_count() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let friend = env.user(0);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let asset = legs(&env, &take)[0].asset;
    let spot = env.holding(&backer.pubkey(), &asset);
    let (_, pool_out) = env.market(&asset);

    let tx1 = [
        env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0b1, &[spot]),
        env.swap_ix(&backer.pubkey(), &backer.usdc, 1, &pool_out, &spot, 1),
        env.trade_step_ix(&backer, &position, false, 0b1, &[spot]),
    ];
    env.send(&tx1, &[&backer.key]).unwrap();
    // The "rest of the trade" is a transfer to a friend, in its own transaction.
    env.send(
        &[transfer_ix(
            &backer.usdc,
            &friend.usdc,
            &backer.pubkey(),
            10 * USDC,
        )],
        &[&backer.key],
    )
    .unwrap();
    let perp = env
        .trade(&backer, &legs(&env, &take), 0b10, 1, Side::Back)
        .swaps;
    let mut tx3 = vec![env.trade_step_ix(&backer, &position, true, 0, &[])];
    tx3.extend(perp);
    tx3.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[],
    ));
    assert_error(env.send(&tx3, &[&backer.key]), "StakeNotSpent");
}

#[test]
fn a_transaction_without_its_own_bracket_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);

    // The first transaction closes its bracket.
    let tx1 = [
        env.begin_trade_ix(
            &backer,
            &backer.pubkey(),
            &position,
            trade.outputs_mask,
            &trade.outputs,
        ),
        trade.swaps[0].clone(),
        env.trade_step_ix(
            &backer,
            &position,
            false,
            trade.outputs_mask,
            &trade.outputs,
        ),
    ];
    env.send(&tx1, &[&backer.key]).unwrap();
    // The last one doesn't open one: the receipt finds no bracket of this transaction.
    let tx2 = [
        trade.swaps[1].clone(),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[],
        ),
    ];
    assert_error(env.send(&tx2, &[&backer.key]), "NoOpenBracket");

    // A step that opens but whose transaction never closes it is refused up front.
    let tx2 = [
        env.trade_step_ix(&backer, &position, true, 0, &[]),
        trade.swaps[1].clone(),
    ];
    assert_error(env.send(&tx2, &[&backer.key]), "BracketNotClosed");
}

// Stale, foreign and abandoned tickets

#[test]
fn a_ticket_left_open_is_refused() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &position,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps);
    assert_error(env.send(&ixs, &[&backer.key]), "BracketNotClosed");
}

#[test]
fn foreign_ticket_is_refused() {
    let (mut env, _author, take) = setup();
    let alice = env.user(100 * USDC);
    let mallory = env.user(100 * USDC);
    let alice_position = position_pda(&take, &alice.pubkey(), 1);
    let trade = env.trade(&alice, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);
    // Alice's real trade, closed by a step so her ticket stays.
    let mut tx = vec![env.begin_trade_ix(
        &alice,
        &alice.pubkey(),
        &alice_position,
        trade.outputs_mask,
        &trade.outputs,
    )];
    tx.extend(trade.swaps);
    tx.push(env.trade_step_ix(
        &alice,
        &alice_position,
        false,
        trade.outputs_mask,
        &trade.outputs,
    ));
    env.send(&tx, &[&alice.key]).unwrap();

    // Mallory's receipt pointing at Alice's ticket.
    let mut receipt = env.receipt_ix(
        Side::Back,
        &mallory,
        &mallory.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[],
    );
    receipt.accounts[12].pubkey = ticket_pda(&alice.pubkey(), &alice_position);
    assert_error(env.send(&[receipt], &[&mallory.key]), "TicketMismatch");

    // Mallory can't drive Alice's ticket with trade_step either.
    let mut step = env.trade_step_ix(&mallory, &alice_position, true, 0, &[]);
    step.accounts[2].pubkey = ticket_pda(&alice.pubkey(), &alice_position);
    assert_error(env.send(&[step], &[&mallory.key]), "TicketMismatch");
}

#[test]
fn a_ticket_is_for_one_position_and_payer() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let p1 = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);

    // A ticket for position 1 can't open position 2.
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &p1,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps.clone());
    let mut receipt = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(2, 10 * USDC, 0b11),
        &trade.outputs,
    );
    receipt.accounts[12].pubkey = ticket_pda(&backer.pubkey(), &p1);
    ixs.push(receipt);
    assert_error(env.send(&ixs, &[&backer.key]), "TicketMismatch");

    // The app paid the ticket's rent, so the receipt's payer must be the app too.
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &app_payer.pubkey(),
        &p1,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps);
    ixs.push(env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &trade.outputs,
    ));
    assert_error(env.send(&ixs, &[&app_payer, &backer.key]), "TicketMismatch");
}

#[test]
fn an_abandoned_ticket_restarts_or_cancels() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let position = position_pda(&take, &backer.pubkey(), 1);
    let ticket = ticket_pda(&backer.pubkey(), &position);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);

    // The first transaction of a split trade lands; the second never does.
    let tx1 = [
        env.begin_trade_ix(
            &backer,
            &app_payer.pubkey(),
            &position,
            trade.outputs_mask,
            &trade.outputs,
        ),
        trade.swaps[0].clone(),
        env.trade_step_ix(
            &backer,
            &position,
            false,
            trade.outputs_mask,
            &trade.outputs,
        ),
    ];
    env.send(&tx1, &[&app_payer, &backer.key]).unwrap();
    assert!(env.fetch::<TradeTicket>(&ticket).spent > 0);

    // A retry starts over: what the abandoned attempt spent doesn't carry over.
    let retry = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);
    let tx = [
        env.begin_trade_ix(&backer, &app_payer.pubkey(), &position, 0, &[]),
        env.receipt_ix(
            Side::Back,
            &backer,
            &app_payer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &[],
        ),
    ];
    assert_error(env.send(&tx, &[&app_payer, &backer.key]), "StakeNotSpent");
    // Restarting needs the same payer (who gets the rent back).
    let ix = env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0, &[]);
    let close = env.trade_step_ix(&backer, &position, false, 0, &[]);
    assert_error(env.send(&[ix, close], &[&backer.key]), "TicketMismatch");
    let mut ok = vec![env.begin_trade_ix(
        &backer,
        &app_payer.pubkey(),
        &position,
        retry.outputs_mask,
        &retry.outputs,
    )];
    ok.extend(retry.swaps);
    ok.push(env.trade_step_ix(
        &backer,
        &position,
        false,
        retry.outputs_mask,
        &retry.outputs,
    ));
    env.send(&ok, &[&app_payer, &backer.key]).unwrap();

    // Or the owner gives up: the ticket closes and its rent goes back to the app.
    let rent = env.svm.get_account(&ticket).unwrap().lamports;
    let before = env.svm.get_balance(&app_payer.pubkey()).unwrap();
    let stranger = env.user(0);
    let ix = env.cancel_trade_ix(&stranger.pubkey(), &position, &app_payer.pubkey());
    let mut wrong = ix.clone();
    wrong.accounts[1].pubkey = ticket;
    assert!(env.send(&[wrong], &[&stranger.key]).is_err());
    let ix = env.cancel_trade_ix(&backer.pubkey(), &position, &app_payer.pubkey());
    env.send(&[ix], &[&backer.key]).unwrap();
    assert!(!env.exists(&ticket));
    assert_eq!(
        env.svm.get_balance(&app_payer.pubkey()).unwrap(),
        before + rent
    );
}

// Instruction-order tricks

#[test]
fn receipt_before_the_swaps_fails() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);
    let mut ixs = vec![
        env.begin_trade_ix(
            &backer,
            &backer.pubkey(),
            &position,
            trade.outputs_mask,
            &trade.outputs,
        ),
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(1, 10 * USDC, 0b11),
            &trade.outputs,
        ),
    ];
    ixs.extend(trade.swaps);
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");
}

#[test]
fn two_receipts_cannot_share_one_trade() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let p1 = position_pda(&take, &backer.pubkey(), 1);
    let p2 = position_pda(&take, &backer.pubkey(), 2);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);
    let receipt = |env: &Env, id| {
        env.receipt_ix(
            Side::Back,
            &backer,
            &backer.pubkey(),
            &take,
            args(id, 10 * USDC, 0b11),
            &trade.outputs,
        )
    };

    // Both tickets open before the one set of swaps.
    let mut ixs = vec![
        env.begin_trade_ix(
            &backer,
            &backer.pubkey(),
            &p1,
            trade.outputs_mask,
            &trade.outputs,
        ),
        env.begin_trade_ix(
            &backer,
            &backer.pubkey(),
            &p2,
            trade.outputs_mask,
            &trade.outputs,
        ),
    ];
    ixs.extend(trade.swaps.clone());
    ixs.push(receipt(&env, 1));
    ixs.push(receipt(&env, 2));
    assert_error(env.send(&ixs, &[&backer.key]), "BracketNotClosed");

    // The second ticket opens after the first receipt: it saw nothing traded.
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &p1,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps.clone());
    ixs.push(receipt(&env, 1));
    ixs.push(env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &p2,
        trade.outputs_mask,
        &trade.outputs,
    ));
    ixs.push(receipt(&env, 2));
    assert_error(env.send(&ixs, &[&backer.key]), "StakeNotSpent");

    // A second receipt with no ticket of its own.
    let mut ixs = vec![env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &p1,
        trade.outputs_mask,
        &trade.outputs,
    )];
    ixs.extend(trade.swaps);
    ixs.push(receipt(&env, 1));
    ixs.push(receipt(&env, 2));
    assert_error(env.send(&ixs, &[&backer.key]), "AccountNotInitialized");
}

#[test]
fn bracket_instructions_refuse_to_run_through_cpi() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let trade = env.trade(&backer, &legs(&env, &take), 0b11, 10 * USDC, Side::Back);

    let begin = env.begin_trade_ix(
        &backer,
        &backer.pubkey(),
        &position,
        trade.outputs_mask,
        &trade.outputs,
    );
    let wrapped = env.venue_call_ix(&begin);
    assert_error(env.send(&[wrapped], &[&backer.key]), "NotTopLevel");

    // A receipt hidden inside an allowed program's CPI isn't a closing instruction the
    // transaction shows, so the bracket never closes.
    let receipt = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &trade.outputs,
    );
    let mut ixs = vec![begin];
    ixs.extend(trade.swaps);
    ixs.push(env.venue_call_ix(&receipt));
    assert_error(env.send(&ixs, &[&backer.key]), "BracketNotClosed");
}

#[test]
fn a_fake_instructions_sysvar_is_refused() {
    let (mut env, _author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let mut begin = env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0, &[]);
    begin.accounts[6].pubkey = Pubkey::new_unique();
    let receipt = env.receipt_ix(
        Side::Fade,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, 10 * USDC, 0b11),
        &[],
    );
    assert_error(
        env.send(&[begin, receipt], &[&backer.key]),
        "ConstraintAddress",
    );
}

// The allowlist

#[test]
fn trade_programs_are_validated() {
    let mut env = Env::new();
    for bad in [
        vec![token_program()],
        vec![TOKEN_2022],
        vec![system_program::ID],
        vec![thesis::id()],
        vec![MOCK_VENUE, MOCK_VENUE],
        (0..9).map(|_| Pubkey::new_unique()).collect(),
    ] {
        assert_error(env.set_trade_programs(bad), "InvalidTradePrograms");
    }
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.trade_programs, default_trade_programs());

    // Taking the venue off the list stops its trades.
    env.set_trade_programs(vec![COMPUTE_BUDGET]).unwrap();
    let author = env.user(100 * USDC);
    let take_args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let ixs = env.create_take_ix(&author, &author.pubkey(), take_args);
    assert_error(env.send(&ixs, &[&author.key]), "TradeProgramNotAllowed");
}

#[test]
fn init_config_validates_trade_programs() {
    let mut env = Env::bare();
    let admin = env.admin.insecure_clone();
    let mut ix = env.init_config_ix(default_params());
    // Re-encode the instruction with Token in the list.
    let data = anchor_lang::InstructionData::data(&thesis::instruction::InitConfig {
        settler: env.settler.pubkey(),
        allowlist_admin: env.allowlist_admin.pubkey(),
        params: default_params(),
        trade_programs: vec![MOCK_VENUE, token_program()],
    });
    ix.data = data;
    assert_error(env.send(&[ix], &[&admin]), "InvalidTradePrograms");
}

#[test]
fn ticket_account_indexes_match_the_instructions() {
    // proof.rs finds each bracket instruction's ticket by its index in the accounts.
    use thesis::proof::*;
    let (mut env, author, take) = setup();
    let backer = env.user(100 * USDC);
    let position = position_pda(&take, &backer.pubkey(), 1);
    let ticket = ticket_pda(&backer.pubkey(), &position);
    let begin = env.begin_trade_ix(&backer, &backer.pubkey(), &position, 0, &[]);
    assert_eq!(begin.accounts[BEGIN_TRADE_TICKET_INDEX].pubkey, ticket);
    let step = env.trade_step_ix(&backer, &position, true, 0, &[]);
    assert_eq!(step.accounts[TRADE_STEP_TICKET_INDEX].pubkey, ticket);
    let back = env.receipt_ix(
        Side::Back,
        &backer,
        &backer.pubkey(),
        &take,
        args(1, USDC, 1),
        &[],
    );
    assert_eq!(back.accounts[OPEN_POSITION_TICKET_INDEX].pubkey, ticket);
    let take_args = env.take_args(2, vec![spot_leg(10_000)], 10 * USDC);
    let create = env.create_take_receipt_ix(&author, &author.pubkey(), take_args, &[]);
    let author_position = position_pda(&take_pda(&author.pubkey(), 2), &author.pubkey(), 0);
    assert_eq!(
        create.accounts[CREATE_TAKE_TICKET_INDEX].pubkey,
        ticket_pda(&author.pubkey(), &author_position)
    );
}
