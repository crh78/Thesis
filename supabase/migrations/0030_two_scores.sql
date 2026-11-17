-- Two scores, replacing the open "Thesis Score formula" question.
--
-- Every account shows two numbers, each in dollars and in percent:
--   Own P&L            the account's own scored P&L (chain_wallet_stats, as before).
--   Made for backers   the net scored P&L of everyone who backed the account's takes: losses
--                      subtracted, faders not counted, the author's own positions not counted.
--
--   chain_backer_stats()   per author wallet: backers' scored stake, P&L and how many backers,
--                          optionally since a date.
--   chain_backers_made()   one author's all-time numbers in dollars and percent, for person_json.
--   person_json()          adds "backers_made" and "backers_pct" (0 without a network).
--   leaderboard()          takes a board ('own' or 'backers') and a sort ('cash' or 'pct'), so
--                          each board can be ranked by dollars or by percent. Called the old
--                          way (period and limit only) it answers as before.
--
-- Same rules as the own-P&L board: settled positions that scored only (sales included), periods
-- by the settlement's block time.

-- Stats ---------------------------------------------------------------------------------------

-- Per author on p_network, for backs of their takes settled since p_since (all time when null).
-- Amounts in USDC base units. A take's author comes from its takeCreated event (chain_takes).
create function public.chain_backer_stats(p_network text, p_since timestamptz default null)
returns table (author text, backer_stake numeric, backer_pnl numeric, backers bigint)
language sql stable
set search_path = ''
as $$
  select ct.author_wallet, coalesce(sum(cp.stake), 0), coalesce(sum(cp.pnl), 0), count(distinct cp.owner)
  from public.chain_positions cp
  join public.chain_takes ct on ct.network = cp.network and ct.address = cp.take
  where cp.network = p_network and cp.side = 'back' and cp.scored and cp.settled_at is not null
    and ct.author_wallet is not null and cp.owner <> ct.author_wallet
    and (p_since is null or cp.settled_at >= p_since)
  group by ct.author_wallet
$$;

-- One author's all-time numbers in dollars and percent, for person_json.
create function public.chain_backers_made(p_network text, p_wallet text, out made numeric, out pct numeric)
language sql stable
set search_path = ''
as $$
  select coalesce(round(sum(cp.pnl) / 1000000, 2), 0),
         coalesce(round(sum(cp.pnl) * 100 / nullif(sum(cp.stake), 0), 4), 0)
  from public.chain_positions cp
  join public.chain_takes ct on ct.network = cp.network and ct.address = cp.take
  where cp.network = p_network and ct.author_wallet = p_wallet and cp.owner <> p_wallet
    and cp.side = 'back' and cp.scored and cp.settled_at is not null
$$;

create index chain_takes_author on public.chain_takes (network, author_wallet);

-- Reads ---------------------------------------------------------------------------------------

-- Same as 0027_chain_scores, plus what the person made for their backers.
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
    'backers_made', coalesce(b.made, 0),
    'backers_pct', coalesce(b.pct, 0),
    'takes', (select count(*) from public.takes t where t.author_id = p.id)
  )
  from (select public.request_network() as network) as n
  left join public.profile_stats s on n.network is null and s.profile_id = p.id and s.period = 'all'
  left join lateral public.chain_wallet_made(n.network, p.solana_address) c on n.network is not null
  left join lateral public.chain_backers_made(n.network, p.solana_address) b on n.network is not null
$$;

-- The boards. p_board: 'own' (own P&L) or 'backers' (made for backers). p_sort: 'cash' ranks by
-- dollars then percent, 'pct' by percent then dollars; the earliest account breaks ties.
--   Without a network: the play-money board for 'own', as before; no 'backers' board.
--   With one: 'own' lists profiles with a position there; 'backers' lists profiles with a take
--   there.
drop function public.leaderboard(text, int);
create function public.leaderboard(p_period text, p_limit int default 100, p_board text default 'own', p_sort text default 'cash')
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  net text := public.request_network();
  since timestamptz := case p_period when 'week' then now() - interval '7 days'
                                      when 'month' then now() - interval '30 days' end;
  by_pct boolean := p_sort = 'pct';
begin
  if p_board not in ('own', 'backers') or p_sort not in ('cash', 'pct') then
    raise exception 'unknown board or sort' using errcode = '22023';
  end if;

  if net is null then
    if p_board <> 'own' then
      return '[]'::jsonb;
    end if;
    return (
      with board as (
        select p, coalesce(s.cash, 0) as cash, coalesce(s.pct, 0) as pct
        from public.profiles p
        left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
        where p.handle is not null
      ),
      top as (
        select * from board b
        order by case when by_pct then b.pct else b.cash end desc,
                 case when by_pct then b.cash else b.pct end desc, (b.p).created_at
        limit least(greatest(p_limit, 1), 200)
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'person', public.person_json(t.p), 'cash', t.cash, 'pct', t.pct
      ) order by case when by_pct then t.pct else t.cash end desc,
                 case when by_pct then t.cash else t.pct end desc, (t.p).created_at), '[]'::jsonb)
      from top t
    );
  end if;

  return (
    with stats as (
      select st.owner as wallet, st.pnl, st.scored_stake as stake
      from public.chain_wallet_stats(net, since) st where p_board = 'own'
      union all
      select bs.author, bs.backer_pnl, bs.backer_stake
      from public.chain_backer_stats(net, since) bs where p_board = 'backers'
    ),
    board as (
      select p, round(coalesce(st.pnl, 0) / 1000000, 2) as cash,
             coalesce(round(st.pnl * 100 / nullif(st.stake, 0), 4), 0) as pct
      from public.profiles p
      left join stats st on st.wallet = p.solana_address
      where p.handle is not null
        and case p_board
              when 'own' then exists (select 1 from public.chain_positions cp where cp.network = net and cp.owner = p.solana_address)
              else exists (select 1 from public.chain_takes ct where ct.network = net and ct.author_wallet = p.solana_address)
            end
    ),
    top as (
      select * from board b
      order by case when by_pct then b.pct else b.cash end desc,
               case when by_pct then b.cash else b.pct end desc, (b.p).created_at
      limit least(greatest(p_limit, 1), 200)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'person', public.person_json(t.p), 'cash', t.cash, 'pct', t.pct
    ) order by case when by_pct then t.pct else t.cash end desc,
               case when by_pct then t.cash else t.pct end desc, (t.p).created_at), '[]'::jsonb)
    from top t
  );
end;
$$;

-- Access ----------------------------------------------------------------------------------------

revoke execute on function public.chain_backer_stats(text, timestamptz) from public;
revoke execute on function public.chain_backers_made(text, text) from public;
revoke execute on function public.leaderboard(text, int, text, text) from public;
grant execute on function public.chain_backer_stats(text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.chain_backers_made(text, text) to anon, authenticated, service_role;
grant execute on function public.leaderboard(text, int, text, text) to anon, authenticated, service_role;
