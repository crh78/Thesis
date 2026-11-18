//! Step 3: config, takes, backs and fades, the fee split, and claims.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    solana_signer::Signer,
    thesis::{
        state::*, OpenPositionArgs, UpdateAllowlistArgs, UpdateConfigArgs, AUTHOR_POSITION_ID,
        MAX_FEE_BPS,
    },
};

fn args(id: u64, stake: u64, legs_mask: u16) -> OpenPositionArgs {
    OpenPositionArgs {
        id,
        stake,
        legs_mask,
    }
}

/// An author and a two-leg take (spot + yield, 50/50) with a $10 buy-in.
fn env_with_take() -> (Env, User, Pubkey) {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take_args = env.take_args(1, vec![spot_leg(5_000), yield_leg(5_000)], 10 * USDC);
    let take = env.create_take(&author, take_args);
    (env, author, take)
}

// Config

#[test]
fn init_config_sets_values_and_vaults() {
    let env = Env::new();
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.allowlist_admin, env.allowlist_admin.pubkey());
    assert_eq!(
        (config.pending_admin, config.pending_allowlist_admin),
        (None, None)
    );
    assert_eq!(config.settler, env.settler.pubkey());
    assert_eq!(config.usdc_mint, env.mint);
    assert_eq!(config.fee_vault, fee_vault_pda());
    assert_eq!(config.creator_vault, creator_vault_pda());
    assert_eq!(config.params, default_params());
    assert_eq!(env.balance(&fee_vault_pda()), 0);
    assert_eq!(env.balance(&creator_vault_pda()), 0);
}

#[test]
fn init_config_runs_once_and_rejects_bad_values() {
    let mut env = Env::bare();
    let admin = env.admin.insecure_clone();

    let mut bad = default_params();
    bad.creator_fee_bps = 11; // more than the whole fee
    let ix = env.init_config_ix(bad);
    assert_error(env.send(&[ix], &[&admin]), "InvalidConfig");

    // The fee can't go above 1% (MAX_FEE_BPS), at init or later.
    let mut bad = default_params();
    bad.fee_bps = MAX_FEE_BPS + 1;
    let ix = env.init_config_ix(bad);
    assert_error(env.send(&[ix], &[&admin]), "InvalidConfig");

    let mut bad = default_params();
    bad.max_legs = 11;
    let ix = env.init_config_ix(bad);
    assert_error(env.send(&[ix], &[&admin]), "InvalidConfig");

    let ix = env.init_config_ix(default_params());
    env.send(&[ix], &[&admin]).unwrap();
    let ix = env.init_config_ix(default_params());
    assert!(env.send(&[ix], &[&admin]).is_err());
}

#[test]
fn only_the_upgrade_authority_initializes_the_config() {
    // Security review H-1: before this, anyone could call init_config first after a deploy.
    let mut env = Env::bare();
    let stranger = solana_keypair::Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let mut ix = env.init_config_ix(default_params());
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_error(env.send(&[ix], &[&stranger]), "NotUpgradeAuthority");

    // A program made immutable (no upgrade authority) can't be initialized at all.
    let admin = env.admin.insecure_clone();
    env.set_upgrade_authority(None);
    let ix = env.init_config_ix(default_params());
    assert_error(env.send(&[ix], &[&admin]), "NotUpgradeAuthority");

    // Some other account passed as the ProgramData is refused by its address.
    let admin_key = admin.pubkey();
    env.set_upgrade_authority(Some(&admin_key));
    let mut ix = env.init_config_ix(default_params());
    let last = ix.accounts.len() - 1;
    ix.accounts[last].pubkey = Pubkey::new_unique();
    assert!(env.send(&[ix], &[&admin]).is_err());

    let ix = env.init_config_ix(default_params());
    env.send(&[ix], &[&admin]).unwrap();
}

