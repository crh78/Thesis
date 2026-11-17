//! Proof of trade: the checks that a receipt's stake was really traded.
//!
//! A trade runs in one or more transactions, each a *bracket*: an opening instruction
//! (`begin_trade` in the first transaction, `trade_step` with `open` in later ones), the owner's
//! venue instructions, and a closing one (`trade_step` without `open`, or the receipt in the last
//! transaction). When a bracket opens, it reads the rest of its transaction from the Instructions
//! sysvar: every instruction up to the first Thesis instruction after it must come from the
//! config's `trade_programs`, and that Thesis instruction must close this ticket's bracket. The
//! opening saves the owner's USDC balance and the watched output balances; the closing adds what
//! changed in between to the ticket. Nothing outside a bracket counts, so a plain transfer can't
//! pose as a trade, in the same transaction or between the trade's transactions.
//!
//! Every bracket instruction must be called by the transaction itself, not through another
//! program: a CPI would let a caller run instructions the sysvar doesn't show.

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    Discriminator,
};

use crate::{constants::MAX_LEGS, error::ThesisError, events::TradeProved, state::*};

pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

/// Phoenix perps (Ellipsis Labs): perp legs and the shorts that fade stock and crypto legs.
pub const PHOENIX_PROGRAM_ID: Pubkey = pubkey!("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
/// Ember: converts USDC to Phoenix's dollar token (PhUSD) and back.
pub const EMBER_PROGRAM_ID: Pubkey = pubkey!("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");

/// Phoenix instructions that may run inside a bracket (`sha256("global:<name>")[..8]`): what a
/// perp leg's trade needs, and nothing that moves collateral out of the owner's trader accounts
/// (withdrawals, collateral transfers, escrow requests).
const PHOENIX_TRADE_INSTRUCTIONS: [[u8; 8]; 4] = [
    [202, 39, 52, 211, 53, 20, 250, 88],   // deposit_funds
    [90, 118, 192, 252, 192, 99, 39, 145], // place_market_order
    [75, 243, 224, 167, 1, 5, 51, 32],     // register_trader
    [175, 137, 217, 11, 235, 39, 150, 19], // sync_parent_to_child
];
/// Ember's `deposit` (USDC in, PhUSD out). Its `withdraw` can't run inside a bracket.
const EMBER_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];

/// A Phoenix trader account (`sha256("account:trader")[..8]`, then a 16-byte sequence number,
/// its own key, its authority, ...; positions start at `TRADER_ENTRIES`). Checked against
/// Phoenix's SDK (`@ellipsis-labs/rise` 0.8.2, `accounts/Trader/codec.ts`) and live accounts.
pub const PHOENIX_TRADER_DISCRIMINATOR: [u8; 8] = [41, 97, 73, 105, 110, 214, 112, 9];
const TRADER_AUTHORITY: usize = 56;
/// `len: u64`, `capacity: u64`, then `len` entries of 40 bytes: an asset index (`u64`, low 32
/// bits), then the position's base lots (`i64`) and 24 more bytes.
const TRADER_ENTRIES: usize = 224;
const TRADER_ENTRY_LEN: usize = 40;
/// Asset indexes at or above this are spot collateral (native SOL, other tokens), not perps.
const PERP_ASSET_INDEX_BOUND: u64 = 0xff00_0000;

/// Where the ticket sits in each bracket instruction's accounts (the order of the fields in its
/// `Accounts` struct; `test_interface.rs` checks these).
pub const BEGIN_TRADE_TICKET_INDEX: usize = 4;
pub const TRADE_STEP_TICKET_INDEX: usize = 2;
pub const CREATE_TAKE_TICKET_INDEX: usize = 11;
pub const OPEN_POSITION_TICKET_INDEX: usize = 12;

/// Programs that can never be on the trade allowlist: with them, the stake could leave in a plain
/// transfer, or a Thesis instruction could run unchecked inside a bracket.
pub fn forbidden_trade_program(program: &Pubkey) -> bool {
    *program == anchor_spl::token::ID
        || *program == anchor_spl::token_2022::ID
        || *program == anchor_lang::system_program::ID
        || *program == crate::ID
}

