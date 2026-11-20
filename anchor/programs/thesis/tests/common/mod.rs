//! Shared LiteSVM harness: a deployed program, a fake USDC mint, an initialized config,
//! and helpers to fund users and send instructions.
#![allow(dead_code)]
// LiteSVM's failure type is large; fine in tests.
#![allow(clippy::result_large_err)]

use {
    ::thesis::{
        constants::*, state::*, ConfigParams, CreateTakeArgs, LegPrice, OpenPositionArgs,
        RecordPricesArgs, UpdateAllowlistArgs, UpdateConfigArgs,
    },
    anchor_lang::{
        prelude::{AccountMeta, Pubkey},
        solana_program::instruction::Instruction,
        system_program, AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_account::Account,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const USDC: u64 = 1_000_000;
pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 24 * HOUR;
/// Test clock start.
pub const NOW: i64 = 1_800_000_000;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

/// The test-only venue (`programs/mock_venue`): swaps between a pool and a user, like a Jupiter
/// route, and can call another program (for the nested-CPI attack).
pub const MOCK_VENUE: Pubkey =
    anchor_lang::prelude::pubkey!("6wyYbfk7tXFAejgwcnQNSk7k4qRxe7TpBYSGAcwKEftn");
/// The test-only Phoenix stand-in (`programs/mock_phoenix`), deployed at Phoenix's real id.
pub const PHOENIX: Pubkey = ::thesis::proof::PHOENIX_PROGRAM_ID;
const PLACE_MARKET_ORDER_DISCRIMINATOR: [u8; 8] = [90, 118, 192, 252, 192, 99, 39, 145];
pub const COMPUTE_BUDGET: Pubkey =
    anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111");
pub const INSTRUCTIONS_SYSVAR: Pubkey = ::thesis::proof::INSTRUCTIONS_SYSVAR_ID;
pub const BPF_LOADER_UPGRADEABLE: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
const CALL_DISCRIMINATOR: [u8; 8] = [181, 94, 56, 161, 194, 221, 200, 3];

/// What the tests' config allows between `begin_trade` and a receipt.
pub fn default_trade_programs() -> Vec<Pubkey> {
    vec![
        MOCK_VENUE,
        COMPUTE_BUDGET,
        anchor_spl::associated_token::ID,
        PHOENIX,
    ]
}

/// A Phoenix trader account of `authority` with room for one position and none open (the
/// layout `proof.rs` reads: discriminator, sequence number, key, authority, ..., entries at 224).
pub fn phoenix_trader_data(authority: &Pubkey) -> Vec<u8> {
    let mut data = vec![0u8; 280];
    data[..8].copy_from_slice(&::thesis::proof::PHOENIX_TRADER_DISCRIMINATOR);
    data[56..88].copy_from_slice(authority.as_ref());
    data[232..240].copy_from_slice(&1u64.to_le_bytes()); // capacity
    data
}

pub fn pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"pool"], &MOCK_VENUE).0
}

/// A trade's venue side, ready to go between `begin_trade` and the receipt.
pub struct Trade {
    /// Legs with an output account (bit i = leg i), and those accounts in leg order.
    pub outputs_mask: u16,
    pub outputs: Vec<Pubkey>,
    /// One mock swap per included leg.
    pub swaps: Vec<Instruction>,
}

pub fn default_params() -> ConfigParams {
    ConfigParams {
        fee_bps: 10,
        creator_fee_bps: 5,
        min_stake: 10 * USDC,
        max_legs: 10,
        min_horizon_secs: HOUR,
        max_horizon_secs: (5 * 365 + 1) * DAY,
        max_price_delay_secs: 4 * DAY,
        creator_boost_bps: 0,
        paused: false,
    }
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &::thesis::id()).0
}

/// Anchor's event authority: the PDA that signs the program's self-CPI events (`emit_cpi!`).
pub fn event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &::thesis::id()).0
}

pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn fee_vault_pda() -> Pubkey {
    pda(&[FEE_VAULT_SEED])
}
pub fn escrow_vault_pda() -> Pubkey {
    pda(&[ESCROW_VAULT_SEED])
}
pub fn creator_vault_pda() -> Pubkey {
    pda(&[CREATOR_VAULT_SEED])
}
pub fn profile_pda(owner: &Pubkey) -> Pubkey {
    pda(&[PROFILE_SEED, owner.as_ref()])
}
pub fn take_pda(author: &Pubkey, id: u64) -> Pubkey {
    pda(&[TAKE_SEED, author.as_ref(), &id.to_le_bytes()])
}
pub fn position_pda(take: &Pubkey, owner: &Pubkey, id: u64) -> Pubkey {
    pda(&[
        POSITION_SEED,
        take.as_ref(),
        owner.as_ref(),
        &id.to_le_bytes(),
    ])
}

pub fn exit_pda(position: &Pubkey) -> Pubkey {
    pda(&[EXIT_SEED, position.as_ref()])
}

pub fn part_sale_pda(position: &Pubkey, seq: u16) -> Pubkey {
    pda(&[PART_SALE_SEED, position.as_ref(), &seq.to_le_bytes()])
}

pub fn ticket_pda(owner: &Pubkey, position: &Pubkey) -> Pubkey {
    pda(&[TICKET_SEED, owner.as_ref(), position.as_ref()])
}

