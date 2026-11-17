use {
    anchor_lang::{
        solana_program::instruction::Instruction, InstructionData, Space, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    thesis::{state::Take, MAX_LEGS},
};

fn svm_with_program() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/thesis.so"));
    svm.add_program(thesis::id(), bytes).unwrap();
    svm
}

#[test]
fn program_deploys() {
    let svm = svm_with_program();
    assert!(svm.get_account(&thesis::id()).unwrap().executable);
}

#[test]
fn update_config_needs_an_initialized_config() {
    let mut svm = svm_with_program();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    let config =
        anchor_lang::prelude::Pubkey::find_program_address(&[thesis::CONFIG_SEED], &thesis::id()).0;

    let params = thesis::ConfigParams {
        fee_bps: 10,
        creator_fee_bps: 5,
        min_stake: 10_000_000,
        max_legs: 10,
        min_horizon_secs: 3_600,
        max_horizon_secs: (5 * 365 + 1) * 86_400,
        max_price_delay_secs: 4 * 86_400,
        creator_boost_bps: 0,
        paused: false,
    };
    let ix = Instruction::new_with_bytes(
        thesis::id(),
        &thesis::instruction::UpdateConfig {
            args: thesis::UpdateConfigArgs {
                params,
                new_admin: None,
                new_settler: None,
                new_badge_uri_base: None,
            },
        }
        .data(),
        thesis::accounts::UpdateConfig {
            event_authority: anchor_lang::prelude::Pubkey::find_program_address(
                &[b"__event_authority"],
                &thesis::id(),
            )
            .0,
            program: ::thesis::id(),
            admin: admin.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    let msg = Message::new_with_blockhash(&[ix], Some(&admin.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&admin]).unwrap();

    assert!(svm.send_transaction(tx).is_err());
}

#[test]
fn take_space_scales_with_legs() {
    assert_eq!(Take::space(MAX_LEGS), 8 + Take::INIT_SPACE);
    assert!(Take::space(1) < Take::space(3));
}
