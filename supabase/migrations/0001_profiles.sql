-- Onboarding: one row per Thesis user.
--
-- Auth is Privy (Apple / Google / email code), not Supabase Auth. Clients never
-- write these tables directly: the `session` edge function verifies the Privy
-- access token and writes with the service role.
--
--   profiles  public face of a user (handle, name, avatar, wallet). Readable by anyone.
--   accounts  private per-user data (Privy id, jurisdiction). Service role only.

create table public.profiles (
  id             uuid primary key default gen_random_uuid(),
  handle         text,
  display_name   text,
  avatar_url     text,
  solana_address text unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- handle is null until the user picks one during onboarding
  constraint profiles_handle_format check (handle is null or handle ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (display_name is null or char_length(display_name) <= 50)
);

create unique index profiles_handle_key on public.profiles (handle);

create table public.accounts (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  privy_did    text not null unique,
  -- ISO 3166-1 alpha-2, e.g. 'US'. Drives which venues a user's baskets can use.
  country      char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  -- ISO 3166-2 subdivision without the country prefix, e.g. 'TX'. Only set for US users
  -- (Gemini Predictions is unavailable in some states).
  us_state     char(2) check (us_state is null or us_state ~ '^[A-Z]{2}$'),
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint accounts_us_state_only_for_us check (us_state is null or country = 'US')
);

-- updated_at maintenance
create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger accounts_set_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

-- RLS: profiles are world-readable; accounts have no policies, so only the
-- service role (edge functions) can touch them.
alter table public.profiles enable row level security;
alter table public.accounts enable row level security;

create policy "profiles are public"
  on public.profiles for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke all on public.accounts from anon, authenticated;
