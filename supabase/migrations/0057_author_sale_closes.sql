-- No-timeline takes: the author's sale closes the take (decided 2026-11-18).
--
-- A take is a claim and a risk level, with no horizon to pick. Its headline result settles when the
-- author sells their own buy-in: the program then marks the take Closed (no new backs or fades)
-- and emits takeClosed, and later takeSettled with the sale's result. Backers and faders who
-- haven't sold keep running and settle when they sell. A take whose author never sells settles
-- 365 days after posting, at that day's prices.
--
--   create_take          p_horizon is ignored (it may be null): every take is horizon '12mo' (so
--                        older clients still decode it) and settles_at = now() + 365 days, the
--                        "auto-settles by" date the fork API passes on-chain as horizonEnd.
--   chain_takes          closed_at (the author's sale, from takeClosed) and settled_at (the
--                        takeSettled block time).
--   ingest_chain_events  same as 0052_claim_hash_author, plus takeClosed and settled_at.
--   take_json            adds closed_at (null until the author sells), settled and settled_at.
--                        settles_at keeps its name and now means "auto-settles by".
--   notifications        a take_closed kind: holders with open positions hear "@author sold:
--                        closed at +X%. Your position stays open until you sell." The take_settled
--                        that follows an author's sale skips them (their positions keep running).
--   apply_marks          a closed take's return freezes at the sale, as a settled one's does.
--
-- Additive: on a fork without takeClosed events nothing closes, and everything reads as before.
-- Rows from before the fork reset are cleared by the reset cleanup, not here.

-- The column adds below take short exclusive locks: fail fast rather than queue behind a relay
-- insert (as 0054 does).
set lock_timeout = '5s';

-- Posting -------------------------------------------------------------------------------------------