#[test]
fn only_admin_updates_config() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.user(0);
    let mut params = default_params();
    params.paused = true;
    let update = |new_admin| UpdateConfigArgs {
        params,
        new_admin,
        new_settler: None,
        new_badge_uri_base: None,
    };

    let ix = env.update_config_ix(&stranger.pubkey(), update(None));
    assert!(env.send(&[ix], &[&stranger.key]).is_err());

    // Not even the admin can set a fee above the ceiling (security review M-1).
    let mut too_high = update(None);
    too_high.params.fee_bps = MAX_FEE_BPS + 1;
    let ix = env.update_config_ix(&admin.pubkey(), too_high);
    assert_error(env.send(&[ix], &[&admin]), "InvalidConfig");
    let mut at_ceiling = update(None);
    at_ceiling.params.fee_bps = MAX_FEE_BPS;
    let ix = env.update_config_ix(&admin.pubkey(), at_ceiling);
    env.send(&[ix], &[&admin]).unwrap();

    let ix = env.update_config_ix(&admin.pubkey(), update(None));
    env.send(&[ix], &[&admin]).unwrap();
    let config: Config = env.fetch(&config_pda());
    assert!(config.params.paused);
}

#[test]
fn admin_hand_over_takes_two_steps() {
    // Security review L-2: a mistyped key can't take the admin role.
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let next = env.user(0);
    let stranger = env.user(0);
    let propose = |new_admin| UpdateConfigArgs {
        params: default_params(),
        new_admin,
        new_settler: None,
        new_badge_uri_base: None,
    };

    let ix = env.update_config_ix(&admin.pubkey(), propose(Some(next.pubkey())));
    env.send(&[ix], &[&admin]).unwrap();
    let config: Config = env.fetch(&config_pda());
    assert_eq!(
        (config.admin, config.pending_admin),
        (admin.pubkey(), Some(next.pubkey()))
    );

    // Only the proposed key can accept; until then the old admin is still the admin.
    let ix = env.accept_admin_ix(&stranger.pubkey());
    assert_error(env.send(&[ix], &[&stranger.key]), "Unauthorized");
    let ix = env.update_config_ix(&next.pubkey(), propose(None));
    assert!(env.send(&[ix], &[&next.key]).is_err());

    let ix = env.accept_admin_ix(&next.pubkey());
    env.send(&[ix], &[&next.key]).unwrap();
    let config: Config = env.fetch(&config_pda());
    assert_eq!((config.admin, config.pending_admin), (next.pubkey(), None));
    let ix = env.update_config_ix(&admin.pubkey(), propose(None));
    assert!(env.send(&[ix], &[&admin]).is_err(), "the old admin is out");
    // A second accept does nothing: there's no proposal left.
    let ix = env.accept_admin_ix(&next.pubkey());
    assert_error(env.send(&[ix], &[&next.key]), "Unauthorized");
}

#[test]
fn only_the_allowlist_admin_changes_the_trade_programs() {
    // Security review M-2: the fee admin can't change the allowlist.
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let list = |programs| UpdateAllowlistArgs {
        new_trade_programs: Some(programs),
        new_allowlist_admin: None,
    };
    let ix = env.update_allowlist_ix(&admin.pubkey(), list(vec![COMPUTE_BUDGET]));
    assert_error(env.send(&[ix], &[&admin]), "Unauthorized");
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.trade_programs, default_trade_programs());

    env.set_trade_programs(vec![COMPUTE_BUDGET]).unwrap();
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.trade_programs, vec![COMPUTE_BUDGET]);

    // Its own hand-over is two-step too.
    let allowlist = env.allowlist_admin.insecure_clone();
    let next = env.user(0);
    let ix = env.update_allowlist_ix(
        &allowlist.pubkey(),
        UpdateAllowlistArgs {
            new_trade_programs: None,
            new_allowlist_admin: Some(next.pubkey()),
        },
    );
    env.send(&[ix], &[&allowlist]).unwrap();
    let ix = env.accept_admin_ix(&next.pubkey());
    assert_error(env.send(&[ix], &[&next.key]), "Unauthorized");
    let ix = env.accept_allowlist_admin_ix(&next.pubkey());
    env.send(&[ix], &[&next.key]).unwrap();
    let config: Config = env.fetch(&config_pda());
    assert_eq!(
        (
            config.allowlist_admin,
            config.pending_allowlist_admin,
            config.admin
        ),
        (next.pubkey(), None, admin.pubkey())
    );
    let ix = env.update_allowlist_ix(&allowlist.pubkey(), list(default_trade_programs()));
    assert_error(env.send(&[ix], &[&allowlist]), "Unauthorized");
}

