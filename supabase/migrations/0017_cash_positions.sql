-- Your positions: every take you've traded or faded, from the ledger.
--
-- One row per take and side (trading and fading the same take are separate
-- positions): how much you've put in, how many times, first and latest. The
-- take comes with its current stats, so the app can show its return. Private:
-- service role only, served by the `cash` function (GET /cash/positions).
-- Positions don't settle or pay out yet: that's paper trading's job.

create function public.cash_positions(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'take', public.take_json(t),
    'side', g.kind,
    'amount', g.total,
    'count', g.n,
    'first_at', g.first_at,
    'last_at', g.last_at
  ) order by g.last_at desc), '[]'::jsonb)
  from (
    select take_id, kind, -sum(amount) as total, count(*) as n,
           min(created_at) as first_at, max(created_at) as last_at
    from public.ledger
    where profile_id = p_profile and kind in ('trade', 'fade')
    group by take_id, kind
  ) g
  join public.takes t on t.id = g.take_id
$$;

revoke execute on function public.cash_positions(uuid) from public, anon, authenticated;
grant execute on function public.cash_positions(uuid) to service_role;