/// Instructions of an allowed program that still can't run inside a bracket. Associated Token:
/// only `Create` (empty data or 0) and `CreateIdempotent` (1); `RecoverNested` (2) moves a nested
/// account's tokens into the wallet's own account, which would count as bought (security review
/// H-2).
///
/// Phoenix: only `PHOENIX_TRADE_INSTRUCTIONS`. Ember: only `deposit`. A withdrawal or collateral
/// transfer inside a bracket could take the stake back out after it counted as spent.
pub fn allowed_instruction(program: &[u8], data: &[u8]) -> bool {
    if program == anchor_spl::associated_token::ID.as_ref() {
        return matches!(data.first(), None | Some(0) | Some(1));
    }
    let disc = data.get(..8);
    if program == PHOENIX_PROGRAM_ID.as_ref() {
        return disc.is_some_and(|d| PHOENIX_TRADE_INSTRUCTIONS.iter().any(|a| a == d));
    }
    if program == EMBER_PROGRAM_ID.as_ref() {
        return disc == Some(&EMBER_DEPOSIT[..]);
    }
    true
}

/// A zero-copy view of the Instructions sysvar: the transaction's top-level instructions, as
/// serialized by the runtime (`u16` count, `u16` offsets, then per instruction: `u16` account
/// count, `[flags, pubkey]` per account, the program id, `u16` data length, data; the current
/// instruction's index is the last two bytes).
struct TxInstructions<'a> {
    data: &'a [u8],
}

impl<'a> TxInstructions<'a> {
    fn u16_at(&self, at: usize) -> Result<usize> {
        let b = self
            .data
            .get(at..at + 2)
            .ok_or(ProgramError::InvalidAccountData)?;
        Ok(u16::from_le_bytes([b[0], b[1]]) as usize)
    }

    fn bytes(&self, at: usize, len: usize) -> Result<&'a [u8]> {
        Ok(self
            .data
            .get(at..at + len)
            .ok_or(ProgramError::InvalidAccountData)?)
    }

    fn len(&self) -> Result<usize> {
        self.u16_at(0)
    }

    fn current(&self) -> Result<usize> {
        let end = self
            .data
            .len()
            .checked_sub(2)
            .ok_or(ProgramError::InvalidAccountData)?;
        self.u16_at(end)
    }

    /// Offset of instruction `i` and its account count.
    fn header(&self, i: usize) -> Result<(usize, usize)> {
        require!(i < self.len()?, ThesisError::InvalidInstructionsSysvar);
        let start = self.u16_at(2 + 2 * i)?;
        Ok((start, self.u16_at(start)?))
    }

    fn program_id(&self, i: usize) -> Result<&'a [u8]> {
        let (start, accounts) = self.header(i)?;
        self.bytes(start + 2 + 33 * accounts, 32)
    }

    fn account(&self, i: usize, j: usize) -> Result<Option<&'a [u8]>> {
        let (start, accounts) = self.header(i)?;
        if j >= accounts {
            return Ok(None);
        }
        Ok(Some(self.bytes(start + 2 + 33 * j + 1, 32)?))
    }

    fn data(&self, i: usize) -> Result<&'a [u8]> {
        let (start, accounts) = self.header(i)?;
        let at = start + 2 + 33 * accounts + 32;
        let len = self.u16_at(at)?;
        self.bytes(at + 2, len)
    }

    /// What a Thesis instruction does to a bracket, and where its ticket account is.
    fn role(&self, i: usize) -> Result<Option<(Role, usize)>> {
        let data = self.data(i)?;
        let Some(disc) = data.get(..8) else {
            return Ok(None);
        };
        let role = if disc == crate::instruction::BeginTrade::DISCRIMINATOR {
            (Role::Open, BEGIN_TRADE_TICKET_INDEX)
        } else if disc == crate::instruction::TradeStep::DISCRIMINATOR {
            // `TradeStepArgs { open: bool, .. }`: the flag is the first byte after the discriminator.
            match data.get(8) {
                Some(1) => (Role::Open, TRADE_STEP_TICKET_INDEX),
                Some(0) => (Role::Close, TRADE_STEP_TICKET_INDEX),
                _ => return Ok(None),
            }
        } else if disc == crate::instruction::Back::DISCRIMINATOR
            || disc == crate::instruction::Fade::DISCRIMINATOR
        {
            (Role::Close, OPEN_POSITION_TICKET_INDEX)
        } else if disc == crate::instruction::CreateTake::DISCRIMINATOR {
            (Role::Close, CREATE_TAKE_TICKET_INDEX)
        } else {
            return Ok(None);
        };
        Ok(Some(role))
    }

    fn names_ticket(&self, i: usize, index: usize, ticket: &Pubkey) -> Result<bool> {
        Ok(self.account(i, index)? == Some(ticket.as_ref()))
    }
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Role {
    Open,
    Close,
}