// Takes

#[test]
fn create_take_records_take_buy_in_profile_and_fee() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let take_args = env.take_args(1, vec![spot_leg(6_000), yield_leg(4_000)], 10 * USDC);
    let horizon_end = take_args.horizon_end;
    let ixs = env.create_take_ix(&author, &app_payer.pubkey(), take_args);
    env.send(&ixs, &[&app_payer, &author.key]).unwrap();

    // The stake goes into the author's own swaps (they hold the tokens); Thesis moves only the
    // fee: 0.10% of $10.
    assert_eq!(env.balance(&author.usdc), 100 * USDC - 10 * USDC - 10_000);
    assert_eq!(env.balance(&fee_vault_pda()), 10_000);
    assert_eq!(env.balance(&creator_vault_pda()), 0);

    let take_key = take_pda(&author.pubkey(), 1);
    let take: Take = env.fetch(&take_key);
    assert_eq!(take.author, author.pubkey());
    assert_eq!(take.legs.len(), 2);
    assert_eq!(take.horizon_end, horizon_end);
    assert_eq!(take.created_at, NOW);
    assert_eq!((take.backers, take.faders, take.open_positions), (1, 0, 1));
    assert_eq!(take.total_backed, 10 * USDC);
    assert_eq!(take.status, TakeStatus::Open);

    let position: Position = env.fetch(&position_pda(
        &take_key,
        &author.pubkey(),
        AUTHOR_POSITION_ID,
    ));
    assert_eq!(position.side, Side::Back);
    assert_eq!(position.legs_mask, 0b11);
    assert_eq!(position.rent_payer, app_payer.pubkey());
    assert!(position.scored);

    let profile: Profile = env.fetch(&profile_pda(&author.pubkey()));
    assert_eq!(profile.owner, author.pubkey());
    assert_eq!((profile.takes_created, profile.positions_opened), (1, 1));
}

#[test]
fn create_take_validates_basket_horizon_and_stake() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let base = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);

    let mut cases: Vec<(&str, thesis::CreateTakeArgs)> = Vec::new();
    let mut a = base.clone();
    a.legs = vec![];
    cases.push(("NoLegs", a));
    let mut a = base.clone();
    a.legs = (0..11).map(|_| spot_leg(909)).collect();
    cases.push(("TooManyLegs", a));
    let mut a = base.clone();
    a.legs = vec![spot_leg(5_000), spot_leg(4_000)];
    cases.push(("WeightsMustSumTo100", a));
    let mut a = base.clone();
    let leg = spot_leg(5_000);
    a.legs = vec![leg, leg];
    cases.push(("DuplicateLeg", a));
    let mut a = base.clone();
    a.legs[0].leverage = 2; // leverage only on perps
    cases.push(("InvalidLeverage", a));
    let mut a = base.clone();
    let mut y = yield_leg(10_000);
    y.fade_via = FadeVia::PhoenixShort;
    a.legs = vec![y];
    cases.push(("InvalidLeg", a));
    let mut a = base.clone();
    a.horizon_end = NOW + HOUR - 1;
    cases.push(("HorizonOutOfRange", a));
    let mut a = base.clone();
    a.horizon_end = NOW + (5 * 365 + 2) * DAY;
    cases.push(("HorizonOutOfRange", a));
    let mut a = base.clone();
    a.stake = 10 * USDC - 1;
    cases.push(("StakeBelowMinimum", a));
    let mut a = base.clone();
    a.legs_mask = 0; // the buy-in must include a leg
    cases.push(("InvalidLegsMask", a));
    let mut a = base.clone();
    a.legs_mask = 0b10; // names a leg the take doesn't have
    cases.push(("InvalidLegsMask", a));

    for (error, take_args) in cases {
        let ixs = env.create_take_ix(&author, &author.pubkey(), take_args);
        assert_error(env.send(&ixs, &[&author.key]), error);
    }

    // Exactly one hour is allowed.
    let mut a = base.clone();
    a.horizon_end = NOW + HOUR;
    env.create_take(&author, a);
}

