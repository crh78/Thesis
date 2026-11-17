-- Scores from the chain (docs/hardening-plan.md §4).
--
-- Raw P&L from the chain, no Thesis Score formula yet (an open question in CLAUDE.md). The
-- Stream webhook already stores every program event in chain_events; this keeps one row per
-- on-chain position from them, and the existing leaderboard, profiles and feed read their
-- numbers from it when the request names a network (fork-mode builds send
-- x-thesis-network: solana-mainnet-fork). Other builds see the play-money numbers, as before.
--
--   chain_positions          one row per position: owner, side, stake, opened / sold / settled,
--                            and once settled its return, P&L and whether it scored. Kept by a
--                            trigger on chain_events; filled from the events already stored.
--   chain_wallet_stats()     per wallet: scored stake, P&L, wins, settled positions and the
--                            wallet's own takes settled, the same raw numbers the program keeps
--                            in its Profile account (settle.rs), optionally since a date.
--   leaderboard()            with a network: profiles with on-chain activity there only (no
--                            play-money accounts, no wallets without a profile), ranked by
--                            scored P&L, then return, then the earliest account.
--   person_json()            with a network: "made" and "return" are the chain's all-time P&L.
--
-- Only settled positions that scored count (sales included, since a sale settles at once).
-- Open positions don't count. Periods go by the settlement's block time.

create table public.chain_positions (
  network     text not null,
  address     text not null,
  take        text not null,
  owner       text not null,
  side        text not null,
  -- USDC base units.
  stake       numeric(20, 0) not null,
  opened_at   timestamptz,
  exited_at   timestamptz,
  settled_at  timestamptz,
  scored      boolean,
  return_bps  bigint,
  pnl         numeric(20, 0),
  updated_at  timestamptz not null default now(),

  primary key (network, address)
);

create index chain_positions_owner on public.chain_positions (network, owner, settled_at);
create index chain_positions_open on public.chain_positions (network, take) where settled_at is null;

alter table public.chain_positions enable row level security;
create policy "chain positions are public" on public.chain_positions for select to anon, authenticated using (true);
revoke all on public.chain_positions from anon, authenticated;
grant select on public.chain_positions to anon, authenticated;
grant select, insert, update, delete on public.chain_positions to service_role;

-- One event's effect on chain_positions. A fork reset can reuse a position address, so a newer
-- positionOpened starts the row over.
create function public.apply_chain_position_event(e public.chain_events) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := e.data;
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
      return_bps = null, pnl = null, updated_at = now()
    where public.chain_positions.opened_at is null
       or excluded.opened_at is null
       or excluded.opened_at >= public.chain_positions.opened_at;

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
        updated_at = now()
    where network = e.network and address = d ->> 'position';
  end if;
end;
$$;

revoke execute on function public.apply_chain_position_event(public.chain_events) from public, anon, authenticated;

create function public.chain_events_positions() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_chain_position_event(new);
  return new;
end;
$$;

create trigger chain_events_positions after insert on public.chain_events
  for each row when (new.name in ('positionOpened', 'positionExited', 'positionSettled'))
  execute function public.chain_events_positions();

-- What's already stored, in chain order.
select public.apply_chain_position_event(e)
from public.chain_events e
where e.name in ('positionOpened', 'positionExited', 'positionSettled')
order by e.network, e.slot nulls first, e.block_time nulls first, e.signature, e.ordinal;

-- Stats ---------------------------------------------------------------------------------------

