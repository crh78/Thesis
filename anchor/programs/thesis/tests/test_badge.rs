//! Step 6: the badge catalog. One non-transferable Token-2022 badge per achievement per user.
// LiteSVM's failure type is large; fine in tests.
#![allow(clippy::result_large_err)]

mod common;

use {
    anchor_lang::{prelude::Pubkey, AccountSerialize},
    anchor_spl::{
        associated_token::spl_associated_token_account::instruction::create_associated_token_account,
        token_2022::spl_token_2022::{
            self,
            error::TokenError,
            extension::{
                metadata_pointer::MetadataPointer, non_transferable::NonTransferable,
                BaseStateWithExtensions, StateWithExtensions,
            },
            state::{Account as TokenAccount, Mint},
        },
        token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata,
    },
    common::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    thesis::{
        state::*, OpenPositionArgs, UpdateConfigArgs, AUTHOR_POSITION_ID, BADGE_SYMBOL,
        DEFAULT_BADGE_URI_BASE,
    },
};

const HORIZON: i64 = NOW + 30 * DAY;

fn badges(env: &Env, owner: &Pubkey) -> u32 {
    env.fetch::<Profile>(&profile_pda(owner)).badges
}

/// A fresh author with one posted take (so the FirstTake badge is earned).
fn author_with_take() -> (Env, User) {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    env.create_take(&author, args);
    (env, author)
}

/// Rewrites a profile's counters, standing in for many settled takes.
fn set_counters(env: &mut Env, owner: &Pubkey, f: impl FnOnce(&mut Profile)) {
    let address = profile_pda(owner);
    let mut profile: Profile = env.fetch(&address);
    f(&mut profile);
    let mut account = env.svm.get_account(&address).unwrap();
    let mut data = Vec::with_capacity(account.data.len());
    profile.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(address, account).unwrap();
}

/// Failure that isn't an Anchor error (no "Error Code:" log), matched on the transaction error.
fn assert_tx_error(result: TxResult, needle: &str) {
    let failed = result.expect_err(&format!("expected {needle}"));
    let err = format!("{:?}", failed.err);
    assert!(
        err.contains(needle),
        "expected {needle}, got {err}, logs: {:#?}",
        failed.meta.logs
    );
}

#[test]
fn first_take_badge_after_posting_a_take() {
    let (mut env, author) = author_with_take();
    let meta = mint_badge(&mut env, &author.pubkey(), BadgeKind::FirstTake).expect("mint_badge");
    println!(
        "mint_badge used {} compute units",
        meta.compute_units_consumed
    );

    let ata = env
        .svm
        .get_account(&badge_ata(&author.pubkey(), BadgeKind::FirstTake))
        .unwrap();
    assert_eq!(ata.owner, TOKEN_2022);
    let ata = StateWithExtensions::<TokenAccount>::unpack(&ata.data).unwrap();
    assert_eq!(ata.base.owner, author.pubkey());
    assert_eq!(ata.base.amount, 1);
    assert_eq!(badges(&env, &author.pubkey()), 1);
}

#[test]
fn supply_is_one_mint_authority_is_gone_and_metadata_reads_back() {
    let (mut env, author) = author_with_take();
    let owner = author.pubkey();
    mint_badge(&mut env, &owner, BadgeKind::FirstTake).expect("mint_badge");

    let mint_key = badge_mint(&owner, BadgeKind::FirstTake);
    let data = env.svm.get_account(&mint_key).unwrap().data;
    let mint = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    assert_eq!((mint.base.supply, mint.base.decimals), (1, 0));
    assert!(mint.base.mint_authority.is_none());
    assert!(mint.base.freeze_authority.is_none());
    assert!(mint.get_extension::<NonTransferable>().is_ok());

    let pointer = mint.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(pointer.metadata_address),
        Some(mint_key)
    );
    let metadata = mint.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(metadata.name, "Thesis: First take");
    assert_eq!(metadata.symbol, BADGE_SYMBOL);
    assert_eq!(
        metadata.uri,
        format!("{DEFAULT_BADGE_URI_BASE}first-take.json")
    );
    assert!(metadata.additional_metadata.is_empty());
}

