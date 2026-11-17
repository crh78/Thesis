-- The fader board: who made the most, in dollars and in percent, from
-- fading other people's takes. A third board next to own P&L and made for backers
-- (0030_two_scores), with the same rules: settled positions that scored only (sales
-- included), periods by the settlement's block time, ranked by dollars or by percent.
--
--   chain_fader_stats()   per wallet: scored stake and P&L of its fades of other people's takes,
--                         optionally since a date.
--   leaderboard()         accepts the board 'faders': profiles with a fade on that network.

-- Per wallet on p_network, for fades settled since p_since (all time when null). Amounts in USDC
-- base units. A fade of the wallet's own take doesn't count.
create function public.chain_fader_stats(p_network text, p_since timestamptz default null)
returns table (owner text, fade_stake numeric, fade_pnl numeric, fades bigint)
language sql stable
set search_path = ''
as $$
  select cp.owner, coalesce(sum(cp.stake), 0), coalesce(sum(cp.pnl), 0), count(*)
  from public.chain_positions cp
  left join public.chain_takes ct on ct.network = cp.network and ct.address = cp.take
  where cp.network = p_network and cp.side = 'fade' and cp.scored and cp.settled_at is not null
    and cp.owner is distinct from ct.author_wallet
    and (p_since is null or cp.settled_at >= p_since)
  group by cp.owner
$$;

revoke execute on function public.chain_fader_stats(text, timestamptz) from public;
grant execute on function public.chain_fader_stats(text, timestamptz) to anon, authenticated, service_role;

-- Same as 0030_two_scores, plus the 'faders' board.
create or replace function public.leaderboard(p_period text, p_limit int default 100, p_board text default 'own', p_sort text default 'cash')
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
  if p_board not in ('own', 'backers', 'faders') or p_sort not in ('cash', 'pct') then
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
      union all
      select fs.owner, fs.fade_pnl, fs.fade_stake
      from public.chain_fader_stats(net, since) fs where p_board = 'faders'
    ),
    board as (
      select p, round(coalesce(st.pnl, 0) / 1000000, 2) as cash,
             coalesce(round(st.pnl * 100 / nullif(st.stake, 0), 4), 0) as pct
      from public.profiles p
      left join stats st on st.wallet = p.solana_address
      where p.handle is not null
        and case p_board
              when 'own' then exists (select 1 from public.chain_positions cp where cp.network = net and cp.owner = p.solana_address)
              when 'backers' then exists (select 1 from public.chain_takes ct where ct.network = net and ct.author_wallet = p.solana_address)
              else exists (
                select 1 from public.chain_positions cp
                left join public.chain_takes ct on ct.network = cp.network and ct.address = cp.take
                where cp.network = net and cp.owner = p.solana_address and cp.side = 'fade'
                  and cp.owner is distinct from ct.author_wallet)
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