fn require_top_level() -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        ThesisError::NotTopLevel
    );
    Ok(())
}

fn with_instructions<T>(
    sysvar: &AccountInfo,
    f: impl FnOnce(&TxInstructions) -> Result<T>,
) -> Result<T> {
    require_keys_eq!(
        sysvar.key(),
        INSTRUCTIONS_SYSVAR_ID,
        ThesisError::InvalidInstructionsSysvar
    );
    let data = sysvar.try_borrow_data()?;
    f(&TxInstructions { data: &data })
}

/// What an output account holds, after checking it belongs to `owner`: a token account's
/// balance (never USDC), or a Phoenix trader account's total perp position size, in base lots
/// (`phoenix_position_size`). An account that doesn't exist yet (an output the trade's own
/// instructions will create) has 0. Also says which of the two it is.
fn output_balance(
    account: &AccountInfo,
    owner: &Pubkey,
    usdc_mint: &Pubkey,
    may_be_missing: bool,
) -> Result<(u64, bool)> {
    if may_be_missing && account.lamports() == 0 && account.data_is_empty() {
        // Only Phoenix's own instructions or Associated Token can create it inside the bracket;
        // the closing read decides which kind it is.
        return Ok((0, false));
    }
    if *account.owner == PHOENIX_PROGRAM_ID {
        let data = account.try_borrow_data()?;
        return Ok((phoenix_position_size(&data, owner)?, true));
    }
    require!(
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID,
        ThesisError::InvalidOutputAccount
    );
    let data = account.try_borrow_data()?;
    // SPL token account layout: mint (0..32), owner (32..64), amount (64..72), state (108).
    require!(
        data.len() >= 165
            && &data[32..64] == owner.as_ref()
            && &data[0..32] != usdc_mint.as_ref()
            && data[108] == 1,
        ThesisError::InvalidOutputAccount
    );
    Ok((u64::from_le_bytes(data[64..72].try_into().unwrap()), false))
}

/// A Phoenix trader account's perp positions, summed as absolute base lots (a long and a short
/// both count as size), after checking it's a trader account whose authority is `owner`.
/// Thesis gives each perp leg its own isolated subaccount, so this is that leg's position. Which
/// market and which side are the settler's checks, as for spot legs' tokens.
pub fn phoenix_position_size(data: &[u8], owner: &Pubkey) -> Result<u64> {
    require!(
        data.len() >= TRADER_ENTRIES + 16
            && data[..8] == PHOENIX_TRADER_DISCRIMINATOR
            && &data[TRADER_AUTHORITY..TRADER_AUTHORITY + 32] == owner.as_ref(),
        ThesisError::InvalidOutputAccount
    );
    let len = u64::from_le_bytes(data[TRADER_ENTRIES..TRADER_ENTRIES + 8].try_into().unwrap());
    let start = TRADER_ENTRIES + 16;
    let fit = ((data.len() - start) / TRADER_ENTRY_LEN) as u64;
    let mut size: u64 = 0;
    for i in 0..len.min(fit) as usize {
        let at = start + i * TRADER_ENTRY_LEN;
        let asset = u64::from_le_bytes(data[at..at + 8].try_into().unwrap()) & 0xffff_ffff;
        if asset >= PERP_ASSET_INDEX_BOUND {
            continue;
        }
        let base = i64::from_le_bytes(data[at + 8..at + 16].try_into().unwrap());
        size = size
            .checked_add(base.unsigned_abs())
            .ok_or(ThesisError::MathOverflow)?;
    }
    Ok(size)
}

