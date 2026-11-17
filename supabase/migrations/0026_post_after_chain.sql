-- Post only after the chain confirms (docs/hardening-plan.md §6).
--
-- A fork-mode take is created as `posting` and stays hidden from everyone but its author until
-- the chain says it exists: the `takeCreated` event (from the Stream, the fork relay, or the fork
-- API relaying its own confirmed publish) for the author's wallet and the same claim makes it
-- `live`. Nothing a client sends can make a posting take live.
--
--   takes.status            'posting' until the on-chain buy-in confirms, then 'live'. Takes
--                           posted without asking to wait (non-fork builds, older clients) are
--                           live at once, as before.
--   RLS                     anon and authenticated see live takes only, and only the legs,
--                           stats and comments of live takes. The author sees their posting
--                           takes through the social edge function (service role).
--   take_for_chain(id)      one take by id, posting or live, for the fork API, which builds the
--                           on-chain take from it. Only the author has a posting take's id.
--   discard_posting_take    the author drops a take that never made it on-chain.
--   cron                    posting takes older than 24 hours are deleted every hour.

alter table public.takes
  add column status text not null default 'live',
  add constraint takes_status check (status in ('posting', 'live'));

create index takes_posting on public.takes (author_id, created_at) where status = 'posting';

-- Reads: live takes only ------------------------------------------------------------------------

drop policy "takes are public" on public.takes;
create policy "live takes are public" on public.takes for select to anon, authenticated
  using (status = 'live');

-- The subqueries run under the takes policy, so they only find live takes.
drop policy "take legs are public" on public.take_legs;
create policy "legs of live takes are public" on public.take_legs for select to anon, authenticated
  using (exists (select 1 from public.takes t where t.id = take_id));

drop policy "take stats are public" on public.take_stats;
create policy "stats of live takes are public" on public.take_stats for select to anon, authenticated
  using (exists (select 1 from public.takes t where t.id = take_id));

drop policy "comments are public" on public.comments;
create policy "comments on live takes are public" on public.comments for select to anon, authenticated
  using (exists (select 1 from public.takes t where t.id = take_id));

-- Same as 0023_assets, plus the take's status.
create or replace function public.take_json(t public.takes) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'claim', t.claim,
    'topic', t.topic,
    'risk', t.risk,
    'horizon', t.horizon,
    'tags', to_jsonb(t.tags),
    'created_at', t.created_at,
    'settles_at', t.settles_at,
    'status', t.status,
    'author', (select public.person_json(p) from public.profiles p where p.id = t.author_id),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', l.name, 'kind', l.kind, 'weight', l.weight, 'why', l.why,
        'slot', l.slot, 'fade_how', l.fade_how, 'ret', l.ret_pct, 'asset_id', l.asset_id
      ) order by l.idx)
      from public.take_legs l where l.take_id = t.id
    ), '[]'::jsonb),
    'ret', case when c.settled then round(c.result_bps / 100.0, 4) else coalesce(s.ret_pct, 0) end,
    'history', coalesce(to_jsonb(s.history), '[0, 0]'::jsonb),
    'backs', coalesce(c.backers, s.backs, 0),
    'fades', coalesce(c.faders, s.fades, 0),
    'money_in', coalesce(c.backed_usd + c.faded_usd, s.money_in, 0),
    'comments', (select count(*) from public.comments cm where cm.take_id = t.id),
    'on_chain', c.address
  )
  from (select 1) as one
  left join public.take_stats s on s.take_id = t.id
  left join lateral (
    select * from public.chain_takes ct
    where ct.take_id = t.id and ct.network = public.request_network()
    order by ct.created_at desc nulls last
    limit 1
  ) c on true
$$;

