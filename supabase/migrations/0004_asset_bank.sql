-- Asset bank: what the AI may put in a basket, refreshed by the executor's
-- asset-bank poller (apps/executor/src/asset-bank.ts, packages/venues/bank).
--
--   asset_bank_underlyings  one row per underlying (equity:US:NVDA, commodity:XAU, ...).
--                           id_hex is sha256('thesis:underlying:v1:' || key): the program's
--                           LegSpec.asset for spot legs.
--   asset_bank_tokens       one row per issuer token (NVDAx, NVDAon, Backpack NVDA, ...).
--   asset_bank_venues       venue snapshots (phoenix, gemini, cards, yield) and poller metadata.
--
-- `data` holds the poller's full entry; the other columns are copies for filtering
-- and indexing. Only the service role reads or writes these tables.

create table public.asset_bank_underlyings (
  key           text primary key,
  id_hex        char(64) not null unique,
  class         text not null check (class in ('equity', 'etf', 'commodity', 'private', 'crypto', 'token')),
  code          text not null,
  name          text not null,
  themes        text[] not null default '{}',
  best_mint     text,
  ref_price_usd double precision,
  updated_at    timestamptz not null default now(),
  data          jsonb not null,

  constraint asset_bank_underlyings_id_hex check (id_hex ~ '^[0-9a-f]{64}$')
);

create table public.asset_bank_tokens (
  mint              text primary key,
  underlying_key    text not null references public.asset_bank_underlyings (key) on delete cascade,
  symbol            text not null,
  issuer_tag        text,
  -- tradeable | thin | no-route | unprobed | paused | excluded
  class             text not null,
  -- false when the units-per-token ratio is unknown: never chosen over a comparable issuer
  comparable        boolean not null,
  -- no | unverified | yes
  us_persons        text not null,
  price_usd         double precision,
  priced_at         timestamptz,
  probed_at         timestamptz,
  units_per_usd_100 double precision,
  cost_100_pct      double precision,
  updated_at        timestamptz not null default now(),
  data              jsonb not null
);

create index asset_bank_tokens_underlying_idx on public.asset_bank_tokens (underlying_key);
create index asset_bank_tokens_tradeable_idx on public.asset_bank_tokens (underlying_key) where class = 'tradeable';
create index asset_bank_underlyings_themes_idx on public.asset_bank_underlyings using gin (themes);

create table public.asset_bank_venues (
  venue        text primary key,
  refreshed_at timestamptz,
  updated_at   timestamptz not null default now(),
  data         jsonb not null
);

alter table public.asset_bank_underlyings enable row level security;
alter table public.asset_bank_tokens enable row level security;
alter table public.asset_bank_venues enable row level security;

revoke all on public.asset_bank_underlyings, public.asset_bank_tokens, public.asset_bank_venues from anon, authenticated;
grant select, insert, update, delete on public.asset_bank_underlyings, public.asset_bank_tokens, public.asset_bank_venues to service_role;
