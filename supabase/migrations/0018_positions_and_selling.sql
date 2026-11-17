-- Positions you can sell: every trade records its price, and selling pays you
-- back at the current price.
--
-- A take's price is 1 + its return: $1.00 when it's posted, $1.14 once it's up
-- 14%. take_price() reads it from take_stats.ret_pct, so whatever moves a
-- take's return (the pricing job, once it exists) moves every position on it.
-- Until then returns are placeholder stats and don't move, so selling returns
-- what you put in.
--
--   trade  $a at price p   → shares += a / p, cost += a
--   value of a trade       = shares × price now
--   value of a fade        = max(0, 2 × cost − shares × price now)
--                            (each fade gains what the take loses, and is
--                            worth 0 once the take has doubled)
--
-- positions holds one row per person, take and side (trading and fading the
-- same take are separate positions). Selling part of one sells that fraction
-- of its shares and cost; selling all of it deletes the row. Either way the
-- money is a 'sell' transfer: platform → you.
--
-- Existing trades are backfilled with the take's current price (returns haven't
-- moved since they were placed, so it's the price they got).

-- Prices ---------------------------------------------------------------------

create function public.take_price(p_take uuid) returns numeric
language sql stable
set search_path = ''
as $$
  select 1 + coalesce((select ret_pct from public.take_stats where take_id = p_take), 0) / 100
$$;

-- What a position is worth at price p.
create function public.position_value(p_side text, p_shares numeric, p_cost numeric, p_price numeric)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case when p_side = 'trade' then p_shares * p_price
              else greatest(0, 2 * p_cost - p_shares * p_price) end
$$;

-- Ledger: sells, and the price on every trade, fade and sell -------------------

alter table public.ledger drop constraint ledger_kind;
alter table public.ledger add constraint ledger_kind
  check (kind in ('deposit', 'withdrawal', 'trade', 'fade', 'sell'));
alter table public.ledger drop constraint ledger_trade_has_take;
alter table public.ledger add constraint ledger_trade_has_take
  check (kind not in ('trade', 'fade', 'sell') or take_id is not null);

-- The take's price when this row happened (trades, fades, sells).
alter table public.ledger add column price numeric(14, 6);
-- Sells: which side was sold.
alter table public.ledger add column side text;
alter table public.ledger add constraint ledger_side check (side is null or side in ('trade', 'fade'));

update public.ledger set price = public.take_price(take_id)
where kind in ('trade', 'fade') and take_id is not null;

-- Positions ------------------------------------------------------------------

create table public.positions (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  take_id    uuid not null references public.takes (id) on delete cascade,
  side       text not null,
  shares     numeric(24, 10) not null,
  -- Dollars in still held (selling half halves it).
  cost       numeric(24, 10) not null,
  -- Trades and fades since it opened.
  buys       integer not null default 1,
  opened_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (profile_id, take_id, side),
  constraint positions_side check (side in ('trade', 'fade')),
  constraint positions_positive check (shares > 0 and cost > 0)
);

alter table public.positions enable row level security;
revoke all on public.positions from anon, authenticated;
grant select, insert, update, delete on public.positions to service_role;

insert into public.positions (profile_id, take_id, side, shares, cost, buys, opened_at, updated_at)
select profile_id, take_id, kind, sum(-amount / price), sum(-amount), count(*), min(created_at), max(created_at)
from public.ledger
where profile_id is not null and kind in ('trade', 'fade') and take_id is not null and price > 0
group by profile_id, take_id, kind;

-- Trades record their price and add to your position ---------------------------