-- Same as 0026_post_after_chain, except the horizon: p_horizon stays in the signature so existing
-- callers keep working, and is ignored.
create or replace function public.create_take(
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
  total numeric;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) not between 1 and 10 then
    raise exception 'legs must be 1 to 10 items' using errcode = '22023';
  end if;

  select sum((leg ->> 'weight')::numeric) into total from jsonb_array_elements(p_legs) leg;
  if total is null or abs(total - 100) > 1 then
    raise exception 'leg weights must add up to 100' using errcode = '22023';
  end if;

  insert into public.takes (author_id, claim, topic, risk, horizon, tags, settles_at, status)
  values (
    p_author, p_claim, p_topic, p_risk, '12mo', coalesce(p_tags, '{}'),
    now() + interval '365 days',
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

-- Chain state -----------------------------------------------------------------------------------------

alter table public.chain_takes
  add column closed_at timestamptz,
  add column settled_at timestamptz;

-- Takes already settled get their date from the event.
update public.chain_takes ct
set settled_at = e.block_time
from (
  select network, take, max(block_time) as block_time
  from public.chain_events
  where name = 'takeSettled'
  group by network, take
) e
where ct.settled and ct.settled_at is null and e.network = ct.network and e.take = ct.address;

create or replace function public.ingest_chain_events(p_network text, p_events jsonb) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  e jsonb;
  d jsonb;
  inserted integer := 0;
  usd numeric;
  hash text;
begin
  if p_network is null or p_network = '' then
    raise exception 'network is required';
  end if;

  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    d := e -> 'data';
    insert into public.chain_events (network, signature, ordinal, slot, block_time, name, take, data)
    values (
      p_network,
      e ->> 'signature',
      (e ->> 'ordinal')::integer,
      (e ->> 'slot')::bigint,
      to_timestamp((e ->> 'block_time')::double precision),
      e ->> 'name',
      d ->> 'take',
      d
    )
    on conflict do nothing;
    if not found then
      continue; -- already ingested
    end if;
    inserted := inserted + 1;

    if e ->> 'name' = 'takeCreated' then
      -- claimHash is the sha256 of the claim text, as 32 byte values.
      select string_agg(lpad(to_hex(b::integer), 2, '0'), '' order by i)
        into hash
        from jsonb_array_elements_text(d -> 'claimHash') with ordinality as x(b, i);
      insert into public.chain_takes (network, address, take_id, author_wallet, claim_hash, created_at)
      values (
        p_network,
        d ->> 'take',
        (
          -- The author's own take with this claim (a demo take: any, see 0052).
          select t.id from public.takes t
          join public.profiles p on p.id = t.author_id
          where t.claim_hash = hash
            and (p.solana_address = d ->> 'author' or (p.is_demo and p.solana_address is null))
          -- The author's own take before a demo take with the same claim.
          order by (p.solana_address = d ->> 'author') desc nulls last, t.created_at desc
          limit 1
        ),
        d ->> 'author',
        hash,
        to_timestamp((e ->> 'block_time')::double precision)
      )
      on conflict (network, address) do update
        set take_id = coalesce(public.chain_takes.take_id, excluded.take_id),
            author_wallet = excluded.author_wallet,
            claim_hash = excluded.claim_hash,
            created_at = coalesce(public.chain_takes.created_at, excluded.created_at),
            updated_at = now();

    elsif e ->> 'name' = 'positionOpened' then
      usd := (d ->> 'stake')::numeric / 1000000;
      -- A take created before ingestion started still gets counted, unmatched.
      insert into public.chain_takes (network, address) values (p_network, d ->> 'take')
        on conflict do nothing;
      update public.chain_takes set
        backers    = backers + (d ->> 'side' = 'back')::integer,
        faders     = faders + (d ->> 'side' = 'fade')::integer,
        backed_usd = backed_usd + case when d ->> 'side' = 'back' then usd else 0 end,
        faded_usd  = faded_usd + case when d ->> 'side' = 'fade' then usd else 0 end,
        updated_at = now()
      where network = p_network and address = d ->> 'take';

    elsif e ->> 'name' = 'takeClosed' then
      -- The author sold their buy-in: no new backs or fades from here.
      insert into public.chain_takes (network, address) values (p_network, d ->> 'take')
        on conflict do nothing;
      update public.chain_takes set
        closed_at = coalesce(
          closed_at,
          case when d ->> 'closedAt' ~ '^[0-9]+$' then to_timestamp((d ->> 'closedAt')::double precision) end,
          to_timestamp((e ->> 'block_time')::double precision)
        ),
        updated_at = now()
      where network = p_network and address = d ->> 'take';

    elsif e ->> 'name' = 'takeSettled' then
      insert into public.chain_takes (network, address) values (p_network, d ->> 'take')
        on conflict do nothing;
      update public.chain_takes set
        settled = true,
        result_bps = (d ->> 'resultBps')::bigint,
        settled_at = coalesce(settled_at, to_timestamp((e ->> 'block_time')::double precision)),
        updated_at = now()
      where network = p_network and address = d ->> 'take';
    end if;
  end loop;
  return inserted;
end;
$$;

-- Reads ---------------------------------------------------------------------------------------------

-- Same as 0054_account_deletion, plus closed_at, settled and settled_at (from the chain, for the
-- network the request names; without one, null / false / null).
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
    'closed_at', c.closed_at,
    'settled', coalesce(c.settled, false),
    'settled_at', c.settled_at,
    'status', t.status,
    'author', coalesce((select public.person_json(p) from public.profiles p where p.id = t.author_id),
                       public.deleted_person_json()),
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
    'on_chain', c.address,
    'source', case when t.source_url is null then null else jsonb_build_object(
      'url', t.source_url, 'label', t.source_label, 'kind', t.source_kind) end
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

-- Notifications ---------------------------------------------------------------------------------------

alter table public.notifications drop constraint notifications_kind;
alter table public.notifications add constraint notifications_kind check (kind in
  ('new_take', 'comment', 'take_traded', 'take_faded', 'take_settled', 'badge', 'daily_positions',
   'liquidation_risk', 'x_call', 'take_closed'));

-- Same as 0022_notifications, plus takeClosed, and a take_settled after the author's sale that
-- leaves out the positions still open.
create or replace function public.notify_chain_event() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := new.data;
  ct public.chain_takes;
  take_author uuid;
  claim text;
  owner_profile uuid;
  ret numeric;
  key text := new.signature || ':' || new.ordinal;
begin
  if new.take is not null then
    select * into ct from public.chain_takes c where c.network = new.network and c.address = new.take;
    if ct.take_id is not null then
      select t.author_id, t.claim into take_author, claim from public.takes t where t.id = ct.take_id;
    end if;
  end if;

  if new.name = 'positionOpened' then
    -- Not the author's own buy-in (create_take opens it).
    if take_author is null or d ->> 'owner' = ct.author_wallet then
      return new;
    end if;
    select p.id into owner_profile from public.profiles p where p.solana_address = d ->> 'owner';
    if d ->> 'side' = 'fade' then
      perform public.notify(take_author, 'take_faded', new.network, owner_profile, ct.take_id,
        public.notify_name(owner_profile) || ' faded your take · ' || public.notify_usd(d ->> 'stake'), claim,
        jsonb_build_object('stake', d ->> 'stake'), key);
    else
      perform public.notify(take_author, 'take_traded', new.network, owner_profile, ct.take_id,
        public.notify_name(owner_profile) || ' traded your take · ' || public.notify_usd(d ->> 'stake'), claim,
        jsonb_build_object('stake', d ->> 'stake'), key);
    end if;

  elsif new.name = 'takeClosed' then
    if ct.take_id is null then
      return new;
    end if;
    -- The take's headline return as it stood at the sale (the marker stops moving it now).
    select s.ret_pct into ret from public.take_stats s where s.take_id = ct.take_id;
    -- Everyone else still holding a position on it (backers and faders with a profile). notify()
    -- skips the author, who is the actor.
    perform public.notify(x.profile_id, 'take_closed', new.network, take_author, ct.take_id,
      public.notify_name(take_author, 'The author') || ' sold: closed at '
        || to_char(round(coalesce(ret, 0), 1), 'FMS9999990.0') || '%. Your position stays open until you sell.',
      claim, jsonb_build_object('ret_pct', coalesce(ret, 0)), new.take)
    from (
      select distinct p.id as profile_id
      from public.chain_positions cp
      join public.profiles p on p.solana_address = cp.owner
      where cp.network = new.network and cp.take = new.take
        and cp.exited_at is null and cp.settled_at is null
        and cp.owner is distinct from ct.author_wallet
    ) x;

  elsif new.name = 'takeSettled' then
    if ct.take_id is null then
      return new;
    end if;
    -- Everyone holding a position on it (backers and faders with a profile), and the author. After
    -- the author's sale closed it, positions still open aren't settled by this: their owners heard
    -- at the close (take_closed), so they're left out.
    perform public.notify(x.profile_id, 'take_settled', new.network, null, ct.take_id,
      'A take you''re in settled at ' || to_char(round((d ->> 'resultBps')::numeric / 100, 1), 'FMS9999990.0') || '%',
      claim, jsonb_build_object('result_bps', d ->> 'resultBps'), new.take)
    from (
      select distinct p.id as profile_id
      from public.chain_events e
      join public.profiles p on p.solana_address = e.data ->> 'owner'
      where e.network = new.network and e.take = new.take and e.name = 'positionOpened'
        and not (ct.closed_at is not null and exists (
          select 1 from public.chain_positions cp
          where cp.network = new.network and cp.address = e.data ->> 'position'
            and cp.exited_at is null and cp.settled_at is null))
      union
      select take_author
    ) x
    where x.profile_id is not null;

  elsif new.name = 'badgeMinted' then
    select p.id into owner_profile from public.profiles p where p.solana_address = d ->> 'owner';
    perform public.notify(owner_profile, 'badge', new.network, null, null,
      'You earned a badge: ' || case d ->> 'kind'
        when 'firstTake' then 'First take posted'
        when 'firstOver50' then 'First take at +50%'
        when 'firstOver100' then 'First take at +100%'
        when 'tenOver50' then 'Ten takes at +50%'
        when 'over1000' then 'A take at +1,000%'
        else 'Called it' end,
      'Non-transferable, on-chain.', jsonb_build_object('kind', d ->> 'kind', 'mint', d ->> 'mint'), d ->> 'mint');
  end if;
  return new;
end;
$$;

-- Live marks ------------------------------------------------------------------------------------------

-- Same as 0038_live_marks, except that a take closed by its author's sale is frozen like a settled
-- one: its picks and headline return stay where the sale left them. Open positions on it keep
-- their live returns.
create or replace function public.apply_marks(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  every_secs int := coalesce((p ->> 'history_every_secs')::int, 3600);
  keep int := least(greatest(coalesce((p ->> 'history_max')::int, 240), 2), 1000);
  n_legs int := 0;
  n_takes int := 0;
  n_positions int := 0;
begin
  if jsonb_typeof(coalesce(p -> 'legs', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p -> 'takes', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p -> 'positions', '[]')) <> 'array' then
    raise exception 'legs, takes and positions must be arrays' using errcode = '22023';
  end if;

  with x as (
    select (e ->> 'take_id')::uuid as take_id,
           (e ->> 'idx')::smallint as idx,
           (e ->> 'mark_price')::double precision as mark_price,
           coalesce((e ->> 'marked_at')::timestamptz, now()) as marked_at,
           (e ->> 'ret_pct')::numeric as ret_pct,
           (e ->> 'base_price')::double precision as base_price,
           (e ->> 'base_at')::timestamptz as base_at,
           e -> 'base_source' as base_source
    from jsonb_array_elements(coalesce(p -> 'legs', '[]')) e
  )
  update public.take_legs l
  set mark_price  = x.mark_price,
      marked_at   = x.marked_at,
      ret_pct     = round(greatest(x.ret_pct, -100), 4),
      base_price  = coalesce(l.base_price, x.base_price),
      base_at     = case when l.base_price is null then x.base_at else l.base_at end,
      base_source = case when l.base_price is null then x.base_source else l.base_source end
  from x
  join public.takes t on t.id = x.take_id
  where l.take_id = x.take_id and l.idx = x.idx
    and x.mark_price is not null and x.ret_pct is not null
    and (l.base_price is not null or x.base_price is not null)
    and t.settles_at > now()
    and not exists (select 1 from public.chain_takes c where c.take_id = t.id and (c.settled or c.closed_at is not null));
  get diagnostics n_legs = row_count;

  with x as (
    select (e ->> 'take_id')::uuid as take_id, round(greatest((e ->> 'ret_pct')::numeric, -100), 4) as ret_pct
    from jsonb_array_elements(coalesce(p -> 'takes', '[]')) e
    where e ->> 'ret_pct' is not null
  )
  update public.take_stats s
  set ret_pct = x.ret_pct,
      history = case
        -- Within the hour: move the latest point. Otherwise add one, keeping the last `keep`.
        when s.history_at is not null and now() - s.history_at < make_interval(secs => every_secs) and cardinality(s.history) >= 2
          then s.history[1:cardinality(s.history) - 1] || x.ret_pct
        else (case when s.history_at is null then array[0::numeric(9, 4)] else s.history end || x.ret_pct)
             [greatest(1, cardinality(case when s.history_at is null then array[0::numeric(9, 4)] else s.history end) + 2 - keep):]
      end,
      history_at = case
        when s.history_at is not null and now() - s.history_at < make_interval(secs => every_secs) and cardinality(s.history) >= 2
          then s.history_at
        else now()
      end
  from x
  join public.takes t on t.id = x.take_id
  where s.take_id = x.take_id
    and t.settles_at > now()
    and not exists (select 1 from public.chain_takes c where c.take_id = t.id and (c.settled or c.closed_at is not null));
  get diagnostics n_takes = row_count;

  with x as (
    select e ->> 'network' as network, e ->> 'address' as address, (e ->> 'live_return_bps')::bigint as bps
    from jsonb_array_elements(coalesce(p -> 'positions', '[]')) e
    where e ->> 'live_return_bps' is not null
  )
  update public.chain_positions cp
  set live_return_bps = greatest(x.bps, -10000),
      live_marked_at  = now()
  from x
  where cp.network = x.network and cp.address = x.address and cp.settled_at is null;
  get diagnostics n_positions = row_count;

  return jsonb_build_object('legs', n_legs, 'takes', n_takes, 'positions', n_positions);
end;
$$;