#[test]
fn the_launch_config_takes_only_a_one_year_horizon() {
    // DEFAULT_CONFIG_PARAMS in packages/chain: 364 to 366 days, so every take auto-settles a
    // year after posting (the fork API passes posting + 365 days).
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let mut params = default_params();
    params.min_horizon_secs = 364 * DAY;
    params.max_horizon_secs = 366 * DAY;
    let ix = env.update_config_ix(
        &admin.pubkey(),
        UpdateConfigArgs {
            params,
            new_admin: None,
            new_settler: None,
            new_badge_uri_base: None,
        },
    );
    env.send(&[ix], &[&admin]).unwrap();

    let author = env.user(100 * USDC);
    for (id, horizon) in [(1, 30 * DAY), (2, 364 * DAY - 1), (3, 366 * DAY + 1)] {
        let mut a = env.take_args(id, vec![spot_leg(10_000)], 10 * USDC);
        a.horizon_end = NOW + horizon;
        let ixs = env.create_take_ix(&author, &author.pubkey(), a);
        assert_error(env.send(&ixs, &[&author.key]), "HorizonOutOfRange");
    }
    let mut a = env.take_args(4, vec![spot_leg(10_000)], 10 * USDC);
    a.horizon_end = NOW + 365 * DAY;
    let take = env.create_take(&author, a);
    assert_eq!(env.fetch::<Take>(&take).horizon_end, NOW + 365 * DAY);
}

#[test]
fn paused_blocks_new_takes_and_positions() {
    let (mut env, _author, take) = env_with_take();
    let admin = env.admin.insecure_clone();
    let mut params = default_params();
    params.paused = true;
    let ix = env.update_config_ix(
        &admin.pubkey(),
        UpdateConfigArgs {
            params,
            new_admin: None,
            new_settler: None,
            new_badge_uri_base: None,
        },
    );
    env.send(&[ix], &[&admin]).unwrap();

    let other = env.user(100 * USDC);
    let take_args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let ixs = env.create_take_ix(&other, &other.pubkey(), take_args);
    assert_error(env.send(&ixs, &[&other.key]), "Paused");
    assert_error(
        env.open_position(Side::Back, &other, &take, args(1, 10 * USDC, 0b1)),
        "Paused",
    );
}

// Backs and fades

#[test]
fn back_splits_fee_between_platform_and_creator() {
    let (mut env, _author, take) = env_with_take();
    let backer = env.user(100 * USDC);
    let fee_vault_before = env.balance(&fee_vault_pda());

    env.open_position(Side::Back, &backer, &take, args(7, 10 * USDC, 0b11))
        .unwrap();

    // $10 back: the stake into the backer's swaps, a 1 cent fee, half to the platform, half held
    // for the author.
    assert_eq!(env.balance(&backer.usdc), 100 * USDC - 10 * USDC - 10_000);
    assert_eq!(env.balance(&fee_vault_pda()) - fee_vault_before, 5_000);
    assert_eq!(env.balance(&creator_vault_pda()), 5_000);

    let t: Take = env.fetch(&take);
    assert_eq!((t.backers, t.open_positions), (2, 2));
    assert_eq!(t.total_backed, 20 * USDC);
    assert_eq!(t.creator_fees_unclaimed, 5_000);
    assert_eq!(t.platform_fees_from_backs, 5_000);

    let position: Position = env.fetch(&position_pda(&take, &backer.pubkey(), 7));
    assert_eq!(position.rent_payer, backer.pubkey());
    assert!(position.scored);
    let profile: Profile = env.fetch(&profile_pda(&backer.pubkey()));
    assert_eq!(profile.positions_opened, 1);
}