create or replace function public.place_trade(p_profile uuid, p_take uuid, p_side text, p_amount numeric default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rules jsonb := public.cash_rules();
  amt numeric := coalesce(p_amount, (rules ->> 'trade_amount')::numeric);
  tid uuid := gen_random_uuid();
  px numeric;
begin
  if p_side not in ('trade', 'fade') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;
  if amt < (rules ->> 'min_trade')::numeric or amt <> round(amt, 2) then
    raise exception 'below_minimum' using errcode = '22023';
  end if;
  if not exists (select 1 from public.takes where id = p_take) then
    raise exception 'no take' using errcode = 'P0002';
  end if;
  px := public.take_price(p_take);
  -- A take that's lost everything can't be bought.
  if px <= 0 then
    raise exception 'not_tradeable' using errcode = '22023';
  end if;
  perform public.lock_account(p_profile);

  if public.cash_balance(p_profile) < amt then
    raise exception 'insufficient_funds' using errcode = '22023';
  end if;

  insert into public.ledger (transfer_id, profile_id, kind, amount, take_id, price) values
    (tid, p_profile, p_side, -amt, p_take, px),
    (tid, null, p_side, amt, p_take, px);

  insert into public.positions as p (profile_id, take_id, side, shares, cost)
  values (p_profile, p_take, p_side, amt / px, amt)
  on conflict (profile_id, take_id, side) do update set
    shares = p.shares + excluded.shares,
    cost = p.cost + excluded.cost,
    buys = p.buys + 1,
    updated_at = now();

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

-- Selling --------------------------------------------------------------------

-- Sells p_amount dollars of a position at the current price, or all of it when
-- p_amount is null (or at least what it's worth). Pays your balance.
create function public.sell_position(p_profile uuid, p_take uuid, p_side text, p_amount numeric default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rules jsonb := public.cash_rules();
  pos public.positions;
  px numeric;
  worth numeric;
  frac numeric;
  proceeds numeric;
  cost_sold numeric;
  tid uuid := gen_random_uuid();
begin
  if p_side not in ('trade', 'fade') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;
  perform public.lock_account(p_profile);

  select * into pos from public.positions
  where profile_id = p_profile and take_id = p_take and side = p_side
  for update;
  if not found then
    raise exception 'no_position' using errcode = '22023';
  end if;

  px := public.take_price(p_take);
  worth := round(public.position_value(p_side, pos.shares, pos.cost, px), 2);

  if p_amount is null or p_amount >= worth then
    -- Everything.
    frac := 1;
    proceeds := worth;
    cost_sold := pos.cost;
    delete from public.positions where profile_id = p_profile and take_id = p_take and side = p_side;
  else
    if p_amount < (rules ->> 'min_trade')::numeric or p_amount <> round(p_amount, 2) then
      raise exception 'below_minimum' using errcode = '22023';
    end if;
    frac := p_amount / worth;
    proceeds := p_amount;
    cost_sold := pos.cost * frac;
    update public.positions set
      shares = shares * (1 - frac),
      cost = cost * (1 - frac),
      updated_at = now()
    where profile_id = p_profile and take_id = p_take and side = p_side;
  end if;

  -- A position worth $0 just closes; there's nothing to pay.
  if proceeds > 0 then
    insert into public.ledger (transfer_id, profile_id, kind, amount, take_id, price, side) values
      (tid, p_profile, 'sell', proceeds, p_take, px, p_side),
      (tid, null, 'sell', -proceeds, p_take, px, p_side);
  end if;

  update public.take_stats set money_in = greatest(0, money_in - round(cost_sold, 2))
  where take_id = p_take;

  return jsonb_build_object(
    'cash', public.cash_summary(p_profile),
    'sold', proceeds,
    -- What you made (or lost) on the part you sold.
    'pnl', round(proceeds - cost_sold, 2),
    'closed', frac = 1
  );
end;
$$;

revoke execute on function public.sell_position(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.sell_position(uuid, uuid, text, numeric) to service_role;
revoke execute on function public.take_price(uuid) from public, anon, authenticated;
grant execute on function public.take_price(uuid) to service_role;
revoke execute on function public.position_value(text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.position_value(text, numeric, numeric, numeric) to service_role;

-- Your positions, now from the positions table, with prices and value --------

create or replace function public.cash_positions(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'take', public.take_json(t),
    'side', p.side,
    -- dollars in, still held
    'amount', round(p.cost, 2),
    'shares', p.shares,
    'avg_price', round(p.cost / p.shares, 6),
    'price', round(v.px, 6),
    'value', round(v.worth, 2),
    'count', p.buys,
    'first_at', p.opened_at,
    'last_at', p.updated_at
  ) order by p.updated_at desc), '[]'::jsonb)
  from public.positions p
  join public.takes t on t.id = p.take_id
  cross join lateral (
    select public.take_price(p.take_id) as px,
           public.position_value(p.side, p.shares, p.cost, public.take_price(p.take_id)) as worth
  ) v
  where p.profile_id = p_profile
$$;

-- Activity shows the side of a sell ---------------------------------------------

create or replace function public.cash_activity(
  p_profile    uuid,
  p_before_at  timestamptz default null,
  p_before_id  uuid default null,
  p_limit      int default 50
) returns jsonb
language sql stable
set search_path = ''
as $$
  with page as (
    select l.* from public.ledger l
    where l.profile_id = p_profile
      and (p_before_at is null or (l.created_at, l.id) < (p_before_at, p_before_id))
    order by l.created_at desc, l.id desc
    limit least(greatest(p_limit, 1), 200) + 1
  ),
  shown as (
    select * from page order by created_at desc, id desc limit least(greatest(p_limit, 1), 200)
  )
  select jsonb_build_object(
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'kind', s.kind,
        'amount', s.amount,
        'method', s.method,
        'created_at', s.created_at,
        'take_id', s.take_id,
        'take_claim', t.claim,
        'price', s.price,
        'side', s.side
      ) order by s.created_at desc, s.id desc)
      from shown s
      left join public.takes t on t.id = s.take_id
    ), '[]'::jsonb),
    'has_more', (select count(*) from page) > least(greatest(p_limit, 1), 200)
  )
$$;