pub fn token_program() -> Pubkey {
    anchor_spl::token::ID
}

/// A spot leg with a Pyth feed, fadeable through a Phoenix short.
pub fn spot_leg(weight_bps: u16) -> LegSpec {
    LegSpec {
        kind: LegKind::Spot,
        asset: Pubkey::new_unique(),
        weight_bps,
        leverage: 1,
        fade_via: FadeVia::PhoenixShort,
    }
}

/// A USDC yield leg: no feed, can't be faded.
pub fn yield_leg(weight_bps: u16) -> LegSpec {
    LegSpec {
        kind: LegKind::Yield,
        asset: Pubkey::new_unique(),
        weight_bps,
        leverage: 1,
        fade_via: FadeVia::None,
    }
}

/// A Phoenix perp leg with leverage.
pub fn perp_leg(weight_bps: u16, leverage: u8) -> LegSpec {
    LegSpec {
        kind: LegKind::Perp,
        asset: Pubkey::new_unique(),
        weight_bps,
        leverage,
        fade_via: FadeVia::PhoenixShort,
    }
}

/// A Gemini prediction leg, fadeable by buying "No".
pub fn prediction_leg(weight_bps: u16) -> LegSpec {
    LegSpec {
        kind: LegKind::Prediction,
        asset: Pubkey::new_unique(),
        weight_bps,
        leverage: 1,
        fade_via: FadeVia::PredictionNo,
    }
}

/// A Collector Crypt card leg: escrowed (paper-filled at the card's insured value), can't be faded.
pub fn card_leg(weight_bps: u16) -> LegSpec {
    LegSpec {
        kind: LegKind::Card,
        asset: Pubkey::new_unique(),
        weight_bps,
        leverage: 1,
        fade_via: FadeVia::None,
    }
}

/// `dollars` in on-chain price units (8 decimals).
pub fn usd(dollars: f64) -> u64 {
    (dollars * PRICE_ONE as f64).round() as u64
}

pub fn price(leg: u8, price: u64, published_at: i64) -> LegPrice {
    LegPrice {
        leg,
        price,
        published_at,
    }
}

pub struct User {
    pub key: Keypair,
    pub usdc: Pubkey,
}

impl User {
    pub fn pubkey(&self) -> Pubkey {
        self.key.pubkey()
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    /// The trade allowlist's own key (security review M-2).
    pub allowlist_admin: Keypair,
    pub settler: Keypair,
    /// Pays rent for Privy users, like the app's fee payer.
    pub app_payer: Keypair,
    pub mint: Pubkey,
    /// The mock venue's USDC account (where swaps send the stake).
    pub pool_usdc: Pubkey,
    /// Where a swap that pays nothing out "sends" its 0 (perps, predictions, fades).
    pool_sink: Pubkey,
    /// Leg asset → (the token a swap for it pays out, the pool's account holding it).
    markets: std::collections::HashMap<Pubkey, (Pubkey, Pubkey)>,
    /// (owner, leg asset) → the owner's account for that token.
    holdings: std::collections::HashMap<(Pubkey, Pubkey), Pubkey>,
    /// (owner, leg asset) → the owner's Phoenix trader account for that leg.
    phoenix_accounts: std::collections::HashMap<(Pubkey, Pubkey), Pubkey>,
    /// Each user's USDC account, by owner (settlement returns escrow there).
    usdc_of: std::collections::HashMap<Pubkey, Pubkey>,
}

impl Env {
    /// Deployed program, fake USDC, clock at `NOW`, config not yet initialized.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/thesis.so"));
        svm.add_program(::thesis::id(), bytes).unwrap();

        let admin = Keypair::new();
        let allowlist_admin = Keypair::new();
        let settler = Keypair::new();
        let app_payer = Keypair::new();
        for k in [&admin, &allowlist_admin, &settler, &app_payer] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }

        let venue = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/mock_venue.so"
        ));
        svm.add_program(MOCK_VENUE, venue).unwrap();
        // Read at run time, not with `include_bytes!`: `anchor build` compiles the tests for the
        // Thesis IDL before it gets to this program, so the file may not exist yet then.
        let phoenix = std::fs::read(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/mock_phoenix.so"
        ))
        .expect("anchor build first: target/deploy/mock_phoenix.so");
        svm.add_program(PHOENIX, &phoenix).unwrap();

        let mint = Pubkey::new_unique();
        let mut env = Env {
            svm,
            admin,
            allowlist_admin,
            settler,
            app_payer,
            mint,
            pool_usdc: Pubkey::new_unique(),
            pool_sink: Pubkey::new_unique(),
            markets: Default::default(),
            holdings: Default::default(),
            phoenix_accounts: Default::default(),
            usdc_of: Default::default(),
        };
        env.set_token_account(mint, mint_data(&Pubkey::new_unique(), 6));
        // LiteSVM deploys with no upgrade authority; make it the admin, as a real deploy would.
        let admin_key = env.admin.pubkey();
        env.set_upgrade_authority(Some(&admin_key));
        let pool_usdc = env.pool_usdc;
        env.set_token_account(pool_usdc, token_account_data(&mint, &pool_authority(), 0));
        let pool_sink = env.pool_sink;
        env.set_token_account(pool_sink, token_account_data(&mint, &pool_authority(), 0));
        env.set_time(NOW);
        env
    }

    /// `bare()` plus `init_config` with the launch values.
    pub fn new() -> Self {
        let mut env = Self::bare();
        let ix = env.init_config_ix(default_params());
        let admin = env.admin.insecure_clone();
        env.send(&[ix], &[&admin]).expect("init_config");
        env
    }

    /// The token a swap for `asset` pays out, and the pool's account holding plenty of it.
    pub fn market(&mut self, asset: &Pubkey) -> (Pubkey, Pubkey) {
        if let Some(m) = self.markets.get(asset) {
            return *m;
        }
        let (mint, pool) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.set_token_account(mint, mint_data(&Pubkey::new_unique(), 6));
        self.set_token_account(
            pool,
            token_account_data(&mint, &pool_authority(), 1_000_000_000 * USDC),
        );
        self.markets.insert(*asset, (mint, pool));
        (mint, pool)
    }

    /// `owner`'s (empty, at first) account for the token a swap for `asset` pays out.
    pub fn holding(&mut self, owner: &Pubkey, asset: &Pubkey) -> Pubkey {
        if let Some(h) = self.holdings.get(&(*owner, *asset)) {
            return *h;
        }
        let (mint, _) = self.market(asset);
        let account = self.token_account(&mint, owner, 0);
        self.holdings.insert((*owner, *asset), account);
        account
    }

    /// `owner`'s Phoenix trader account for a leg (an isolated subaccount), empty at first.
    pub fn phoenix_account(&mut self, owner: &Pubkey, asset: &Pubkey) -> Pubkey {
        if let Some(a) = self.phoenix_accounts.get(&(*owner, *asset)) {
            return *a;
        }
        let address = Pubkey::new_unique();
        self.set_phoenix_account(address, phoenix_trader_data(owner));
        self.phoenix_accounts.insert((*owner, *asset), address);
        address
    }

    /// Writes a Phoenix-owned account (the stand-in program can change only accounts it owns).
    pub fn set_phoenix_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                solana_account::Account {
                    lamports,
                    data,
                    owner: PHOENIX,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// The stand-in's `place_market_order`: adds `base_lots` (negative for a short) to the
    /// account's position.
    pub fn place_market_order_ix(
        &self,
        authority: &Pubkey,
        trader: &Pubkey,
        base_lots: i64,
    ) -> Instruction {
        let mut data = PLACE_MARKET_ORDER_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&base_lots.to_le_bytes());
        Instruction {
            program_id: PHOENIX,
            accounts: vec![
                AccountMeta::new_readonly(*authority, true),
                AccountMeta::new(*trader, false),
            ],
            data,
        }
    }

    /// The signed size of the position in a Phoenix trader account.
    pub fn phoenix_position(&self, trader: &Pubkey) -> i64 {
        let data = self.svm.get_account(trader).unwrap().data;
        if u64::from_le_bytes(data[224..232].try_into().unwrap()) == 0 {
            return 0;
        }
        i64::from_le_bytes(data[248..256].try_into().unwrap())
    }

    /// A token account for any mint at a chosen address (an associated token account, say).
    pub fn token_account_at(
        &mut self,
        address: Pubkey,
        mint: &Pubkey,
        owner: &Pubkey,
        amount: u64,
    ) {
        self.set_token_account(address, token_account_data(mint, owner, amount));
    }

    /// A new token account for any mint.
    pub fn token_account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let account = Pubkey::new_unique();
        self.set_token_account(account, token_account_data(mint, owner, amount));
        account
    }

    /// A mock venue swap: `amount_in` USDC (or any token) from `source` into the pool, and
    /// `amount_out` of `pool_out`'s token to `destination`.
    pub fn swap_ix(
        &self,
        user: &Pubkey,
        source: &Pubkey,
        amount_in: u64,
        pool_out: &Pubkey,
        destination: &Pubkey,
        amount_out: u64,
    ) -> Instruction {
        let mut data = SWAP_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&amount_out.to_le_bytes());
        Instruction {
            program_id: MOCK_VENUE,
            accounts: vec![
                AccountMeta::new_readonly(*user, true),
                AccountMeta::new(*source, false),
                AccountMeta::new(self.pool_usdc, false),
                AccountMeta::new(*pool_out, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(pool_authority(), false),
                AccountMeta::new_readonly(token_program(), false),
            ],
            data,
        }
    }

    /// The mock venue invoking `ix` through CPI.
    pub fn venue_call_ix(&self, ix: &Instruction) -> Instruction {
        let mut data = CALL_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&(ix.data.len() as u32).to_le_bytes());
        data.extend_from_slice(&ix.data);
        let mut accounts = vec![AccountMeta::new_readonly(ix.program_id, false)];
        accounts.extend(ix.accounts.iter().cloned());
        Instruction {
            program_id: MOCK_VENUE,
            accounts,
            data,
        }
    }

    /// An honest trade of `stake` across the included legs, split by weight: each leg's swap
    /// spends its part of the stake. Legs that leave a token with the owner (a back's spot and
    /// yield legs) get it in the owner's holding. Phoenix legs (a back's perps, a fade's
    /// shorts) spend it as collateral, then open a position of that many base lots (long for a
    /// back, short for a fade) in the owner's Phoenix account for the leg.
    pub fn trade(
        &mut self,
        owner: &User,
        legs: &[LegSpec],
        legs_mask: u16,
        stake: u64,
        side: Side,
    ) -> Trade {
        let required = ::thesis::proof::required_outputs(legs, legs_mask, side);
        let included: Vec<usize> = (0..legs.len())
            .filter(|i| legs_mask & (1 << i) != 0)
            .collect();
        // Prediction and card legs aren't traded: the receipt escrows their share. The rest is swapped.
        let escrowed = ::thesis::utils::escrow_share(legs, legs_mask, stake).unwrap();
        let traded: Vec<usize> = included
            .into_iter()
            .filter(|&i| !legs[i].kind.is_escrowed())
            .collect();
        let total: u64 = traded.iter().map(|&i| legs[i].weight_bps as u64).sum();
        let spend = stake - escrowed;
        let mut left = spend;
        let mut trade = Trade {
            outputs_mask: required.all(),
            outputs: vec![],
            swaps: vec![],
        };
        for (n, &i) in traded.iter().enumerate() {
            let part = if n + 1 == traded.len() {
                left
            } else {
                spend * legs[i].weight_bps as u64 / total.max(1)
            };
            left -= part;
            let asset = legs[i].asset;
            let (_, pool_out) = self.market(&asset);
            if required.phoenix & (1 << i) != 0 {
                let account = self.phoenix_account(&owner.pubkey(), &asset);
                trade.outputs.push(account);
                trade.swaps.push(self.swap_ix(
                    &owner.pubkey(),
                    &owner.usdc,
                    part,
                    &pool_out,
                    &self.pool_sink,
                    0,
                ));
                let lots = part.max(1) as i64;
                let signed = if side == Side::Back { lots } else { -lots };
                trade
                    .swaps
                    .push(self.place_market_order_ix(&owner.pubkey(), &account, signed));
            } else if required.tokens & (1 << i) != 0 {
                let holding = self.holding(&owner.pubkey(), &asset);
                trade.outputs.push(holding);
                trade.swaps.push(self.swap_ix(
                    &owner.pubkey(),
                    &owner.usdc,
                    part,
                    &pool_out,
                    &holding,
                    part.max(1),
                ));
            } else {
                trade.swaps.push(self.swap_ix(
                    &owner.pubkey(),
                    &owner.usdc,
                    part,
                    &pool_out,
                    &self.pool_sink,
                    0,
                ));
            }
        }
        trade
    }

    pub fn begin_trade_ix(
        &self,
        owner: &User,
        payer: &Pubkey,
        position: &Pubkey,
        outputs_mask: u16,
        outputs: &[Pubkey],
    ) -> Instruction {
        let mut accounts = ::thesis::accounts::BeginTrade {
            owner: owner.pubkey(),
            payer: *payer,
            config: config_pda(),
            position: *position,
            ticket: ticket_pda(&owner.pubkey(), position),
            owner_usdc: owner.usdc,
            instructions: INSTRUCTIONS_SYSVAR,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(outputs.iter().map(|o| AccountMeta::new_readonly(*o, false)));
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::BeginTrade {
                args: ::thesis::BeginTradeArgs { outputs_mask },
            }
            .data(),
            accounts,
        )
    }

    pub fn trade_step_ix(
        &self,
        owner: &User,
        position: &Pubkey,
        open: bool,
        outputs_mask: u16,
        outputs: &[Pubkey],
    ) -> Instruction {
        let mut accounts = ::thesis::accounts::TradeStep {
            owner: owner.pubkey(),
            config: config_pda(),
            ticket: ticket_pda(&owner.pubkey(), position),
            owner_usdc: owner.usdc,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None);
        accounts.extend(outputs.iter().map(|o| AccountMeta::new_readonly(*o, false)));
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::TradeStep {
                args: ::thesis::TradeStepArgs { open, outputs_mask },
            }
            .data(),
            accounts,
        )
    }

    pub fn cancel_trade_ix(
        &self,
        owner: &Pubkey,
        position: &Pubkey,
        rent_payer: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::CancelTrade {}.data(),
            ::thesis::accounts::CancelTrade {
                owner: *owner,
                ticket: ticket_pda(owner, position),
                rent_payer: *rent_payer,
            }
            .to_account_metas(None),
        )
    }

    /// The Thesis program's ProgramData account (upgradeable loader).
    pub fn program_data() -> Pubkey {
        Pubkey::find_program_address(&[::thesis::id().as_ref()], &BPF_LOADER_UPGRADEABLE).0
    }

    /// Rewrites the upgrade authority in the program's ProgramData header (bincode: u32 tag 3,
    /// u64 slot, then the `Option<Pubkey>` at byte 12). The program's code after it is untouched.
    pub fn set_upgrade_authority(&mut self, authority: Option<&Pubkey>) {
        let address = Self::program_data();
        let mut account = self.svm.get_account(&address).expect("ProgramData");
        account.data[12] = authority.is_some() as u8;
        account.data[13..45]
            .copy_from_slice(authority.map(|a| a.to_bytes()).unwrap_or_default().as_ref());
        self.svm.set_account(address, account).unwrap();
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn set_token_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner: token_program(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// A new user with SOL and a USDC account holding `usdc` base units.
    pub fn user(&mut self, usdc: u64) -> User {
        self.user_with_key(Keypair::new(), usdc)
    }

    /// Like `user`, with a chosen key (for reproducible addresses and compute).
    pub fn user_with_key(&mut self, key: Keypair, usdc: u64) -> User {
        self.svm.airdrop(&key.pubkey(), 10_000_000_000).unwrap();
        let account = Pubkey::new_unique();
        self.set_token_account(account, token_account_data(&self.mint, &key.pubkey(), usdc));
        self.usdc_of.insert(key.pubkey(), account);
        User { key, usdc: account }
    }

    /// An empty USDC account owned by `owner`.
    pub fn usdc_account(&mut self, owner: &Pubkey) -> Pubkey {
        let account = Pubkey::new_unique();
        self.set_token_account(account, token_account_data(&self.mint, owner, 0));
        account
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        let data = self.svm.get_account(token_account).unwrap().data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    pub fn fetch<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).expect("account exists");
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .is_some_and(|a| a.lamports > 0)
    }

    /// Sends one transaction; the first signer pays the network fee.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            ixs,
            Some(&signers[0].pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    // Instruction builders

    pub fn init_config_ix(&self, params: ConfigParams) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::InitConfig {
                settler: self.settler.pubkey(),
                allowlist_admin: self.allowlist_admin.pubkey(),
                params,
                trade_programs: default_trade_programs(),
            }
            .data(),
            ::thesis::accounts::InitConfig {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                admin: self.admin.pubkey(),
                config: config_pda(),
                usdc_mint: self.mint,
                fee_vault: fee_vault_pda(),
                creator_vault: creator_vault_pda(),
                token_program: token_program(),
                system_program: system_program::ID,
                escrow_vault: escrow_vault_pda(),
                program_data: Self::program_data(),
            }
            .to_account_metas(None),
        )
    }

    pub fn update_config_ix(&self, admin: &Pubkey, args: UpdateConfigArgs) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::UpdateConfig { args }.data(),
            ::thesis::accounts::UpdateConfig {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                admin: *admin,
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    pub fn update_allowlist_ix(&self, signer: &Pubkey, args: UpdateAllowlistArgs) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::UpdateAllowlist { args }.data(),
            ::thesis::accounts::UpdateAllowlist {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                allowlist_admin: *signer,
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    /// The allowlist admin replaces the trade allowlist.
    pub fn set_trade_programs(&mut self, programs: Vec<Pubkey>) -> TxResult {
        let key = self.allowlist_admin.insecure_clone();
        let ix = self.update_allowlist_ix(
            &key.pubkey(),
            UpdateAllowlistArgs {
                new_trade_programs: Some(programs),
                new_allowlist_admin: None,
            },
        );
        self.send(&[ix], &[&key])
    }

    pub fn accept_admin_ix(&self, new_admin: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::AcceptAdmin {}.data(),
            ::thesis::accounts::AcceptAdmin {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                new_admin: *new_admin,
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    pub fn accept_allowlist_admin_ix(&self, new_key: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::AcceptAllowlistAdmin {}.data(),
            ::thesis::accounts::AcceptAllowlistAdmin {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                new_allowlist_admin: *new_key,
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    pub fn withdraw_fees_ix(
        &self,
        admin: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::WithdrawFees { amount }.data(),
            ::thesis::accounts::WithdrawFees {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                admin: *admin,
                config: config_pda(),
                fee_vault: fee_vault_pda(),
                destination: *destination,
                usdc_mint: self.mint,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    /// The author's whole buy-in, honestly traded: `begin_trade`, a swap per bought leg, then
    /// `create_take`.
    pub fn create_take_ix(
        &mut self,
        author: &User,
        payer: &Pubkey,
        args: CreateTakeArgs,
    ) -> Vec<Instruction> {
        let take = take_pda(&author.pubkey(), args.id);
        let position = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
        let side = if args.inverted {
            Side::Fade
        } else {
            Side::Back
        };
        let trade = self.trade(author, &args.legs, args.legs_mask, args.stake, side);
        let mut ixs =
            vec![self.begin_trade_ix(author, payer, &position, trade.outputs_mask, &trade.outputs)];
        ixs.extend(trade.swaps);
        ixs.push(self.create_take_receipt_ix(author, payer, args, &trade.outputs));
        ixs
    }

    /// Just the `create_take` instruction, with `outputs` as its remaining accounts.
    pub fn create_take_receipt_ix(
        &self,
        author: &User,
        payer: &Pubkey,
        args: CreateTakeArgs,
        outputs: &[Pubkey],
    ) -> Instruction {
        let take = take_pda(&author.pubkey(), args.id);
        let position = position_pda(&take, &author.pubkey(), AUTHOR_POSITION_ID);
        let mut accounts = ::thesis::accounts::CreateTake {
            event_authority: event_authority_pda(),
            program: ::thesis::id(),
            author: author.pubkey(),
            payer: *payer,
            config: config_pda(),
            author_profile: profile_pda(&author.pubkey()),
            take,
            author_position: position,
            author_usdc: author.usdc,
            fee_vault: fee_vault_pda(),
            usdc_mint: self.mint,
            token_program: token_program(),
            system_program: system_program::ID,
            ticket: ticket_pda(&author.pubkey(), &position),
            instructions: INSTRUCTIONS_SYSVAR,
            escrow_vault: escrow_vault_pda(),
        }
        .to_account_metas(None);
        accounts.extend(outputs.iter().map(|o| AccountMeta::new_readonly(*o, false)));
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::CreateTake { args }.data(),
            accounts,
        )
    }

    /// A whole back or fade, honestly traded: `begin_trade`, a swap per included leg, then the
    /// receipt.
    pub fn open_position_ix(
        &mut self,
        side: Side,
        owner: &User,
        payer: &Pubkey,
        take: &Pubkey,
        args: OpenPositionArgs,
    ) -> Vec<Instruction> {
        let legs = self.fetch::<Take>(take).legs;
        let position = position_pda(take, &owner.pubkey(), args.id);
        let trade = self.trade(owner, &legs, args.legs_mask, args.stake, side);
        let mut ixs =
            vec![self.begin_trade_ix(owner, payer, &position, trade.outputs_mask, &trade.outputs)];
        ixs.extend(trade.swaps);
        ixs.push(self.receipt_ix(side, owner, payer, take, args, &trade.outputs));
        ixs
    }

    /// Just the `back` / `fade` instruction, with `outputs` as its remaining accounts.
    pub fn receipt_ix(
        &self,
        side: Side,
        owner: &User,
        payer: &Pubkey,
        take: &Pubkey,
        args: OpenPositionArgs,
        outputs: &[Pubkey],
    ) -> Instruction {
        let data = match side {
            Side::Back => ::thesis::instruction::Back { args }.data(),
            Side::Fade => ::thesis::instruction::Fade { args }.data(),
        };
        let position = position_pda(take, &owner.pubkey(), args.id);
        let mut accounts = ::thesis::accounts::OpenPosition {
            event_authority: event_authority_pda(),
            program: ::thesis::id(),
            owner: owner.pubkey(),
            payer: *payer,
            config: config_pda(),
            take: *take,
            owner_profile: profile_pda(&owner.pubkey()),
            position,
            owner_usdc: owner.usdc,
            fee_vault: fee_vault_pda(),
            creator_vault: creator_vault_pda(),
            usdc_mint: self.mint,
            token_program: token_program(),
            system_program: system_program::ID,
            ticket: ticket_pda(&owner.pubkey(), &position),
            instructions: INSTRUCTIONS_SYSVAR,
            escrow_vault: escrow_vault_pda(),
        }
        .to_account_metas(None);
        accounts.extend(outputs.iter().map(|o| AccountMeta::new_readonly(*o, false)));
        Instruction::new_with_bytes(::thesis::id(), &data, accounts)
    }

    pub fn claim_creator_fees_ix(&self, author: &User, take: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::ClaimCreatorFees {}.data(),
            ::thesis::accounts::ClaimCreatorFees {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                author: author.pubkey(),
                config: config_pda(),
                take: *take,
                creator_vault: creator_vault_pda(),
                author_usdc: author.usdc,
                usdc_mint: self.mint,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    pub fn record_prices_ix(
        &self,
        exit: bool,
        settler: &Pubkey,
        take: &Pubkey,
        position: &Pubkey,
        prices: Vec<LegPrice>,
    ) -> Instruction {
        let args = RecordPricesArgs {
            prices,
            source_hash: [3; 32],
        };
        let data = if exit {
            ::thesis::instruction::RecordExitPrices { args }.data()
        } else {
            ::thesis::instruction::RecordEntryPrices { args }.data()
        };
        Instruction::new_with_bytes(
            ::thesis::id(),
            &data,
            ::thesis::accounts::RecordPrices {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                settler: *settler,
                config: config_pda(),
                take: *take,
                position: *position,
            }
            .to_account_metas(None),
        )
    }

    /// Records prices signed by the configured settler.
    pub fn record(
        &mut self,
        exit: bool,
        take: &Pubkey,
        position: &Pubkey,
        prices: Vec<LegPrice>,
    ) -> TxResult {
        let settler = self.settler.insecure_clone();
        let ix = self.record_prices_ix(exit, &settler.pubkey(), take, position, prices);
        self.send(&[ix], &[&settler])
    }

    pub fn settle_take_ix(&self, take: &Pubkey, author: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::SettleTake {}.data(),
            ::thesis::accounts::SettleTake {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                config: config_pda(),
                take: *take,
                author_position: position_pda(take, author, AUTHOR_POSITION_ID),
                author_profile: profile_pda(author),
                author_exit: exit_pda(&position_pda(take, author, AUTHOR_POSITION_ID)),
            }
            .to_account_metas(None),
        )
    }

    pub fn settle_position_ix(
        &self,
        take: &Pubkey,
        position: &Pubkey,
        owner: &Pubkey,
        rent_payer: &Pubkey,
    ) -> Instruction {
        self.settle_sold_position_ix(take, position, owner, rent_payer, rent_payer)
    }

    /// `settle_position` with the account that paid for the position's exit.
    pub fn settle_sold_position_ix(
        &self,
        take: &Pubkey,
        position: &Pubkey,
        owner: &Pubkey,
        rent_payer: &Pubkey,
        exit_rent_payer: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::SettlePosition {}.data(),
            ::thesis::accounts::SettlePosition {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                config: config_pda(),
                take: *take,
                position: *position,
                owner_profile: profile_pda(owner),
                rent_payer: *rent_payer,
                exit: exit_pda(position),
                exit_rent_payer: *exit_rent_payer,
                escrow_vault: escrow_vault_pda(),
                owner_usdc: *self.usdc_of.get(owner).expect("a user made by Env::user"),
                usdc_mint: self.mint,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    pub fn exit_position_ix(
        &self,
        owner: &Pubkey,
        payer: &Pubkey,
        take: &Pubkey,
        position: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::ExitPosition {}.data(),
            ::thesis::accounts::ExitPosition {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                owner: *owner,
                payer: *payer,
                take: *take,
                position: *position,
                exit: exit_pda(position),
                system_program: system_program::ID,
                config: config_pda(),
                escrow_vault: escrow_vault_pda(),
                owner_usdc: *self.usdc_of.get(owner).expect("a user made by Env::user"),
                usdc_mint: self.mint,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    /// Sells a position, with the app's fee payer paying the exit's rent.
    pub fn exit_position(&mut self, owner: &User, take: &Pubkey, position: &Pubkey) -> TxResult {
        let payer = self.app_payer.insecure_clone();
        let ix = self.exit_position_ix(&owner.pubkey(), &payer.pubkey(), take, position);
        self.send(&[ix], &[&payer, &owner.key])
    }

    pub fn record_sale_prices_ix(
        &self,
        settler: &Pubkey,
        take: &Pubkey,
        position: &Pubkey,
        prices: Vec<LegPrice>,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::RecordSalePrices {
                args: RecordPricesArgs {
                    prices,
                    source_hash: [4; 32],
                },
            }
            .data(),
            ::thesis::accounts::RecordSalePrices {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                settler: *settler,
                config: config_pda(),
                take: *take,
                position: *position,
                exit: exit_pda(position),
            }
            .to_account_metas(None),
        )
    }

    /// Records sale prices signed by the configured settler.
    pub fn record_sale(
        &mut self,
        take: &Pubkey,
        position: &Pubkey,
        prices: Vec<LegPrice>,
    ) -> TxResult {
        let settler = self.settler.insecure_clone();
        let ix = self.record_sale_prices_ix(&settler.pubkey(), take, position, prices);
        self.send(&[ix], &[&settler])
    }

    pub fn sell_part_ix(
        &self,
        owner: &Pubkey,
        payer: &Pubkey,
        take: &Pubkey,
        position: &Pubkey,
        seq: u16,
        bps: u16,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::SellPart { bps }.data(),
            ::thesis::accounts::SellPart {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                owner: *owner,
                payer: *payer,
                take: *take,
                position: *position,
                part_sale: part_sale_pda(position, seq),
                system_program: system_program::ID,
                config: config_pda(),
                escrow_vault: escrow_vault_pda(),
                owner_usdc: *self.usdc_of.get(owner).expect("a user made by Env::user"),
                usdc_mint: self.mint,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    /// Sells `bps` of what's left of a position, with the app's fee payer paying the part's rent.
    /// Its seq is the position's next one.
    pub fn sell_part(
        &mut self,
        owner: &User,
        take: &Pubkey,
        position: &Pubkey,
        bps: u16,
    ) -> TxResult {
        let seq = self.fetch::<Position>(position).parts;
        let payer = self.app_payer.insecure_clone();
        let ix = self.sell_part_ix(&owner.pubkey(), &payer.pubkey(), take, position, seq, bps);
        self.send(&[ix], &[&payer, &owner.key])
    }

    pub fn record_part_prices_ix(
        &self,
        settler: &Pubkey,
        take: &Pubkey,
        position: &Pubkey,
        seq: u16,
        prices: Vec<LegPrice>,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::RecordPartPrices {
                args: RecordPricesArgs {
                    prices,
                    source_hash: [5; 32],
                },
            }
            .data(),
            ::thesis::accounts::RecordPartPrices {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                settler: *settler,
                config: config_pda(),
                take: *take,
                position: *position,
                part_sale: part_sale_pda(position, seq),
            }
            .to_account_metas(None),
        )
    }

    /// Records a partial sale's prices, signed by the configured settler.
    pub fn record_part(
        &mut self,
        take: &Pubkey,
        position: &Pubkey,
        seq: u16,
        prices: Vec<LegPrice>,
    ) -> TxResult {
        let settler = self.settler.insecure_clone();
        let ix = self.record_part_prices_ix(&settler.pubkey(), take, position, seq, prices);
        self.send(&[ix], &[&settler])
    }

    pub fn settle_part_ix(
        &self,
        take: &Pubkey,
        position: &Pubkey,
        owner: &Pubkey,
        seq: u16,
        rent_payer: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            ::thesis::id(),
            &::thesis::instruction::SettlePart {}.data(),
            ::thesis::accounts::SettlePart {
                event_authority: event_authority_pda(),
                program: ::thesis::id(),
                config: config_pda(),
                take: *take,
                position: *position,
                owner_profile: profile_pda(owner),
                part_sale: part_sale_pda(position, seq),
                rent_payer: *rent_payer,
            }
            .to_account_metas(None),
        )
    }

    /// Settles partial sale `seq`, its rent back to the app's fee payer (who paid it in `sell_part`).
    pub fn settle_part(
        &mut self,
        take: &Pubkey,
        position: &Pubkey,
        owner: &Pubkey,
        seq: u16,
    ) -> TxResult {
        let payer = self.app_payer.pubkey();
        let ix = self.settle_part_ix(take, position, owner, seq, &payer);
        self.crank(ix)
    }

    /// Sends one instruction paid for and signed by the admin (any funded key works for cranks).
    pub fn crank(&mut self, ix: Instruction) -> TxResult {
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&admin])
    }

    // Common flows

    /// A take whose author bought every leg (set `legs_mask` to leave legs out).
    pub fn take_args(&self, id: u64, legs: Vec<LegSpec>, stake: u64) -> CreateTakeArgs {
        CreateTakeArgs {
            id,
            claim_hash: [9; 32],
            risk: Risk::Medium,
            horizon_end: NOW + 30 * DAY,
            legs_mask: ((1u32 << legs.len()) - 1) as u16,
            legs,
            stake,
            inverted: false,
        }
    }

    /// `take_args` for a take that bets against its basket: the author's buy-in is a fade.
    pub fn inverted_take_args(&self, id: u64, legs: Vec<LegSpec>, stake: u64) -> CreateTakeArgs {
        CreateTakeArgs {
            inverted: true,
            ..self.take_args(id, legs, stake)
        }
    }

    /// `create_take`, returning the transaction's result instead of expecting success.
    pub fn try_create_take(&mut self, author: &User, args: CreateTakeArgs) -> TxResult {
        let ixs = self.create_take_ix(author, &author.pubkey(), args);
        self.send(&ixs, &[&author.key])
    }

    /// Creates a take paid for by the author; returns its address.
    pub fn create_take(&mut self, author: &User, args: CreateTakeArgs) -> Pubkey {
        let take = take_pda(&author.pubkey(), args.id);
        let ixs = self.create_take_ix(author, &author.pubkey(), args);
        self.send(&ixs, &[&author.key]).expect("create_take");
        take
    }

    pub fn open_position(
        &mut self,
        side: Side,
        owner: &User,
        take: &Pubkey,
        args: OpenPositionArgs,
    ) -> TxResult {
        let ixs = self.open_position_ix(side, owner, &owner.pubkey(), take, args);
        self.send(&ixs, &[&owner.key])
    }
}

// Badges

pub use anchor_spl::associated_token::get_associated_token_address_with_program_id;

pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::spl_token_2022::ID;

pub fn badge_mint(owner: &Pubkey, kind: BadgeKind) -> Pubkey {
    pda(&[BADGE_SEED, owner.as_ref(), &[kind as u8]])
}

pub fn badge_ata(owner: &Pubkey, kind: BadgeKind) -> Pubkey {
    get_associated_token_address_with_program_id(owner, &badge_mint(owner, kind), &TOKEN_2022)
}

pub fn mint_badge_ix(env: &Env, owner: &Pubkey, kind: BadgeKind, ata: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ::thesis::id(),
        &::thesis::instruction::MintBadge { kind }.data(),
        ::thesis::accounts::MintBadge {
            event_authority: event_authority_pda(),
            program: ::thesis::id(),
            payer: env.app_payer.pubkey(),
            config: config_pda(),
            owner: *owner,
            owner_profile: profile_pda(owner),
            badge_mint: badge_mint(owner, kind),
            owner_badge_account: ata,
            token_2022_program: TOKEN_2022,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// Mints a badge, paid for by the app's fee payer.
pub fn mint_badge(env: &mut Env, owner: &Pubkey, kind: BadgeKind) -> TxResult {
    let ix = mint_badge_ix(env, owner, kind, badge_ata(owner, kind));
    let payer = env.app_payer.insecure_clone();
    env.send(&[ix], &[&payer])
}

/// Compute each Thesis instruction in a transaction used, in order (from the runtime's logs).
/// Compute used by each top-level Thesis instruction, in order. Counts only frames at depth 1:
/// the program's events are self-CPIs (`emit_cpi!`), whose own "consumed" lines are nested.
pub fn thesis_units(meta: &TransactionMetadata) -> Vec<u64> {
    let id = ::thesis::id().to_string();
    let consumed = format!("Program {id} consumed ");
    let mut depth = 0usize;
    let mut out = Vec::new();
    for l in &meta.logs {
        if l.starts_with("Program ") && l.contains(" invoke [") {
            depth += 1;
        } else if let Some(rest) = l.strip_prefix(&consumed) {
            if depth == 1 {
                out.push(rest.split(' ').next().unwrap().parse().unwrap());
            }
        } else if l.starts_with("Program ") && (l.ends_with(" success") || l.contains(" failed")) {
            depth = depth.saturating_sub(1);
        }
    }
    out
}

pub fn assert_error(result: TxResult, name: &str) {
    let failed = result.expect_err(&format!("expected {name}"));
    let needle = format!("Error Code: {name}.");
    assert!(
        failed.meta.logs.iter().any(|l| l.contains(&needle)),
        "expected {name}, got logs: {:#?}",
        failed.meta.logs
    );
}

// Raw SPL Token layouts, so tests need no extra token crates.

fn mint_data(authority: &Pubkey, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[44] = decimals;
    d[45] = 1;
    d
}

fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}