-- The fork API's read: a take by id whatever its status. A posting take's id is known only to its
-- author (and the fork API they hand it to), so this shows nobody else anything.
create function public.take_for_chain(p_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select public.take_json(t) from public.takes t where t.id = p_id
$$;

revoke execute on function public.take_for_chain(uuid) from public;
grant execute on function public.take_for_chain(uuid) to anon, authenticated, service_role;

-- The author's takes still waiting for the chain, newest first (social edge function only).
create function public.posting_takes(p_author uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from public.takes t
  where t.author_id = p_author and t.status = 'posting'
$$;

revoke execute on function public.posting_takes(uuid) from public, anon, authenticated;
grant execute on function public.posting_takes(uuid) to service_role;

-- Writes --------------------------------------------------------------------------------------

-- Same as 0023_assets, plus p_status: 'posting' when the client waits for the chain.
drop function public.create_take(uuid, text, text, text, text, text[], jsonb);
create function public.create_take(
  p_author  uuid,
  p_claim   text,
  p_topic   text,
  p_risk    text,
  p_horizon text,
  p_tags    text[],
  p_legs    jsonb,
  p_status  text default 'live'
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

  insert into public.takes (author_id, claim, topic, risk, horizon, tags, settles_at, status)
  values (
    p_author, p_claim, p_topic, p_risk, p_horizon, coalesce(p_tags, '{}'),
    now() + coalesce(make_interval(months => months), make_interval(weeks => weeks), interval '1 month'),
    coalesce(p_status, 'live')
  )
  returning id into tid;

  insert into public.take_legs (take_id, idx, name, kind, weight, why, slot, fade_how, asset_id)
  select
    tid,
    (ord - 1)::smallint,
    leg ->> 'name',
    leg ->> 'kind',
    (leg ->> 'weight')::numeric,
    coalesce(leg ->> 'why', ''),
    coalesce((leg ->> 'slot')::smallint, (ord - 1)::smallint),
    nullif(leg ->> 'fade_how', ''),
    (select s.id from public.securities s where s.id = leg ->> 'asset_id')
  from jsonb_array_elements(p_legs) with ordinality as l(leg, ord);

  return tid;
end;
$$;

revoke execute on function public.create_take(uuid, text, text, text, text, text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.create_take(uuid, text, text, text, text, text[], jsonb, text) to service_role;

-- Drops the author's take if it's still posting. Returns whether it did. Nothing is on-chain for
-- it (the app checks the fork API first), so nothing that can't be deleted is lost.
create function public.discard_posting_take(p_author uuid, p_id uuid) returns boolean
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.takes where id = p_id and author_id = p_author and status = 'posting' returning 1
  )
  select exists (select 1 from gone)
$$;

revoke execute on function public.discard_posting_take(uuid, uuid) from public, anon, authenticated;
grant execute on function public.discard_posting_take(uuid, uuid) to service_role;

-- The chain makes it live ------------------------------------------------------------------------

-- On a takeCreated event: the author's (by wallet) newest posting take with the same claim goes
-- live, its date becomes now, and the on-chain take is linked to it before ingest_chain_events
-- matches by claim alone (which keeps an existing link).
create function public.chain_take_goes_live() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text;
  tid uuid;
begin
  select string_agg(lpad(to_hex(b::integer), 2, '0'), '' order by i)
    into hash
    from jsonb_array_elements_text(new.data -> 'claimHash') with ordinality as x(b, i);

  select t.id into tid
  from public.takes t
  join public.profiles p on p.id = t.author_id
  where t.status = 'posting'
    and p.solana_address = new.data ->> 'author'
    and encode(sha256(convert_to(t.claim, 'UTF8')), 'hex') = hash
  order by t.created_at desc
  limit 1;
  if tid is null then
    return new;
  end if;

  update public.takes set status = 'live', created_at = least(now(), settles_at - interval '1 minute')
  where id = tid;
  insert into public.chain_takes (network, address, take_id)
  values (new.network, new.take, tid)
  on conflict (network, address) do update set take_id = excluded.take_id, updated_at = now();
  return new;
end;
$$;

create trigger chain_events_take_live after insert on public.chain_events
  for each row when (new.name = 'takeCreated') execute function public.chain_take_goes_live();

-- Followers hear about a take when it goes live, not while it's posting.
create or replace function public.notify_new_take() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'live' or (tg_op = 'UPDATE' and old.status = 'live') then
    return new;
  end if;
  perform public.notify(f.follower_id, 'new_take', null, new.author_id, new.id,
    public.notify_name(new.author_id) || ' posted a take', new.claim, '{}'::jsonb, new.id::text)
  from public.follows f
  where f.followee_id = new.author_id;
  return new;
end;
$$;

create trigger takes_notify_followers_live after update of status on public.takes
  for each row execute function public.notify_new_take();

-- Cleanup -----------------------------------------------------------------------------------------

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'delete-stale-posting-takes',
  '7 * * * *',
  $$delete from public.takes where status = 'posting' and created_at < now() - interval '24 hours'$$
);
