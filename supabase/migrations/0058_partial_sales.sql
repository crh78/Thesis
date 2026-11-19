-- Partial sales (decided 2026-11-19): a sale can sell part of a position.
--
-- The program's sell_part sells a fraction (bps of what's left) of a position and emits
-- positionPartSold; the settler signs that sale's prices (partPricesRecorded) and settle_part
-- realizes the fraction's P&L (partSettled), in order, one seq at a time. The final sale or the
-- 365-day mark settles what's left (positionSettled, which now carries the stake it settled).
-- Each partial sale counts in the scores at its own settle time.
--
--   chain_position_parts     one row per partial sale: position, seq, the fraction and stake
--                            sold, the escrow returned, when it was sold, and once settled its
--                            return, P&L and whether it scored. Kept from chain_events.
--   chain_positions          remaining (stake still held, after the latest partial sale),
--                            settled_stake (the stake the final settlement scored on, from
--                            positionSettled.stake) and realized_pnl (settled partial sales' P&L,
--                            scored or not, as the program keeps it). All null until a partial
--                            sale or a new-style settlement.
--   chain_realization_rows   every piece of a position (its partial sales and the final
--                            settlement of what was left), realized once settled_at is set. A
--                            final settlement's stake is settled_stake, else remaining, else
--                            stake; it is a win when it scored and its P&L plus the position's
--                            partial sales' is above zero (the program's rule).
--   chain_realizations()     the realized rows on one network, optionally since a date (by each
--                            row's settle time).
--   chain_wallet_stats, chain_wallet_made, chain_backer_stats, chain_backers_made,
--   chain_fader_stats        same answers as before, read from the realizations. "settled" still
--                            counts positions (final settlements), like the Profile account.
--                            leaderboard() and person_json() read through these, unchanged.
--   price_audit              moment 'part' and part_seq (the partial sale's seq); price_events()
--                            lists partPricesRecorded with its seq.
--
-- No notification for a partial sale: only selling all of the author's buy-in closes a take
-- (takeClosed, as before).
--
-- Additive: on a chain without partial sales (no positionPartSold / partSettled events, no stake
-- on positionSettled) every number reads as before.

-- The column adds below take short exclusive locks: fail fast rather than queue behind a relay
-- insert (as 0054 does).
set lock_timeout = '5s';

-- Tables --------------------------------------------------------------------------------------------

create table public.chain_position_parts (
  network          text not null,
  position         text not null,
  seq              integer not null,
  -- From positionPartSold (or, if that event was missed, from the position's row).
  take             text,
  owner            text,
  side             text,
  bps              integer,
  -- USDC base units: the cost basis sold, what the position kept after it, the escrow returned.
  stake            numeric(20, 0),
  remaining        numeric(20, 0),
  escrow_returned  numeric(20, 0),
  sold_at          timestamptz,
  -- From partSettled.
  settled_at       timestamptz,
  scored           boolean,
  return_bps       bigint,
  pnl              numeric(20, 0),
  updated_at       timestamptz not null default now(),

  primary key (network, position, seq)
);

create index chain_position_parts_owner on public.chain_position_parts (network, owner, settled_at);
create index chain_position_parts_settled_take on public.chain_position_parts (network, take) where settled_at is not null;

alter table public.chain_position_parts enable row level security;
create policy "chain position parts are public" on public.chain_position_parts for select to anon, authenticated using (true);
revoke all on public.chain_position_parts from anon, authenticated;
grant select on public.chain_position_parts to anon, authenticated;
grant select, insert, update, delete on public.chain_position_parts to service_role;

alter table public.chain_positions
  add column remaining      numeric(20, 0),
  add column settled_stake  numeric(20, 0),
  add column realized_pnl   numeric(20, 0);

-- Ingest --------------------------------------------------------------------------------------------

-- Same as 0027_chain_scores, plus positionPartSold, partSettled and positionSettled's stake. A
-- reused position address (a fork reset) also drops the old position's partial sales.
create or replace function public.apply_chain_position_event(e public.chain_events) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := e.data;
  n integer;
begin
  -- Every position event names its position; skip anything that doesn't (hand-made test events).
  if d ->> 'position' is null then
    return;
  end if;
  if e.name = 'positionOpened' then
    insert into public.chain_positions (network, address, take, owner, side, stake, opened_at)
    values (e.network, d ->> 'position', d ->> 'take', d ->> 'owner', d ->> 'side', (d ->> 'stake')::numeric, e.block_time)
    on conflict (network, address) do update set
      take = excluded.take, owner = excluded.owner, side = excluded.side, stake = excluded.stake,
      opened_at = excluded.opened_at, exited_at = null, settled_at = null, scored = null,
      return_bps = null, pnl = null, remaining = null, settled_stake = null, realized_pnl = null,
      updated_at = now()
    where public.chain_positions.opened_at is null
       or excluded.opened_at is null
       or excluded.opened_at >= public.chain_positions.opened_at;
    get diagnostics n = row_count;
    if n > 0 and e.block_time is not null then
      delete from public.chain_position_parts pp
      where pp.network = e.network and pp.position = d ->> 'position'
        and coalesce(pp.sold_at, pp.settled_at) < e.block_time;
    end if;

  elsif e.name = 'positionExited' then
    update public.chain_positions
    set exited_at = coalesce(to_timestamp((d ->> 'exitedAt')::double precision), e.block_time), updated_at = now()
    where network = e.network and address = d ->> 'position';

  elsif e.name = 'positionSettled' then
    update public.chain_positions
    set settled_at = e.block_time,
        scored = (d ->> 'scored')::boolean,
        return_bps = (d ->> 'returnBps')::bigint,
        pnl = (d ->> 'pnl')::numeric,
        -- Null on a program from before partial sales: the whole stake settled.
        settled_stake = (d ->> 'stake')::numeric,
        updated_at = now()
    where network = e.network and address = d ->> 'position';

  elsif e.name = 'positionPartSold' then
    insert into public.chain_position_parts as pp
      (network, position, seq, take, owner, side, bps, stake, remaining, escrow_returned, sold_at)
    values (
      e.network, d ->> 'position', (d ->> 'seq')::integer, d ->> 'take', d ->> 'owner', d ->> 'side',
      (d ->> 'bps')::integer, (d ->> 'stakeSold')::numeric, (d ->> 'remainingStake')::numeric,
      (d ->> 'escrowReturned')::numeric,
      coalesce(case when d ->> 'soldAt' ~ '^[0-9]+$' then to_timestamp((d ->> 'soldAt')::double precision) end, e.block_time)
    )
    -- A partSettled seen first made the row: fill in the sale, keep the settlement.
    on conflict (network, position, seq) do update set
      take = coalesce(excluded.take, pp.take), owner = coalesce(excluded.owner, pp.owner),
      side = coalesce(excluded.side, pp.side), bps = excluded.bps,
      stake = coalesce(pp.stake, excluded.stake), remaining = excluded.remaining,
      escrow_returned = excluded.escrow_returned, sold_at = excluded.sold_at, updated_at = now();
    update public.chain_positions
    set remaining = (d ->> 'remainingStake')::numeric, updated_at = now()
    where network = e.network and address = d ->> 'position';

  elsif e.name = 'partSettled' then
    insert into public.chain_position_parts as pp
      (network, position, seq, take, owner, side, stake, settled_at, scored, return_bps, pnl)
    select e.network, d ->> 'position', (d ->> 'seq')::integer,
           coalesce(d ->> 'take', cp.take), coalesce(d ->> 'owner', cp.owner), coalesce(d ->> 'side', cp.side),
           (d ->> 'stake')::numeric, coalesce(e.block_time, now()), (d ->> 'scored')::boolean,
           (d ->> 'returnBps')::bigint, (d ->> 'pnl')::numeric
    from (select 1) one
    left join public.chain_positions cp on cp.network = e.network and cp.address = d ->> 'position'
    on conflict (network, position, seq) do update set
      take = coalesce(pp.take, excluded.take), owner = coalesce(pp.owner, excluded.owner),
      side = coalesce(pp.side, excluded.side), stake = coalesce(excluded.stake, pp.stake),
      settled_at = excluded.settled_at, scored = excluded.scored, return_bps = excluded.return_bps,
      pnl = excluded.pnl, updated_at = now();
    update public.chain_positions cp
    set realized_pnl = (
          select sum(pp.pnl) from public.chain_position_parts pp
          where pp.network = cp.network and pp.position = cp.address and pp.settled_at is not null),
        updated_at = now()
    where cp.network = e.network and cp.address = d ->> 'position';
  end if;
end;
$$;

revoke execute on function public.apply_chain_position_event(public.chain_events) from public, anon, authenticated;

drop trigger chain_events_positions on public.chain_events;
create trigger chain_events_positions after insert on public.chain_events
  for each row when (new.name in ('positionOpened', 'positionExited', 'positionSettled', 'positionPartSold', 'partSettled'))
  execute function public.chain_events_positions();

-- What's already stored (nothing before the program has partial sales), in chain order.
select public.apply_chain_position_event(e)
from public.chain_events e
where e.name in ('positionPartSold', 'partSettled')
order by e.network, e.slot nulls first, e.block_time nulls first, e.signature, e.ordinal;
update public.chain_positions cp
set settled_stake = (e.data ->> 'stake')::numeric
from public.chain_events e
where e.network = cp.network and e.name = 'positionSettled' and e.data ->> 'position' = cp.address
  and e.data ->> 'stake' is not null and cp.settled_at is not null and cp.settled_stake is null;

-- Realizations --------------------------------------------------------------------------------------

-- Every piece of a position: each partial sale, and the final settlement of what was left. A row
-- is realized once settled_at is set; read with that filter. A view (not only the function below)
-- so per-wallet and per-author reads keep their filters on the tables' indexes; its branches have
-- no WHERE so Postgres can flatten the union and push those filters into each table.
create view public.chain_realization_rows with (security_invoker = true) as
  select cp.network, cp.owner, cp.take, cp.side, cp.address as position, null::integer as part_seq,
         coalesce(cp.settled_stake, cp.remaining, cp.stake) as stake, cp.pnl,
         coalesce(cp.scored, false) as scored, cp.settled_at, true as final,
         coalesce(cp.scored, false) and cp.pnl + coalesce(cp.realized_pnl, 0) > 0 as win
  from public.chain_positions cp
  union all
  select pp.network, pp.owner, pp.take, pp.side, pp.position, pp.seq, pp.stake, pp.pnl,
         coalesce(pp.scored, false), pp.settled_at, false, false
  from public.chain_position_parts pp;

revoke all on public.chain_realization_rows from anon, authenticated;
grant select on public.chain_realization_rows to anon, authenticated, service_role;

-- The realizations on p_network settled since p_since (all time when null). Amounts in USDC base
-- units.
create function public.chain_realizations(p_network text, p_since timestamptz default null)
returns table (
  owner text, take text, side text, "position" text, part_seq integer, stake numeric, pnl numeric,
  scored boolean, settled_at timestamptz, final boolean, win boolean
)
language sql stable
set search_path = ''
as $$
  select r.owner, r.take, r.side, r.position, r.part_seq, r.stake, r.pnl, r.scored, r.settled_at, r.final, r.win
  from public.chain_realization_rows r
  where r.network = p_network and r.settled_at is not null and (p_since is null or r.settled_at >= p_since)
$$;

-- Stats ---------------------------------------------------------------------------------------------

-- Same as 0027_chain_scores, from the realizations: scored_stake and pnl over scored partial sales
-- and final settlements, wins and settled over final settlements (the Profile's rules).
create or replace function public.chain_wallet_stats(p_network text, p_since timestamptz default null)
returns table (owner text, scored_stake numeric, pnl numeric, wins bigint, settled bigint, takes_settled bigint)
language sql stable
-- Reads takeSettled from chain_events (service role only); returns only per-wallet totals, which
-- are public on-chain anyway.
security definer
set search_path = ''
as $$
  with p as (
    select r.owner,
      coalesce(sum(r.stake) filter (where r.scored), 0) as scored_stake,
      coalesce(sum(r.pnl) filter (where r.scored), 0) as pnl,
      count(*) filter (where r.win) as wins,
      count(*) filter (where r.final) as settled
    from public.chain_realizations(p_network, p_since) r
    group by r.owner
  ),
  t as (
    select e.data ->> 'author' as owner, count(*) as takes_settled
    from public.chain_events e
    where e.network = p_network and e.name = 'takeSettled'
      and (p_since is null or e.block_time >= p_since)
    group by 1
  )
  select coalesce(p.owner, t.owner), coalesce(p.scored_stake, 0), coalesce(p.pnl, 0),
         coalesce(p.wins, 0), coalesce(p.settled, 0), coalesce(t.takes_settled, 0)
  from p full join t on t.owner = p.owner
$$;

-- Same as 0027_chain_scores, partial sales included.
create or replace function public.chain_wallet_made(p_network text, p_wallet text, out made numeric, out pct numeric)
language sql stable
set search_path = ''
as $$
  select coalesce(round(sum(r.pnl) / 1000000, 2), 0),
         coalesce(round(sum(r.pnl) * 100 / nullif(sum(r.stake), 0), 4), 0)
  from public.chain_realization_rows r
  where r.network = p_network and r.owner = p_wallet and r.scored and r.settled_at is not null
$$;

-- Same as 0030_two_scores, partial sales included. backers still counts wallets.
create or replace function public.chain_backer_stats(p_network text, p_since timestamptz default null)
returns table (author text, backer_stake numeric, backer_pnl numeric, backers bigint)
language sql stable
set search_path = ''
as $$
  select ct.author_wallet, coalesce(sum(r.stake), 0), coalesce(sum(r.pnl), 0), count(distinct r.owner)
  from public.chain_realizations(p_network, p_since) r
  join public.chain_takes ct on ct.network = p_network and ct.address = r.take
  where r.side = 'back' and r.scored
    and ct.author_wallet is not null and r.owner <> ct.author_wallet
  group by ct.author_wallet
$$;

-- Same as 0030_two_scores, partial sales included.
create or replace function public.chain_backers_made(p_network text, p_wallet text, out made numeric, out pct numeric)
language sql stable
set search_path = ''
as $$
  select coalesce(round(sum(r.pnl) / 1000000, 2), 0),
         coalesce(round(sum(r.pnl) * 100 / nullif(sum(r.stake), 0), 4), 0)
  from public.chain_realization_rows r
  join public.chain_takes ct on ct.network = r.network and ct.address = r.take
  where r.network = p_network and ct.author_wallet = p_wallet and r.owner <> p_wallet
    and r.side = 'back' and r.scored and r.settled_at is not null
$$;

-- Same as 0031_fader_board, partial sales included. fades still counts positions.
create or replace function public.chain_fader_stats(p_network text, p_since timestamptz default null)
returns table (owner text, fade_stake numeric, fade_pnl numeric, fades bigint)
language sql stable
set search_path = ''
as $$
  select r.owner, coalesce(sum(r.stake), 0), coalesce(sum(r.pnl), 0), count(distinct r.position)
  from public.chain_realizations(p_network, p_since) r
  left join public.chain_takes ct on ct.network = p_network and ct.address = r.take
  where r.side = 'fade' and r.scored
    and r.owner is distinct from ct.author_wallet
  group by r.owner
$$;

-- Price audit ---------------------------------------------------------------------------------------

alter table public.price_audit drop constraint price_audit_moment_check;
alter table public.price_audit add constraint price_audit_moment_check check (moment in ('entry', 'exit', 'sale', 'part'));
alter table public.price_audit add column part_seq integer;

-- Same as 0039_price_audit, plus partPricesRecorded and its seq (part_seq, null for other events).
drop function public.price_events(text, text, text);
create function public.price_events(p_position text default null, p_take text default null, p_network text default null)
returns table (
  network text, signature text, ordinal integer, slot bigint, block_time timestamptz, name text,
  take text, "position" text, legs integer, source_hash text, published boolean, canonical text,
  part_seq integer
)
language sql stable
security definer
set search_path = ''
as $$
  select e.network, e.signature, e.ordinal, e.slot, e.block_time, e.name,
         e.data ->> 'take', e.data ->> 'position', (e.data ->> 'legs')::int,
         public.bytes_hex(e.data -> 'sourceHash') as source_hash,
         a.hash is not null as published,
         a.canonical,
         case when e.name = 'partPricesRecorded' then (e.data ->> 'seq')::int end
  from public.chain_events e
  left join public.price_audit a on a.hash = public.bytes_hex(e.data -> 'sourceHash')
  where e.name in ('entryPricesRecorded', 'exitPricesRecorded', 'salePricesRecorded', 'partPricesRecorded')
    and (p_position is not null or p_take is not null)
    and (p_position is null or e.data ->> 'position' = p_position)
    and (p_take is null or e.data ->> 'take' = p_take)
    and (p_network is null or e.network = p_network)
  order by e.slot nulls last, e.signature, e.ordinal
  limit 500
$$;

-- Access --------------------------------------------------------------------------------------------

revoke execute on function public.chain_realizations(text, timestamptz) from public;
grant execute on function public.chain_realizations(text, timestamptz) to anon, authenticated, service_role;
revoke execute on function public.price_events(text, text, text) from public;
grant execute on function public.price_events(text, text, text) to anon, authenticated, service_role;