#[test]
fn positions_below_minimum_are_recorded_but_not_scored() {
    let (mut env, _author, take) = env_with_take();
    let backer = env.user(100 * USDC);
    env.open_position(Side::Back, &backer, &take, args(1, 5 * USDC, 0b1))
        .unwrap();
    let position: Position = env.fetch(&position_pda(&take, &backer.pubkey(), 1));
    assert!(!position.scored);
    assert_eq!(env.balance(&creator_vault_pda()), 2_500);
}

#[test]
fn fades_only_include_fadeable_legs_and_pay_the_creator_share() {
    let (mut env, _author, take) = env_with_take();
    let fader = env.user(100 * USDC);

    // Leg 1 is a yield leg, which can't be faded.
    assert_error(
        env.open_position(Side::Fade, &fader, &take, args(1, 10 * USDC, 0b11)),
        "LegNotFadeable",
    );
    // Leg 0 is a spot leg, faded through a Phoenix short the trade opens (security review L-3).
    env.open_position(Side::Fade, &fader, &take, args(1, 10 * USDC, 0b01))
        .unwrap();
    let asset = env.fetch::<Take>(&take).legs[0].asset;
    let short = env.phoenix_account(&fader.pubkey(), &asset);
    assert!(env.phoenix_position(&short) < 0);

    // A take with a prediction leg can be faded.
    let author = env.user(100 * USDC);
    let take_args = env.take_args(2, vec![prediction_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, take_args);
    let fee_vault_before = env.balance(&fee_vault_pda());
    let creator_before = env.balance(&creator_vault_pda());
    env.open_position(Side::Fade, &fader, &take, args(2, 10 * USDC, 0b1))
        .unwrap();

    // A $10 fade pays the 10 bps fee: 5 bps to the platform, 5 bps to the take's author.
    assert_eq!(env.balance(&fee_vault_pda()) - fee_vault_before, 5_000);
    assert_eq!(env.balance(&creator_vault_pda()) - creator_before, 5_000);
    let t: Take = env.fetch(&take);
    assert_eq!(t.creator_fees_unclaimed, 5_000);
    assert_eq!(
        (t.faders, t.total_faded, t.open_positions),
        (1, 10 * USDC, 2)
    );
}

#[test]
fn an_author_cannot_fade_their_own_take() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let take_args = env.take_args(1, vec![prediction_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, take_args);
    assert_error(
        env.open_position(Side::Fade, &author, &take, args(1, 10 * USDC, 0b1)),
        "AuthorCannotFade",
    );
    // Anyone else can.
    let fader = env.user(100 * USDC);
    env.open_position(Side::Fade, &fader, &take, args(1, 10 * USDC, 0b1))
        .unwrap();
}

#[test]
fn author_backing_again_pays_no_creator_share() {
    let (mut env, author, take) = env_with_take();
    env.open_position(Side::Back, &author, &take, args(1, 10 * USDC, 0b11))
        .unwrap();
    assert_eq!(env.balance(&creator_vault_pda()), 0);
    assert_eq!(env.balance(&fee_vault_pda()), 20_000);
}

#[test]
fn position_inputs_and_timing_are_checked() {
    let (mut env, _author, take) = env_with_take();
    let backer = env.user(100 * USDC);

    assert_error(
        env.open_position(Side::Back, &backer, &take, args(0, 10 * USDC, 0b1)),
        "InvalidPositionId",
    );
    assert_error(
        env.open_position(Side::Back, &backer, &take, args(1, 0, 0b1)),
        "ZeroStake",
    );
    assert_error(
        env.open_position(Side::Back, &backer, &take, args(1, 10 * USDC, 0)),
        "InvalidLegsMask",
    );
    assert_error(
        env.open_position(Side::Back, &backer, &take, args(1, 10 * USDC, 0b100)),
        "InvalidLegsMask",
    );

    env.set_time(NOW + 30 * DAY);
    assert_error(
        env.open_position(Side::Back, &backer, &take, args(1, 10 * USDC, 0b1)),
        "TakeClosed",
    );
}

#[test]
fn app_can_pay_rent_for_a_back() {
    let (mut env, _author, take) = env_with_take();
    let backer = env.user(100 * USDC);
    let app_payer = env.app_payer.insecure_clone();
    let backer_sol = env.svm.get_balance(&backer.pubkey()).unwrap();

    let ixs = env.open_position_ix(
        Side::Back,
        &backer,
        &app_payer.pubkey(),
        &take,
        args(3, 10 * USDC, 0b1),
    );
    env.send(&ixs, &[&app_payer, &backer.key]).unwrap();

    assert_eq!(env.svm.get_balance(&backer.pubkey()).unwrap(), backer_sol);
    let position: Position = env.fetch(&position_pda(&take, &backer.pubkey(), 3));
    assert_eq!(position.rent_payer, app_payer.pubkey());
}

// Claims and withdrawals

#[test]
fn author_claims_creator_fees_once() {
    let (mut env, author, take) = env_with_take();
    for (i, backer_funds) in [100 * USDC, 100 * USDC].into_iter().enumerate() {
        let backer = env.user(backer_funds);
        env.open_position(
            Side::Back,
            &backer,
            &take,
            args(i as u64 + 1, 10 * USDC, 0b1),
        )
        .unwrap();
    }
    let before = env.balance(&author.usdc);

    let stranger = env.user(0);
    let ix = env.claim_creator_fees_ix(&stranger, &take);
    assert!(env.send(&[ix], &[&stranger.key]).is_err());

    let ix = env.claim_creator_fees_ix(&author, &take);
    env.send(&[ix], &[&author.key]).unwrap();
    assert_eq!(env.balance(&author.usdc) - before, 10_000);
    assert_eq!(env.balance(&creator_vault_pda()), 0);
    let t: Take = env.fetch(&take);
    assert_eq!(t.creator_fees_unclaimed, 0);

    let ix = env.claim_creator_fees_ix(&author, &take);
    assert_error(env.send(&[ix], &[&author.key]), "NothingToClaim");
}

#[test]
fn admin_withdraws_platform_fees_but_not_creator_fees() {
    let (mut env, _author, take) = env_with_take();
    let backer = env.user(100 * USDC);
    env.open_position(Side::Back, &backer, &take, args(1, 10 * USDC, 0b1))
        .unwrap();
    // Platform: 10_000 (author buy-in) + 5_000 (back). Creator: 5_000.
    assert_eq!(env.balance(&fee_vault_pda()), 15_000);

    let admin = env.admin.insecure_clone();
    let treasury = env.usdc_account(&admin.pubkey());
    let stranger = env.user(0);

    let ix = env.withdraw_fees_ix(&stranger.pubkey(), &stranger.usdc, 15_000);
    assert!(env.send(&[ix], &[&stranger.key]).is_err());

    let ix = env.withdraw_fees_ix(&admin.pubkey(), &treasury, 15_001);
    assert_error(env.send(&[ix], &[&admin]), "InsufficientFees");

    let ix = env.withdraw_fees_ix(&admin.pubkey(), &treasury, 15_000);
    env.send(&[ix], &[&admin]).unwrap();
    assert_eq!(env.balance(&treasury), 15_000);
    assert_eq!(env.balance(&creator_vault_pda()), 5_000);
}
