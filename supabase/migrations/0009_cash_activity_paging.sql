-- Cash activity paging: the full history, a page at a time.
--
-- cash_summary returns the newest page plus has_more; cash_activity returns
-- the page after a cursor (the last entry you have: its created_at and id, so
-- entries with the same timestamp are never skipped or repeated).

create function public.cash_activity(
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
        'take_claim', t.claim
      ) order by s.created_at desc, s.id desc)
      from shown s
      left join public.takes t on t.id = s.take_id
    ), '[]'::jsonb),
    'has_more', (select count(*) from page) > least(greatest(p_limit, 1), 200)
  )
$$;

-- Same shape as before, plus has_more.
create or replace function public.cash_summary(p_profile uuid, p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'balance', public.cash_balance(p_profile),
    'rules', public.cash_rules()
  ) || public.cash_activity(p_profile, null, null, p_limit)
$$;

revoke execute on function public.cash_activity(uuid, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public.cash_activity(uuid, timestamptz, uuid, int) to service_role;
