-- Leaderboards: lowest first, and where you stand.
--
--   leaderboard(period, limit, board, sort, dir, viewer)
--     p_dir     'desc' (default: best first, as before) or 'asc' (lowest first). It turns both the
--               ranking and the order of the rows; the earliest account still breaks ties.
--     p_viewer  a profile id. Without it the answer is the same array as before, so existing
--               callers don't change. With it the answer is an object:
--                 { rows: [...the same rows...], viewer: { rank, cash, pct, person } | null }
--               where rank is the viewer's place on the whole board (not only the rows returned),
--               in the same direction, and viewer is null when they aren't on the board.
--
-- Same boards, rules and sources as 0031_fader_board ('own', 'backers', 'faders'; the play-money
-- board without a network header). The old four-argument function is replaced, so a call with
-- fewer arguments can't be ambiguous; its grants are given again.

drop function public.leaderboard(text, int, text, text);

create function public.leaderboard(
  p_period text,
  p_limit int default 100,
  p_board text default 'own',
  p_sort text default 'cash',
  p_dir text default 'desc',
  p_viewer uuid default null
)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  net text := public.request_network();
  since timestamptz := case p_period when 'week' then now() - interval '7 days'
                                      when 'month' then now() - interval '30 days' end;
  by_pct boolean := p_sort = 'pct';
  -- Lowest first is the same ranking with both sort keys negated.
  d numeric := case when p_dir = 'asc' then -1 else 1 end;
  lim int := least(greatest(p_limit, 1), 200);
  board_rows jsonb := '[]'::jsonb;
  viewer_row jsonb;
begin
  if p_board not in ('own', 'backers', 'faders') or p_sort not in ('cash', 'pct') or p_dir not in ('desc', 'asc') then
    raise exception 'unknown board, sort or direction' using errcode = '22023';
  end if;

  -- Without a network there's only the play-money 'own' board.
  if net is not null or p_board = 'own' then
    with stats as (
      select st.owner as wallet, st.pnl, st.scored_stake as stake
      from public.chain_wallet_stats(net, since) st where net is not null and p_board = 'own'
      union all
      select bs.author, bs.backer_pnl, bs.backer_stake
      from public.chain_backer_stats(net, since) bs where net is not null and p_board = 'backers'
      union all
      select fs.owner, fs.fade_pnl, fs.fade_stake
      from public.chain_fader_stats(net, since) fs where net is not null and p_board = 'faders'
    ),
    board as (
      -- The play-money board (no network).
      select p, coalesce(s.cash, 0) as cash, coalesce(s.pct, 0) as pct
      from public.profiles p
      left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
      where net is null and p.handle is not null
      union all
      -- The chain boards: profiles with activity on that network.
      select p, round(coalesce(st.pnl, 0) / 1000000, 2),
             coalesce(round(st.pnl * 100 / nullif(st.stake, 0), 4), 0)
      from public.profiles p
      left join stats st on st.wallet = p.solana_address
      where net is not null and p.handle is not null
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
    ranked as (
      select b.p, b.cash, b.pct,
             row_number() over (
               order by d * case when by_pct then b.pct else b.cash end desc,
                        d * case when by_pct then b.cash else b.pct end desc,
                        (b.p).created_at
             ) as rnk
      from board b
    )
    select
      (select coalesce(jsonb_agg(jsonb_build_object(
         'person', public.person_json(r.p), 'cash', r.cash, 'pct', r.pct
       ) order by r.rnk), '[]'::jsonb)
       from ranked r where r.rnk <= lim),
      (select jsonb_build_object('rank', v.rnk, 'cash', v.cash, 'pct', v.pct, 'person', public.person_json(v.p))
       from ranked v where p_viewer is not null and (v.p).id = p_viewer)
    into board_rows, viewer_row;
  end if;

  if p_viewer is null then
    return board_rows;
  end if;
  return jsonb_build_object('rows', board_rows, 'viewer', viewer_row);
end;
$$;

revoke execute on function public.leaderboard(text, int, text, text, text, uuid) from public;
grant execute on function public.leaderboard(text, int, text, text, text, uuid) to anon, authenticated, service_role;
