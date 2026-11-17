-- Posting a take writes the take and its legs in one transaction.
-- Called only by the `social` edge function (service role), which has already
-- verified the author and validated the input; the table constraints check again.

create function public.create_take(
  p_author  uuid,
  p_claim   text,
  p_topic   text,
  p_risk    text,
  p_horizon text,
  p_tags    text[],
  p_legs    jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  tid uuid;
  months int;
  weeks int;
  total numeric;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) not between 1 and 10 then
    raise exception 'legs must be 1 to 10 items' using errcode = '22023';
  end if;

  select sum((leg ->> 'weight')::numeric) into total from jsonb_array_elements(p_legs) leg;
  if total is null or abs(total - 100) > 1 then
    raise exception 'leg weights must add up to 100' using errcode = '22023';
  end if;

  months := nullif(substring(p_horizon from '^([0-9]+)mo$'), '')::int;
  weeks := nullif(substring(p_horizon from '^([0-9]+)wk$'), '')::int;

  insert into public.takes (author_id, claim, topic, risk, horizon, tags, settles_at)
  values (
    p_author, p_claim, p_topic, p_risk, p_horizon, coalesce(p_tags, '{}'),
    now() + coalesce(make_interval(months => months), make_interval(weeks => weeks), interval '1 month')
  )
  returning id into tid;

  insert into public.take_legs (take_id, idx, name, kind, weight, why, slot, fade_how)
  select
    tid,
    (ord - 1)::smallint,
    leg ->> 'name',
    leg ->> 'kind',
    (leg ->> 'weight')::numeric,
    coalesce(leg ->> 'why', ''),
    coalesce((leg ->> 'slot')::smallint, (ord - 1)::smallint),
    nullif(leg ->> 'fade_how', '')
  from jsonb_array_elements(p_legs) with ordinality as l(leg, ord);

  return tid;
end;
$$;

revoke execute on function public.create_take(uuid, text, text, text, text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.create_take(uuid, text, text, text, text, text[], jsonb) to service_role;
