-- The agent trades for people by text (decided 2026-11-19): the X reply agent, iMessage trading,
-- and later auto-copy and the MCP server all go through functions/agent, which signs with a Privy
-- session signer that the user approved once on the web app's limits screen (/limits).
--
--   agent_grants   one per account: its Solana wallet and Privy wallet id, the per-trade and daily
--                  limits the user chose, and the chat handles it answers to (an X account id, an
--                  iMessage handle). Revoking keeps the row (revoked_at) so a re-approval keeps
--                  the linked handles.
--   agent_links    one-time links the iMessage bot sends to an unknown number: opening one while
--                  signed in and approving limits ties that number to the account. Only a hash of
--                  the token is stored; a link lasts 30 minutes and works once.
--   agent_trades   every trade the agent made or refused: the daily limit counts from here, and
--                  (surface, ref) makes a retried message the same trade, never a second one.
--   agent_spent(profile)  what the agent spent for an account in the last 24 hours: backs, fades
--                  and posts that are pending or landed (sales don't count against a limit).
--
-- Service role only: written and read by functions/agent.

create table public.agent_grants (
  profile_id      uuid primary key references public.profiles (id) on delete cascade,
  wallet          text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  privy_wallet_id text not null check (char_length(privy_wallet_id) between 1 and 100),
  -- Play money is capped at $1,000 an account, so no limit needs to be higher.
  per_trade_usd   numeric not null check (per_trade_usd >= 10 and per_trade_usd <= 1000),
  daily_usd       numeric not null check (daily_usd >= per_trade_usd and daily_usd <= 1000),
  -- The X account's numeric id (stable across username changes) and its username, lowercased.
  x_user_id       text unique check (x_user_id is null or x_user_id ~ '^[0-9]{1,25}$'),
  x_username      text check (x_username is null or x_username ~ '^[a-z0-9_]{1,15}$'),
  -- An iMessage handle: E.164 phone or an email.
  imessage        text unique check (imessage is null or char_length(imessage) between 4 and 120),
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.agent_links (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  imessage    text not null check (char_length(imessage) between 4 and 120),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index agent_links_expires on public.agent_links (expires_at);

create table public.agent_trades (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  surface     text not null check (surface in ('x', 'imessage', 'copy', 'mcp')),
  -- The message or post that asked for it (an X post id, a Sendblue message handle).
  ref         text check (ref is null or char_length(ref) between 1 and 120),
  action      text not null check (action in ('post', 'back', 'fade', 'sell')),
  take_id     uuid references public.takes (id) on delete set null,
  usd         numeric check (usd is null or usd >= 0),
  bps         integer check (bps is null or (bps between 1 and 10000)),
  build_id    uuid,
  status      text not null check (status in ('pending', 'landed', 'failed', 'refused')),
  error       text check (error is null or char_length(error) <= 200),
  signatures  text[],
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index agent_trades_ref on public.agent_trades (surface, ref) where ref is not null;
create index agent_trades_spent on public.agent_trades (profile_id, created_at desc);

alter table public.agent_grants enable row level security;
alter table public.agent_links enable row level security;
alter table public.agent_trades enable row level security;
revoke all on public.agent_grants, public.agent_links, public.agent_trades from anon, authenticated;
grant select, insert, update, delete on public.agent_grants, public.agent_links, public.agent_trades to service_role;

create function public.agent_spent(p_profile uuid) returns numeric
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(sum(usd), 0)
  from public.agent_trades
  where profile_id = p_profile
    and action in ('post', 'back', 'fade')
    and status in ('pending', 'landed')
    and created_at > now() - interval '24 hours'
$$;
revoke all on function public.agent_spent(uuid) from public, anon, authenticated;
grant execute on function public.agent_spent(uuid) to service_role;

-- Reserves a trade against the account's limits in one step, so two messages at once can't both
-- fit under the daily limit. Returns { id, existing } (the same surface + ref is the same trade:
-- existing true, with its status), or { error: no_grant | over_trade_limit | over_daily_limit,
-- per_trade_usd, left_usd }. Sales aren't held to the limits.
create function public.agent_reserve(
  p_profile uuid, p_surface text, p_ref text, p_action text, p_take uuid, p_usd numeric, p_bps integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.agent_grants;
  prior public.agent_trades;
  spent numeric;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_profile::text, 59));
  if p_ref is not null then
    select * into prior from public.agent_trades where surface = p_surface and ref = p_ref;
    if found then
      return jsonb_build_object('id', prior.id, 'existing', true, 'status', prior.status, 'take_id', prior.take_id,
        'build_id', prior.build_id, 'error', prior.error, 'signatures', to_jsonb(prior.signatures));
    end if;
  end if;
  select * into g from public.agent_grants where profile_id = p_profile and revoked_at is null;
  if not found then
    return jsonb_build_object('error', 'no_grant');
  end if;
  if p_action in ('post', 'back', 'fade') then
    spent := public.agent_spent(p_profile);
    if p_usd is null or p_usd > g.per_trade_usd then
      return jsonb_build_object('error', 'over_trade_limit', 'per_trade_usd', g.per_trade_usd, 'left_usd', greatest(g.daily_usd - spent, 0));
    end if;
    if spent + p_usd > g.daily_usd then
      return jsonb_build_object('error', 'over_daily_limit', 'per_trade_usd', g.per_trade_usd, 'left_usd', greatest(g.daily_usd - spent, 0));
    end if;
  end if;
  insert into public.agent_trades (profile_id, surface, ref, action, take_id, usd, bps, status)
  values (p_profile, p_surface, p_ref, p_action, p_take, p_usd, p_bps, 'pending')
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'existing', false);
end
$$;
revoke all on function public.agent_reserve(uuid, text, text, text, uuid, numeric, integer) from public, anon, authenticated;
grant execute on function public.agent_reserve(uuid, text, text, text, uuid, numeric, integer) to service_role;