fn uri_of(env: &Env, owner: &Pubkey, kind: BadgeKind) -> String {
    let data = env.svm.get_account(&badge_mint(owner, kind)).unwrap().data;
    let mint = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    mint.get_variable_len_extension::<TokenMetadata>()
        .unwrap()
        .uri
}

fn set_badge_base(env: &mut Env, signer: &Keypair, base: &str) -> TxResult {
    let ix = env.update_config_ix(
        &signer.pubkey(),
        UpdateConfigArgs {
            params: default_params(),
            new_admin: None,
            new_settler: None,
            new_badge_uri_base: Some(base.to_string()),
        },
    );
    env.send(&[ix], &[signer])
}

#[test]
fn the_admin_moves_badge_metadata_without_an_upgrade() {
    let (mut env, author) = author_with_take();
    let owner = author.pubkey();
    let admin = env.admin.insecure_clone();
    // Minted before the move: keeps its URI.
    mint_badge(&mut env, &owner, BadgeKind::FirstTake).expect("first take");

    let base = "https://example.supabase.co/storage/v1/object/public/badges/";
    // Only the admin.
    let stranger = env.user(0);
    assert!(set_badge_base(&mut env, &stranger.key, base).is_err());
    // Refused: not https, no trailing slash, spaces, too long, empty host.
    let long = format!("https://{}/", "a".repeat(120));
    for bad in [
        "http://x.co/badges/",
        "https://x.co/badges",
        "https://x.co/my badges/",
        &long,
        "https:///",
    ] {
        assert_error(set_badge_base(&mut env, &admin, bad), "InvalidBadgeUriBase");
    }
    set_badge_base(&mut env, &admin, base).expect("set the base");
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.badge_uri_base, base);

    set_counters(&mut env, &owner, |p| p.takes_over_50 = 1);
    mint_badge(&mut env, &owner, BadgeKind::FirstOver50).expect("+50%");
    assert_eq!(
        uri_of(&env, &owner, BadgeKind::FirstOver50),
        format!("{base}first-50.json")
    );
    assert_eq!(
        uri_of(&env, &owner, BadgeKind::FirstTake),
        format!("{DEFAULT_BADGE_URI_BASE}first-take.json")
    );
    // At the cap: 128 bytes is fine.
    let at_cap = format!("https://{}/", "a".repeat(128 - "https://".len() - 1));
    assert_eq!(at_cap.len(), 128);
    set_badge_base(&mut env, &admin, &at_cap).expect("128 bytes");
}

#[test]
fn badge_cannot_be_transferred() {
    let (mut env, author) = author_with_take();
    let owner = author.pubkey();
    mint_badge(&mut env, &owner, BadgeKind::FirstTake).expect("mint_badge");
    let mint_key = badge_mint(&owner, BadgeKind::FirstTake);

    let recipient = Pubkey::new_unique();
    let recipient_ata =
        get_associated_token_address_with_program_id(&recipient, &mint_key, &TOKEN_2022);
    let signer = author.key.insecure_clone();
    env.send(
        &[create_associated_token_account(
            &owner,
            &recipient,
            &mint_key,
            &TOKEN_2022,
        )],
        &[&signer],
    )
    .expect("recipient ATA");
    let transfer = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &badge_ata(&owner, BadgeKind::FirstTake),
        &mint_key,
        &recipient_ata,
        &owner,
        &[],
        1,
        0,
    )
    .unwrap();
    assert_tx_error(
        env.send(&[transfer], &[&signer]),
        &format!("Custom({})", TokenError::NonTransferable as u32),
    );
}

#[test]
fn each_badge_is_minted_once_per_user() {
    let (mut env, author) = author_with_take();
    let owner = author.pubkey();
    mint_badge(&mut env, &owner, BadgeKind::FirstTake).expect("first");
    assert_tx_error(
        mint_badge(&mut env, &owner, BadgeKind::FirstTake),
        "AccountAlreadyInitialized",
    );
    // A different badge is a different mint.
    set_counters(&mut env, &owner, |p| p.takes_over_50 = 1);
    mint_badge(&mut env, &owner, BadgeKind::FirstOver50).expect("another badge");
    assert_eq!(badges(&env, &owner), 2);
}

