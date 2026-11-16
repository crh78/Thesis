use anchor_lang::{
    error::ErrorCode as AnchorError,
    prelude::*,
    system_program::{self, Allocate, Assign, CreateAccount, Transfer},
};
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
    token_2022::{
        self,
        spl_token_2022::{
            extension::ExtensionType, instruction::AuthorityType, state::Mint as MintState,
        },
        InitializeMint2, MintTo, SetAuthority, Token2022,
    },
    token_2022_extensions::{
        metadata_pointer_initialize, non_transferable_mint_initialize,
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize,
        MetadataPointerInitialize, NonTransferableMintInitialize, TokenMetadataInitialize,
    },
};

use crate::{constants::*, error::ThesisError, events::BadgeMinted, state::*};

/// Mints one badge from the catalog to a user who has earned it: a Token-2022 mint with the
/// NonTransferable and metadata extensions, supply 1, at `[BADGE_SEED, owner, kind]`, so each
/// badge exists at most once per user. Anyone can call it and pays the rent.
#[event_cpi]
#[derive(Accounts)]
#[instruction(kind: BadgeKind)]
pub struct MintBadge<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub config: Account<'info, Config>,
    pub owner: SystemAccount<'info>,
    #[account(mut, has_one = owner @ ThesisError::AccountMismatch)]
    pub owner_profile: Account<'info, Profile>,
    /// CHECK: created in the handler with Token-2022 extensions, at `[BADGE_SEED, owner, kind]`.
    #[account(mut, seeds = [BADGE_SEED, owner.key().as_ref(), &[kind as u8]], bump)]
    pub badge_mint: UncheckedAccount<'info>,
    /// CHECK: the owner's associated Token-2022 account for `badge_mint`, created in the handler.
    #[account(mut)]
    pub owner_badge_account: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Metadata URI for a badge kind, under the config's `badge_uri_base`.
pub fn badge_uri(base: &str, kind: BadgeKind) -> String {
    format!("{base}{}.json", kind.slug())
}

pub fn handle_mint_badge(ctx: Context<MintBadge>, kind: BadgeKind) -> Result<()> {
    require!(
        kind.earned(&ctx.accounts.owner_profile),
        ThesisError::BadgeNotEarned
    );

    let owner_key = ctx.accounts.owner.key();
    let mint_key = ctx.accounts.badge_mint.key();
    let token_program_key = ctx.accounts.token_2022_program.key();
    require_keys_eq!(
        ctx.accounts.owner_badge_account.key(),
        get_associated_token_address_with_program_id(&owner_key, &mint_key, &token_program_key),
        AnchorError::AccountNotAssociatedTokenAccount
    );

    let bump = [ctx.bumps.badge_mint];
    let kind_seed = [kind as u8];
    let mint_seeds: &[&[u8]] = &[BADGE_SEED, owner_key.as_ref(), &kind_seed, &bump];
    let signer: &[&[&[u8]]] = &[mint_seeds];

    let payer = ctx.accounts.payer.to_account_info();
    let mint = ctx.accounts.badge_mint.to_account_info();
    let token_program = ctx.accounts.token_2022_program.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();

    // Metadata is stored in the mint itself; the badge mint PDA is its own update authority, so
    // only this program can ever change it (e.g. once the URI domain is decided).
    // Name, symbol and URI only: the kind is in the name and URI (and the mint's seeds), and the
    // holder can't change because the token can't move, so extra fields would only add rent.
    let name = kind.name().to_string();
    let uri = badge_uri(&ctx.accounts.config.badge_uri_base, kind);
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(mint_key))?,
        mint: mint_key,
        name: name.clone(),
        symbol: BADGE_SYMBOL.to_string(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };

    // The account is allocated for the fixed-size extensions only: Token-2022 requires that at
    // `initialize_mint2`. The metadata TLV is appended by Token-2022 reallocating the account,
    // which doesn't move lamports, so the rent for the final size is paid up front.
    let fixed_len = ExtensionType::try_calculate_account_len::<MintState>(&[
        ExtensionType::NonTransferable,
        ExtensionType::MetadataPointer,
    ])?;
    let final_len = fixed_len
        .checked_add(metadata.tlv_size_of()?)
        .ok_or(ThesisError::MathOverflow)?;
    let rent = Rent::get()?.minimum_balance(final_len);

    // A second call for the same badge fails here: the mint already exists.
    if mint.owner != &System::id() || !mint.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized.into());
    }
    let current = mint.lamports();
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                System::id(),
                CreateAccount {
                    from: payer.clone(),
                    to: mint.clone(),
                },
                signer,
            ),
            rent,
            fixed_len as u64,
            &token_program_key,
        )?;
    } else {
        // Someone sent lamports to the address first; `create_account` would refuse it.
        let top_up = rent.saturating_sub(current);
        if top_up > 0 {
            system_program::transfer(
                CpiContext::new(
                    System::id(),
                    Transfer {
                        from: payer.clone(),
                        to: mint.clone(),
                    },
                ),
                top_up,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                System::id(),
                Allocate {
                    account_to_allocate: mint.clone(),
                },
                signer,
            ),
            fixed_len as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                System::id(),
                Assign {
                    account_to_assign: mint.clone(),
                },
                signer,
            ),
            &token_program_key,
        )?;
    }

    // Layout-changing extensions go before `initialize_mint2`.
    non_transferable_mint_initialize(CpiContext::new(
        token_program_key,
        NonTransferableMintInitialize {
            token_program_id: token_program.clone(),
            mint: mint.clone(),
        },
    ))?;
    metadata_pointer_initialize(
        CpiContext::new(
            token_program_key,
            MetadataPointerInitialize {
                token_program_id: token_program.clone(),
                mint: mint.clone(),
            },
        ),
        Some(mint_key),
        Some(mint_key),
    )?;
    token_2022::initialize_mint2(
        CpiContext::new(token_program_key, InitializeMint2 { mint: mint.clone() }),
        0,
        &mint_key,
        None,
    )?;

    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program_key,
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                metadata: mint.clone(),
                update_authority: mint.clone(),
                mint_authority: mint.clone(),
                mint: mint.clone(),
            },
            signer,
        ),
        name,
        BADGE_SYMBOL.to_string(),
        uri,
    )?;

    let owner_badge_account = ctx.accounts.owner_badge_account.to_account_info();
    associated_token::create(CpiContext::new(
        ctx.accounts.associated_token_program.key(),
        associated_token::Create {
            payer,
            associated_token: owner_badge_account.clone(),
            authority: ctx.accounts.owner.to_account_info(),
            mint: mint.clone(),
            system_program: system,
            token_program: token_program.clone(),
        },
    ))?;

    token_2022::mint_to(
        CpiContext::new_with_signer(
            token_program_key,
            MintTo {
                mint: mint.clone(),
                to: owner_badge_account,
                authority: mint.clone(),
            },
            signer,
        ),
        1,
    )?;
    // No mint authority left, so the supply stays 1 forever.
    token_2022::set_authority(
        CpiContext::new_with_signer(
            token_program_key,
            SetAuthority {
                current_authority: mint.clone(),
                account_or_mint: mint,
            },
            signer,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    let profile = &mut ctx.accounts.owner_profile;
    profile.badges = profile
        .badges
        .checked_add(1)
        .ok_or(ThesisError::MathOverflow)?;

    emit_cpi!(BadgeMinted {
        owner: owner_key,
        kind,
        mint: mint_key,
    });
    Ok(())
}
