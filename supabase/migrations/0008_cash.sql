-- Cash: deposits, withdrawals, and $20 trades / fades that pay the platform.
--
-- Double-entry ledger. Every movement is a transfer of two rows with the same
-- transfer_id that sum to zero: one for the user (profile_id set) and one for
-- the platform (profile_id null). A user's balance is the sum of their rows.
--
--   deposit     user +X        platform (outside money in) −X
--   withdrawal  user −X        platform (paid out)         +X
--   trade/fade  user −20       platform                    +20
--
-- Deposits and withdrawals are SIMULATED for now: nothing charges a card or
-- pays out. The onramp/offramp provider will call these functions from a
-- webhook once it exists; until then the app calls them through the `cash`
-- edge function, capped at $2,500 of deposits a day.
--
-- Everything here is private: service role only. Writes go through the
-- functions below, which lock the user's account row so concurrent requests
-- can't spend the same balance twice.

create table public.ledger (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null,
  -- null = the platform's side of the transfer
  profile_id  uuid references public.profiles (id) on delete cascade,
  kind        text not null,
  -- Signed, in dollars: + into this account, − out of it.
  amount      numeric(14, 2) not null,
  -- deposits / withdrawals: 'apple_pay', 'debit', 'bank', 'transfer'
  method      text,
  take_id     uuid references public.takes (id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint ledger_kind check (kind in ('deposit', 'withdrawal', 'trade', 'fade')),
  constraint ledger_amount_nonzero check (amount <> 0),
  constraint ledger_method check (method is null or method in ('apple_pay', 'debit', 'bank', 'transfer')),
  constraint ledger_trade_has_take check (kind not in ('trade', 'fade') or take_id is not null)
);

create index ledger_profile_created on public.ledger (profile_id, created_at desc);
create index ledger_transfer on public.ledger (transfer_id);

alter table public.ledger enable row level security;
revoke all on public.ledger from anon, authenticated;
grant select, insert on public.ledger to service_role;

-- Settings ---------------------------------------------------------------------

create function public.cash_rules() returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'min_deposit', 10,
    'daily_deposit_limit', 2500,
    'min_withdrawal', 1,
    'trade_amount', 20
  )
$$;

-- Reads ------------------------------------------------------------------------

create function public.cash_balance(p_profile uuid) returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(sum(amount), 0)::numeric(14, 2) from public.ledger where profile_id = p_profile
$$;

-- Balance plus recent activity, newest first.
create function public.cash_summary(p_profile uuid, p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'balance', public.cash_balance(p_profile),
    'rules', public.cash_rules(),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'kind', l.kind,
        'amount', l.amount,
        'method', l.method,
        'created_at', l.created_at,
        'take_id', l.take_id,
        'take_claim', t.claim
      ) order by l.created_at desc)
      from (
        select * from public.ledger
        where profile_id = p_profile
        order by created_at desc
        limit least(greatest(p_limit, 1), 200)
      ) l
      left join public.takes t on t.id = l.take_id
    ), '[]'::jsonb)
  )
$$;

-- Writes -----------------------------------------------------------------------

-- Serializes money movements per user for the rest of the transaction.
create function public.lock_account(p_profile uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.accounts where profile_id = p_profile for update;
  if not found then
    raise exception 'no account' using errcode = 'P0002';
  end if;
end;
$$;

create function public.cash_deposit(p_profile uuid, p_amount numeric, p_method text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rules jsonb := public.cash_rules();
  today numeric;
  tid uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount < (rules ->> 'min_deposit')::numeric or p_amount <> round(p_amount, 2) then
    raise exception 'below_minimum' using errcode = '22023';
  end if;
  perform public.lock_account(p_profile);

  select coalesce(sum(amount), 0) into today from public.ledger
  where profile_id = p_profile and kind = 'deposit' and created_at > now() - interval '24 hours';
  if today + p_amount > (rules ->> 'daily_deposit_limit')::numeric then
    raise exception 'over_daily_limit' using errcode = '22023';
  end if;

  insert into public.ledger (transfer_id, profile_id, kind, amount, method) values
    (tid, p_profile, 'deposit', p_amount, p_method),
    (tid, null, 'deposit', -p_amount, p_method);
  return public.cash_summary(p_profile);
end;
$$;

create function public.cash_withdraw(p_profile uuid, p_amount numeric, p_method text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rules jsonb := public.cash_rules();
  tid uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount < (rules ->> 'min_withdrawal')::numeric or p_amount <> round(p_amount, 2) then
    raise exception 'below_minimum' using errcode = '22023';
  end if;
  perform public.lock_account(p_profile);

  if public.cash_balance(p_profile) < p_amount then
    raise exception 'insufficient_funds' using errcode = '22023';
  end if;

  insert into public.ledger (transfer_id, profile_id, kind, amount, method) values
    (tid, p_profile, 'withdrawal', -p_amount, p_method),
    (tid, null, 'withdrawal', p_amount, p_method);
  return public.cash_summary(p_profile);
end;
$$;

-- A trade or fade: $20 from the user to the platform, counted on the take.
create function public.place_trade(p_profile uuid, p_take uuid, p_side text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  amt numeric := (public.cash_rules() ->> 'trade_amount')::numeric;
  tid uuid := gen_random_uuid();
begin
  if p_side not in ('trade', 'fade') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;
  if not exists (select 1 from public.takes where id = p_take) then
    raise exception 'no take' using errcode = 'P0002';
  end if;
  perform public.lock_account(p_profile);

  if public.cash_balance(p_profile) < amt then
    raise exception 'insufficient_funds' using errcode = '22023';
  end if;

  insert into public.ledger (transfer_id, profile_id, kind, amount, take_id) values
    (tid, p_profile, p_side, -amt, p_take),
    (tid, null, p_side, amt, p_take);

  update public.take_stats set
    backs = backs + (p_side = 'trade')::int,
    fades = fades + (p_side = 'fade')::int,
    money_in = money_in + amt
  where take_id = p_take;

  return jsonb_build_object(
    'cash', public.cash_summary(p_profile),
    'take', (select public.take_json(t) from public.takes t where t.id = p_take)
  );
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'cash_rules()', 'cash_balance(uuid)', 'cash_summary(uuid, int)', 'lock_account(uuid)',
    'cash_deposit(uuid, numeric, text)', 'cash_withdraw(uuid, numeric, text)', 'place_trade(uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