fn mask_bits(mask: u16) -> impl Iterator<Item = usize> {
    (0..MAX_LEGS).filter(move |i| mask & (1 << i) != 0)
}

/// Opens a bracket at the current instruction. `outputs` are the accounts for the legs in
/// `outputs_mask`, in leg order.
pub fn open_bracket(
    ticket: &mut TradeTicket,
    ticket_key: &Pubkey,
    sysvar: &AccountInfo,
    config: &Config,
    usdc_balance: u64,
    outputs_mask: u16,
    outputs: &[AccountInfo],
) -> Result<()> {
    require_top_level()?;
    require!(
        ticket.open_ix == TradeTicket::NO_BRACKET,
        ThesisError::BracketAlreadyOpen
    );
    let current = with_instructions(sysvar, |ixs| {
        let current = ixs.current()?;
        let mut closed = false;
        for j in current + 1..ixs.len()? {
            let program = ixs.program_id(j)?;
            if program == crate::ID.as_ref() {
                // The first Thesis instruction after this one must close this ticket's bracket.
                closed = matches!(ixs.role(j)?, Some((Role::Close, at)) if ixs.names_ticket(j, at, ticket_key)?);
                break;
            }
            require!(
                config.trade_programs.iter().any(|p| p.as_ref() == program),
                ThesisError::TradeProgramNotAllowed
            );
            require!(
                allowed_instruction(program, ixs.data(j)?),
                ThesisError::TradeInstructionNotAllowed
            );
        }
        require!(closed, ThesisError::BracketNotClosed);
        Ok(current)
    })?;

    require!(
        (outputs_mask as u32) >> MAX_LEGS == 0
            && outputs.len() == outputs_mask.count_ones() as usize,
        ThesisError::OutputMismatch
    );
    for (i, account) in mask_bits(outputs_mask).zip(outputs) {
        let bit = 1u16 << i;
        if ticket.named & bit != 0 {
            require_keys_eq!(
                ticket.outputs[i],
                account.key(),
                ThesisError::OutputMismatch
            );
        } else {
            // One account per leg: a single token account can't stand in for two legs.
            require!(
                mask_bits(ticket.named).all(|k| ticket.outputs[k] != account.key()),
                ThesisError::OutputMismatch
            );
            ticket.outputs[i] = account.key();
            ticket.named |= bit;
        }
        let (balance, phoenix) = output_balance(account, &ticket.owner, &config.usdc_mint, true)?;
        ticket.outputs_start[i] = balance;
        if phoenix {
            ticket.phoenix |= bit;
        }
    }
    ticket.usdc_start = usdc_balance;
    ticket.open_mask = outputs_mask;
    ticket.open_ix = current as u16;
    Ok(())
}

/// Closes the bracket opened earlier in this transaction, adding what it spent and grew.
/// `outputs` are the accounts for the legs the bracket opened with, in leg order.
pub fn close_bracket(
    ticket: &mut TradeTicket,
    ticket_key: &Pubkey,
    sysvar: &AccountInfo,
    usdc_mint: &Pubkey,
    usdc_balance: u64,
    outputs: &[AccountInfo],
) -> Result<()> {
    require_top_level()?;
    let open = ticket.open_ix as usize;
    require!(
        ticket.open_ix != TradeTicket::NO_BRACKET,
        ThesisError::NoOpenBracket
    );
    // The opening instruction must be earlier in *this* transaction. It ran (it's earlier), so
    // it set `open_ix` itself; a bracket left open by another transaction can't match.
    with_instructions(sysvar, |ixs| {
        let opened_here = open < ixs.current()?
            && ixs.program_id(open)? == crate::ID.as_ref()
            && matches!(ixs.role(open)?, Some((Role::Open, at)) if ixs.names_ticket(open, at, ticket_key)?);
        require!(opened_here, ThesisError::NoOpenBracket);
        Ok(())
    })?;

    require!(
        outputs.len() == ticket.open_mask.count_ones() as usize,
        ThesisError::OutputMismatch
    );
    for (i, account) in mask_bits(ticket.open_mask).zip(outputs) {
        require_keys_eq!(
            ticket.outputs[i],
            account.key(),
            ThesisError::OutputMismatch
        );
        let (now, phoenix) = output_balance(account, &ticket.owner, usdc_mint, false)?;
        // An account's kind can't change between brackets (one created inside this bracket
        // gets its kind here).
        let bit = 1u16 << i;
        require!(
            phoenix || ticket.phoenix & bit == 0,
            ThesisError::InvalidOutputAccount
        );
        if phoenix {
            ticket.phoenix |= bit;
        }
        if now > ticket.outputs_start[i] {
            ticket.grown |= 1 << i;
            ticket.received[i] = ticket.received[i]
                .checked_add(now - ticket.outputs_start[i])
                .ok_or(ThesisError::MathOverflow)?;
        }
    }
    // Net USDC out of the owner's account inside the bracket.
    ticket.spent = if usdc_balance <= ticket.usdc_start {
        ticket
            .spent
            .checked_add(ticket.usdc_start - usdc_balance)
            .ok_or(ThesisError::MathOverflow)?
    } else {
        ticket
            .spent
            .saturating_sub(usdc_balance - ticket.usdc_start)
    };
    ticket.open_ix = TradeTicket::NO_BRACKET;
    ticket.open_mask = 0;
    Ok(())
}

