-- Who traded / faded a take, for the take page ("You, Priya and 22 others
-- traded") and its Traders sheet.
--
-- The ledger is private (balances, deposits, withdrawals), so this runs as
-- security definer and exposes only the public part: for one take, each
-- person's side and total amount. Trades and fades are public by design.
-- Order: you first, then people you follow, then most recent.

create function public.take_traders(p_take uuid, p_viewer uuid default null, p_limit int default 100)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with positions as (
    select l.profile_id, l.kind, sum(-l.amount) as amount, max(l.created_at) as last_at
    from public.ledger l
    where l.take_id = p_take
      and l.profile_id is not null
      and l.kind in ('trade', 'fade')
    group by l.profile_id, l.kind
  ),
  ranked as (
    select pos.*,
      pos.profile_id = p_viewer as is_you,
      exists (select 1 from public.follows f where f.follower_id = p_viewer and f.followee_id = pos.profile_id) as you_follow
    from positions pos
    order by (pos.profile_id = p_viewer) desc, you_follow desc, pos.last_at desc
    limit least(greatest(p_limit, 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'person', public.person_json(p),
    'side', r.kind,
    'amount', r.amount,
    'is_you', coalesce(r.is_you, false),
    'you_follow', r.you_follow
  ) order by coalesce(r.is_you, false) desc, r.you_follow desc, r.last_at desc), '[]'::jsonb)
  from ranked r
  join public.profiles p on p.id = r.profile_id
  where p.handle is not null
$$;

revoke execute on function public.take_traders(uuid, uuid, int) from public;
grant execute on function public.take_traders(uuid, uuid, int) to anon, authenticated, service_role;