#[test]
fn badges_need_their_achievement() {
    let mut env = Env::new();
    let author = env.user(100 * USDC);
    let args = env.take_args(1, vec![spot_leg(10_000)], 10 * USDC);
    let take = env.create_take(&author, args);
    // A backer has a profile but never posted a take.
    let backer = env.user(100 * USDC);
    env.open_position(
        Side::Back,
        &backer,
        &take,
        OpenPositionArgs {
            id: 1,
            stake: 10 * USDC,
            legs_mask: 0b1,
        },
    )
    .unwrap();
    assert_error(
        mint_badge(&mut env, &backer.pubkey(), BadgeKind::FirstTake),
        "BadgeNotEarned",
    );
    // The backer can't borrow the author's profile to earn it.
    let mut ix = mint_badge_ix(
        &env,
        &backer.pubkey(),
        BadgeKind::FirstTake,
        badge_ata(&backer.pubkey(), BadgeKind::FirstTake),
    );
    ix.accounts[3].pubkey = profile_pda(&author.pubkey());
    let payer = env.app_payer.insecure_clone();
    assert_error(env.send(&[ix], &[&payer]), "AccountMismatch");

    let owner = author.pubkey();
    for kind in [
        BadgeKind::FirstOver50,
        BadgeKind::FirstOver100,
        BadgeKind::TenOver50,
        BadgeKind::Over1000,
    ] {
        assert_error(mint_badge(&mut env, &owner, kind), "BadgeNotEarned");
    }

    set_counters(&mut env, &owner, |p| p.takes_over_50 = 9);
    assert_error(
        mint_badge(&mut env, &owner, BadgeKind::TenOver50),
        "BadgeNotEarned",
    );
    set_counters(&mut env, &owner, |p| {
        p.takes_over_50 = 10;
        p.takes_over_100 = 1;
        p.takes_over_1000 = 1;
    });
    for kind in [
        BadgeKind::TenOver50,
        BadgeKind::FirstOver100,
        BadgeKind::Over1000,
    ] {
        mint_badge(&mut env, &owner, kind).expect("earned");
    }
}

#[test]
fn settling_a_big_win_earns_the_plus_50_badge() {
    let (mut env, author) = author_with_take();
    let owner = author.pubkey();
    let take = take_pda(&owner, 1);
    let pos = position_pda(&take, &owner, AUTHOR_POSITION_ID);
    env.set_time(NOW + 120);
    env.record(false, &take, &pos, vec![price(0, usd(100.0), NOW + 60)])
        .unwrap();
    env.set_time(HORIZON + 120);
    env.record(true, &take, &pos, vec![price(0, usd(160.0), HORIZON + 60)])
        .unwrap();
    let ix = env.settle_take_ix(&take, &owner);
    env.crank(ix).unwrap();

    mint_badge(&mut env, &owner, BadgeKind::FirstOver50).expect("+60% earns +50%");
    assert_error(
        mint_badge(&mut env, &owner, BadgeKind::FirstOver100),
        "BadgeNotEarned",
    );
}

#[test]
fn prefunded_mint_address_still_mints() {
    // Anyone can send lamports to the badge address first; that must not block the badge.
    let (mut env, author) = author_with_take();
    let mint_key = badge_mint(&author.pubkey(), BadgeKind::FirstTake);
    let lamports = env.svm.minimum_balance_for_rent_exemption(0);
    env.svm.airdrop(&mint_key, lamports).unwrap();
    mint_badge(&mut env, &author.pubkey(), BadgeKind::FirstTake).expect("mint_badge");
    assert_eq!(env.svm.get_account(&mint_key).unwrap().owner, TOKEN_2022);
}

#[test]
fn wrong_badge_account_fails() {
    let (mut env, author) = author_with_take();
    let ix = mint_badge_ix(
        &env,
        &author.pubkey(),
        BadgeKind::FirstTake,
        Pubkey::new_unique(),
    );
    let payer = env.app_payer.insecure_clone();
    assert_error(
        env.send(&[ix], &[&payer]),
        "AccountNotAssociatedTokenAccount",
    );
}