/// Legs whose output account must have grown, and of which kind. A back's spot and yield legs
/// need a token account of the owner (spot tokens, Jupiter Lend shares); its perp legs need a
/// Phoenix trader account of the owner. A fade's legs shorted on Phoenix (`PhoenixShort`) need a
/// Phoenix trader account too. Prediction and card legs need nothing: their share is escrowed
/// (`LegKind::is_escrowed`; cards too, since a card NFT can't be proved as a token
/// account: Core assets aren't one, and pNFT accounts are always frozen).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Required {
    pub tokens: u16,
    pub phoenix: u16,
}

impl Required {
    pub fn all(self) -> u16 {
        self.tokens | self.phoenix
    }
}

pub fn required_outputs(legs: &[LegSpec], legs_mask: u16, side: Side) -> Required {
    let mut r = Required::default();
    for (i, leg) in legs.iter().enumerate() {
        if legs_mask & (1 << i) == 0 {
            continue;
        }
        match (side, leg.kind, leg.fade_via) {
            (Side::Back, LegKind::Spot | LegKind::Yield, _) => r.tokens |= 1 << i,
            (Side::Back, LegKind::Perp, _) => r.phoenix |= 1 << i,
            (Side::Fade, _, FadeVia::PhoenixShort) => r.phoenix |= 1 << i,
            _ => {}
        }
    }
    r
}

/// The receipt's final check, after closing the last bracket. Returns what the proof measured, for
/// the receipt to emit (`emit_cpi!` needs the receipt's accounts).
pub fn finish_trade(ticket: &TradeTicket, stake: u64, required: Required) -> Result<TradeProved> {
    require!(ticket.spent >= stake, ThesisError::StakeNotSpent);
    require!(
        ticket.grown & required.all() == required.all(),
        ThesisError::OutputNotBought
    );
    // A token leg can't be "bought" as a Phoenix position, nor a Phoenix leg as a token.
    require!(
        ticket.phoenix & required.phoenix == required.phoenix
            && ticket.phoenix & required.tokens == 0,
        ThesisError::InvalidOutputAccount
    );
    Ok(TradeProved {
        position: ticket.position,
        owner: ticket.owner,
        spent: ticket.spent,
        outputs_mask: ticket.named,
        outputs: mask_bits(ticket.named).map(|i| ticket.outputs[i]).collect(),
        received: mask_bits(ticket.named)
            .map(|i| ticket.received[i])
            .collect(),
    })
}

/// Property tests for the Instructions sysvar parser (`proptest`; `PROPTEST_CASES` runs more
/// cases): it reads back exactly what the runtime serializes, and never panics on other bytes.
#[cfg(test)]
mod props {
    use super::*;
    use anchor_lang::solana_program::sysvar::instructions::{
        construct_instructions_data, BorrowedAccountMeta, BorrowedInstruction,
    };
    use proptest::prelude::*;

