-- Inverted takes: a take that bets against its basket (decided 2026-11-20).
--
-- "Crypto sucks" is a bearish take on a bullish basket (BTC, ETH, SOL perps). On-chain the take
-- is marked inverted (Take.inverted; takeCreated carries `inverted`) and its author's buy-in is a
-- Fade. Whoever agrees with the take holds a Fade; whoever disagrees holds a Back. Every leg of an
-- inverted take can be faded (the program refuses one that can't).
--
-- Storage stays literal: chain_takes.backers / faders / backed_usd / faded_usd, chain_positions.side
-- and chain_position_parts.side keep the on-chain sides. A positionOpened can arrive before the
-- takeCreated that says the take is inverted, so nothing flips at ingest. Reads flip:
--
--   takes, take_drafts   inverted (not null, default false).
--   chain_takes          inverted, from takeCreated (null until it arrives).
--   create_take          p_inverted (default false), stored on the take. An inverted take needs
--                        every leg fadeable (a fade_how).
--   ingest_chain_events  takeCreated writes chain_takes.inverted, and the claim-hash fallback only
--                        links an app take with the same inverted.
--   chain_take_goes_live a posting take goes live only on a takeCreated with its inverted.
--   take_json            inverted, and backs / fades as agree / disagree: on an inverted take,
--                        backs are its on-chain faders and fades its on-chain backers. ret stays the
--                        author's return. A leg's ret stays the basket's own move.
--   chain_backer_stats, chain_backers_made
--                        "backers" are the people who agreed (on-chain faders of an inverted take).
--   chain_fader_stats, leaderboard 'faders'
--                        "faders" are the people who disagreed (on-chain backers of one).
--   notify_chain_event   take_traded for someone agreeing, take_faded for someone disagreeing.
--   take_draft           inverted.
--   take_for_chain       inverted, through take_json.
--
-- Additive: with no inverted takes every number reads as before.

-- The column adds below take short exclusive locks: fail fast rather than queue behind a relay
-- insert (as 0054 does).
set lock_timeout = '5s';

-- Tables --------------------------------------------------------------------------------------------

alter table public.takes add column inverted boolean not null default false;
alter table public.take_drafts add column inverted boolean not null default false;
-- Null until takeCreated says (a positionOpened can create the row first).
alter table public.chain_takes add column inverted boolean;

-- Takes already created on-chain weren't inverted: the program had no such thing.
update public.chain_takes set inverted = false where inverted is null and author_wallet is not null;

-- Posting -------------------------------------------------------------------------------------------

-- Same as 0057_author_sale_closes, plus p_inverted. A new parameter can't be added with create or
-- replace (the old signature would stay as an ambiguous overload): dropped and made again, with its
-- grants.
drop function public.create_take(uuid, text, text, text, text, text[], jsonb, text);
create function public.create_take(
  p_author   uuid,
  p_claim    text,
  p_topic    text,
  p_risk     text,
  p_horizon  text,
  p_tags     text[],
  p_legs     jsonb,
  p_status   text default 'live',
  p_inverted boolean default false
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

  -- The author's buy-in fades every leg, so each must be one that can be faded.
  if coalesce(p_inverted, false)
     and exists (select 1 from jsonb_array_elements(p_legs) leg where nullif(leg ->> 'fade_how', '') is null) then
    raise exception 'an inverted take needs every leg fadeable' using errcode = '22023';
  end if;

  insert into public.takes (author_id, claim, topic, risk, horizon, tags, settles_at, status, inverted)
  values (
    p_author, p_claim, p_topic, p_risk, '12mo', coalesce(p_tags, '{}'),
    now() + interval '365 days',
    coalesce(p_status, 'live'),
    coalesce(p_inverted, false)
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

revoke execute on function public.create_take(uuid, text, text, text, text, text[], jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.create_take(uuid, text, text, text, text, text[], jsonb, text, boolean) to service_role;

-- Chain state -----------------------------------------------------------------------------------------

-- Same as 0057_author_sale_closes, plus takeCreated's inverted (false when the event has none), and
-- the claim-hash fallback matching it.
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
      insert into public.chain_takes (network, address, take_id, author_wallet, claim_hash, created_at, inverted)
      values (
        p_network,
        d ->> 'take',
        (
          -- The author's own take with this claim (a demo take: any, see 0052), inverted the same way.
          select t.id from public.takes t
          join public.profiles p on p.id = t.author_id
          where t.claim_hash = hash
            and t.inverted = coalesce((d ->> 'inverted')::boolean, false)
            and (p.solana_address = d ->> 'author' or (p.is_demo and p.solana_address is null))
          -- The author's own take before a demo take with the same claim.
          order by (p.solana_address = d ->> 'author') desc nulls last, t.created_at desc
          limit 1
        ),
        d ->> 'author',
        hash,
        to_timestamp((e ->> 'block_time')::double precision),
        coalesce((d ->> 'inverted')::boolean, false)
      )
      on conflict (network, address) do update
        set take_id = coalesce(public.chain_takes.take_id, excluded.take_id),
            author_wallet = excluded.author_wallet,
            claim_hash = excluded.claim_hash,
            created_at = coalesce(public.chain_takes.created_at, excluded.created_at),
            inverted = excluded.inverted,
            updated_at = now();

    elsif e ->> 'name' = 'positionOpened' then
      usd := (d ->> 'stake')::numeric / 1000000;
      -- A take created before ingestion started still gets counted, unmatched. The on-chain sides,
      -- as they are: take_json reads them as agree / disagree.
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

-- Same as 0052_claim_hash_author, plus the event's inverted (false when it has none): a posting
-- take goes live only on an on-chain take that bets the same way.
create or replace function public.chain_take_goes_live() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text;
  horizon_sec bigint;
  tid uuid;
  found int;
begin
  select string_agg(lpad(to_hex(b::integer), 2, '0'), '' order by i)
    into hash
    from jsonb_array_elements_text(new.data -> 'claimHash') with ordinality as x(b, i);
  horizon_sec := case when new.data ->> 'horizonEnd' ~ '^[0-9]+$' then (new.data ->> 'horizonEnd')::bigint end;

  select min(t.id::text)::uuid, count(*) into tid, found
  from public.takes t
  join public.profiles p on p.id = t.author_id
  where t.status = 'posting'
    and p.solana_address = new.data ->> 'author'
    and t.claim_hash = hash
    and t.inverted = coalesce((new.data ->> 'inverted')::boolean, false)
    and (horizon_sec is null or floor(extract(epoch from t.settles_at))::bigint = horizon_sec);
  if found <> 1 then
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

-- Reads ---------------------------------------------------------------------------------------------

-- Same as 0057_author_sale_closes, plus inverted, and the chain's counts as agree / disagree: on an
-- inverted take (the chain's flag, else the app take's while takeCreated hasn't arrived) backs are
-- its on-chain faders and fades its on-chain backers. The play-money counts already are.
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
    'inverted', t.inverted,
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
    'backs', coalesce(case when coalesce(c.inverted, t.inverted) then c.faders else c.backers end, s.backs, 0),
    'fades', coalesce(case when coalesce(c.inverted, t.inverted) then c.backers else c.faders end, s.fades, 0),
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

-- Same as 0056_take_draft_for_x, plus inverted.
create or replace function public.take_draft(p_id text) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id, 'claim', d.claim, 'risk', d.risk, 'horizon', d.horizon, 'summary', d.summary,
    'legs', d.legs, 'origin', d.origin, 'context', d.context, 'created_at', d.created_at,
    'source', case when d.source_url is null then null
      else jsonb_build_object('url', d.source_url, 'label', d.source_label, 'kind', d.source_kind) end,
    'take_id', case when t.status = 'live' then t.id end,
    'for_x', d.for_x,
    'inverted', d.inverted
  )
  from public.take_drafts d
  left join public.takes t on t.id = d.take_id
  where d.id = p_id
$$;

-- Scores ----------------------------------------------------------------------------------------------

-- Same as 0058_partial_sales, with backers as the people who agreed: the on-chain faders of an
-- inverted take.
create or replace function public.chain_backer_stats(p_network text, p_since timestamptz default null)
returns table (author text, backer_stake numeric, backer_pnl numeric, backers bigint)
language sql stable
set search_path = ''
as $$
  select ct.author_wallet, coalesce(sum(r.stake), 0), coalesce(sum(r.pnl), 0), count(distinct r.owner)
  from public.chain_realizations(p_network, p_since) r
  join public.chain_takes ct on ct.network = p_network and ct.address = r.take
  where r.side = case when coalesce(ct.inverted, false) then 'fade' else 'back' end and r.scored
    and ct.author_wallet is not null and r.owner <> ct.author_wallet
  group by ct.author_wallet
$$;

-- Same as 0058_partial_sales, with backers as the people who agreed.
create or replace function public.chain_backers_made(p_network text, p_wallet text, out made numeric, out pct numeric)
language sql stable
set search_path = ''
as $$
  select coalesce(round(sum(r.pnl) / 1000000, 2), 0),
         coalesce(round(sum(r.pnl) * 100 / nullif(sum(r.stake), 0), 4), 0)
  from public.chain_realization_rows r
  join public.chain_takes ct on ct.network = r.network and ct.address = r.take
  where r.network = p_network and ct.author_wallet = p_wallet and r.owner <> p_wallet
    and r.side = case when coalesce(ct.inverted, false) then 'fade' else 'back' end
    and r.scored and r.settled_at is not null
$$;

-- Same as 0058_partial_sales, with faders as the people who disagreed: the on-chain backers of an
-- inverted take. A take ingestion never saw created reads as not inverted.
create or replace function public.chain_fader_stats(p_network text, p_since timestamptz default null)
returns table (owner text, fade_stake numeric, fade_pnl numeric, fades bigint)
language sql stable
set search_path = ''
as $$
  select r.owner, coalesce(sum(r.stake), 0), coalesce(sum(r.pnl), 0), count(distinct r.position)
  from public.chain_realizations(p_network, p_since) r
  left join public.chain_takes ct on ct.network = p_network and ct.address = r.take
  where r.side = case when coalesce(ct.inverted, false) then 'back' else 'fade' end and r.scored
    and r.owner is distinct from ct.author_wallet
  group by r.owner
$$;

-- Same as 0055_leaderboard_dir_viewer, except who is on the 'faders' board: the people who
-- disagreed with someone's take (on-chain backers of an inverted one). Same signature and grants.
create or replace function public.leaderboard(
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
                where cp.network = net and cp.owner = p.solana_address
                  and cp.side = case when coalesce(ct.inverted, false) then 'back' else 'fade' end
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

-- Notifications ---------------------------------------------------------------------------------------

-- Same as 0057_author_sale_closes, except that a position is take_traded when it agrees with the
-- take and take_faded when it disagrees: on an inverted take an on-chain fade agrees.
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
    -- Disagrees: a fade, or on an inverted take a back.
    if (d ->> 'side' = 'fade') is distinct from coalesce(ct.inverted, false) then
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