-- Per wallet on p_network, for positions settled since p_since (all time when null). Amounts in
-- USDC base units. scored_stake, pnl and wins match the program's Profile (settle.rs): scored
-- positions only, a win is P&L above zero.
create function public.chain_wallet_stats(p_network text, p_since timestamptz default null)
returns table (owner text, scored_stake numeric, pnl numeric, wins bigint, settled bigint, takes_settled bigint)
language sql stable
-- Reads takeSettled from chain_events (service role only); returns only per-wallet totals, which
-- are public on-chain anyway.
security definer
set search_path = ''
as $$
  with p as (
    select cp.owner,
      coalesce(sum(cp.stake) filter (where cp.scored), 0) as scored_stake,
      coalesce(sum(cp.pnl) filter (where cp.scored), 0) as pnl,
      count(*) filter (where cp.scored and cp.pnl > 0) as wins,
      count(*) as settled
    from public.chain_positions cp
    where cp.network = p_network and cp.settled_at is not null
      and (p_since is null or cp.settled_at >= p_since)
    group by cp.owner
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

-- One wallet's all-time numbers in dollars and percent, for person_json.
create function public.chain_wallet_made(p_network text, p_wallet text, out made numeric, out pct numeric)
language sql stable
set search_path = ''
as $$
  select coalesce(round(sum(cp.pnl) / 1000000, 2), 0),
         coalesce(round(sum(cp.pnl) * 100 / nullif(sum(cp.stake), 0), 4), 0)
  from public.chain_positions cp
  where cp.network = p_network and cp.owner = p_wallet and cp.settled_at is not null and cp.scored
$$;

-- Reads ---------------------------------------------------------------------------------------

-- Same as 0006_social_reads, except that with a network header "made" and
-- "return_pct" are the wallet's on-chain P&L there.
create or replace function public.person_json(p public.profiles) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'handle', p.handle,
    'display_name', p.display_name,
    'bio', coalesce(p.bio, ''),
    'avatar_url', p.avatar_url,
    'made', case when n.network is null then coalesce(s.cash, 0) else coalesce(c.made, 0) end,
    'return_pct', case when n.network is null then coalesce(s.pct, 0) else coalesce(c.pct, 0) end,
    'takes', (select count(*) from public.takes t where t.author_id = p.id)
  )
  from (select public.request_network() as network) as n
  left join public.profile_stats s on n.network is null and s.profile_id = p.id and s.period = 'all'
  left join lateral public.chain_wallet_made(n.network, p.solana_address) c on n.network is not null
$$;

-- Same as 0006_social_reads, except that with a network header the board is the
-- chain's: profiles with on-chain activity on that network, by scored P&L for the period
-- (settled in the last 7 or 30 days, or all time), then return, then the earliest account.
create or replace function public.leaderboard(p_period text, p_limit int default 100) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  net text := public.request_network();
  since timestamptz := case p_period when 'week' then now() - interval '7 days'
                                      when 'month' then now() - interval '30 days' end;
begin
  if net is null then
    return (
      select coalesce(jsonb_agg(jsonb_build_object(
        'person', public.person_json(p),
        'cash', coalesce(s.cash, 0),
        'pct', coalesce(s.pct, 0)
      ) order by coalesce(s.cash, 0) desc, p.created_at), '[]'::jsonb)
      from (
        select p.* from public.profiles p
        left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
        where p.handle is not null
        order by coalesce(s.cash, 0) desc, p.created_at
        limit least(greatest(p_limit, 1), 200)
      ) p
      left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
    );
  end if;

  return (
    with board as (
      select p, round(coalesce(st.pnl, 0) / 1000000, 2) as cash,
             coalesce(round(st.pnl * 100 / nullif(st.scored_stake, 0), 4), 0) as pct
      from public.profiles p
      left join public.chain_wallet_stats(net, since) st on st.owner = p.solana_address
      where p.handle is not null
        and exists (select 1 from public.chain_positions cp where cp.network = net and cp.owner = p.solana_address)
      order by cash desc, pct desc, (p).created_at
      limit least(greatest(p_limit, 1), 200)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'person', public.person_json(b.p), 'cash', b.cash, 'pct', b.pct
    ) order by b.cash desc, b.pct desc, (b.p).created_at), '[]'::jsonb)
    from board b
  );
end;
$$;

-- Access ----------------------------------------------------------------------------------------

revoke execute on function public.chain_events_positions() from public, anon, authenticated;
revoke execute on function public.chain_wallet_stats(text, timestamptz) from public;
revoke execute on function public.chain_wallet_made(text, text) from public;
grant execute on function public.chain_wallet_stats(text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.chain_wallet_made(text, text) to anon, authenticated, service_role;