    type GenIx = (u8, Vec<(u8, bool, bool)>, Vec<u8>);

    fn ixs() -> impl Strategy<Value = Vec<GenIx>> {
        prop::collection::vec(
            (
                any::<u8>(),
                prop::collection::vec((any::<u8>(), any::<bool>(), any::<bool>()), 0..12),
                prop::collection::vec(any::<u8>(), 0..64),
            ),
            1..10,
        )
    }

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    proptest! {
        #[test]
        fn reads_back_what_the_runtime_writes(gen in ixs(), current in any::<u16>()) {
            let keys: Vec<(Pubkey, Vec<Pubkey>)> = gen
                .iter()
                .map(|(p, accs, _)| (key(*p), accs.iter().map(|(a, _, _)| key(*a)).collect()))
                .collect();
            let borrowed: Vec<BorrowedInstruction> = gen
                .iter()
                .zip(&keys)
                .map(|((_, accs, data), (program, ks))| BorrowedInstruction {
                    program_id: program,
                    accounts: accs
                        .iter()
                        .zip(ks)
                        .map(|((_, s, w), k)| BorrowedAccountMeta { pubkey: k, is_signer: *s, is_writable: *w })
                        .collect(),
                    data,
                })
                .collect();
            let mut bytes = construct_instructions_data(&borrowed);
            let current = current as usize % gen.len();
            let at = bytes.len() - 2;
            bytes[at..].copy_from_slice(&(current as u16).to_le_bytes());
            let t = TxInstructions { data: &bytes };

            prop_assert_eq!(t.len().unwrap(), gen.len());
            prop_assert_eq!(t.current().unwrap(), current);
            for (i, ((_, accs, data), (program, ks))) in gen.iter().zip(&keys).enumerate() {
                prop_assert_eq!(t.program_id(i).unwrap(), program.as_ref());
                prop_assert_eq!(t.data(i).unwrap(), data.as_slice());
                for (j, k) in ks.iter().enumerate() {
                    prop_assert_eq!(t.account(i, j).unwrap(), Some(k.as_ref()));
                }
                prop_assert_eq!(t.account(i, accs.len()).unwrap(), None);
            }
            prop_assert!(t.program_id(gen.len()).is_err());
        }

        /// A Phoenix trader account's position size: any bytes give a size or an error, never a
        /// panic, and the owner check always holds.
        #[test]
        fn phoenix_size_never_panics(mut bytes in prop::collection::vec(any::<u8>(), 0..700), header in any::<bool>(), len in 0u64..40) {
            let owner = key(7);
            if header && bytes.len() >= TRADER_ENTRIES + 16 {
                bytes[..8].copy_from_slice(&PHOENIX_TRADER_DISCRIMINATOR);
                bytes[TRADER_AUTHORITY..TRADER_AUTHORITY + 32].copy_from_slice(owner.as_ref());
                bytes[TRADER_ENTRIES..TRADER_ENTRIES + 8].copy_from_slice(&len.to_le_bytes());
            }
            if phoenix_position_size(&bytes, &owner).is_ok() {
                prop_assert_eq!(&bytes[TRADER_AUTHORITY..TRADER_AUTHORITY + 32], owner.as_ref());
            }
            prop_assert!(phoenix_position_size(&bytes, &key(8)).is_err() || bytes[TRADER_AUTHORITY..TRADER_AUTHORITY + 32] == *key(8).as_ref());
        }

        /// Arbitrary or truncated bytes give errors, never a panic or an out-of-bounds read.
        #[test]
        fn never_panics_on_bad_bytes(bytes in prop::collection::vec(any::<u8>(), 0..600), i in 0usize..20, j in 0usize..40, cut in any::<usize>()) {
            let cut = if bytes.is_empty() { 0 } else { cut % bytes.len() };
            for data in [&bytes[..], &bytes[..cut]] {
                let t = TxInstructions { data };
                let _ = t.len();
                let _ = t.current();
                let _ = t.program_id(i);
                let _ = t.account(i, j);
                let _ = t.data(i);
                let _ = t.role(i);
                let _ = t.names_ticket(i, j, &Pubkey::default());
            }
        }
    }
}
