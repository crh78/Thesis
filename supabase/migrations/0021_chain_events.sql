-- Thesis program activity from the chain, as the QuickNode Stream (mainnet) or the fork relay
-- (scripts/fork, network "solana-mainnet-fork") delivers it to functions/quicknode-stream.
--
--   chain_events   every decoded program event, once (keyed by network, signature, ordinal)
--   chain_takes    one row per on-chain take: which app take it is, and its live counters
--
-- The webhook calls ingest_chain_events() with the decoded events; it's idempotent, so the
-- Stream's retries and reorg re-deliveries are harmless.
--
-- Reads: take_json() (every feed card and take page) shows a take's on-chain backers, faders,
-- money in and settled result instead of the backend's play-money numbers when the request
-- names a network in the `x-thesis-network` header and the take is on-chain there. Fork-mode
-- builds send "solana-mainnet-fork"; other builds send nothing and see what they saw before.

create table public.chain_events (
  network    text not null,
  signature  text not null,
  -- The event's index among the transaction's Thesis events.
  ordinal    integer not null,
  slot       bigint,
  block_time timestamptz,
  -- Event name as the IDL decodes it: takeCreated, positionOpened, takeSettled, ...
  name       text not null,
  -- The take the event is about, when it names one.
  take       text,
  -- The event's fields as JSON (keys base58, integers as decimal strings, enums as names).
  data       jsonb not null,
  received_at timestamptz not null default now(),

  primary key (network, signature, ordinal)
);

create index chain_events_take on public.chain_events (network, take);

create table public.chain_takes (
  network      text not null,
  address      text not null,
  -- The app's take: the latest one whose claim hashes to the on-chain claim_hash. Null if none.
  take_id      uuid references public.takes (id) on delete set null,
  author_wallet text,
  claim_hash   text,
  backers      integer not null default 0,
  faders       integer not null default 0,
  backed_usd   numeric(14, 2) not null default 0,
  faded_usd    numeric(14, 2) not null default 0,
  settled      boolean not null default false,
  result_bps   bigint,
  created_at   timestamptz,
  updated_at   timestamptz not null default now(),

  primary key (network, address)
);

create index chain_takes_take on public.chain_takes (take_id, network);

alter table public.chain_events enable row level security;
alter table public.chain_takes enable row level security;

-- On-chain counters are public, like the chain itself. Raw events are service role only.
create policy "chain takes are public" on public.chain_takes for select to anon, authenticated using (true);

revoke all on public.chain_events, public.chain_takes from anon, authenticated;
grant select on public.chain_takes to anon, authenticated;
grant select, insert, update, delete on public.chain_events, public.chain_takes to service_role;

-- Ingest ---------------------------------------------------------------------------------------

-- p_events: [{ signature, ordinal, slot, block_time (unix s), name, data }]. Returns how many
-- events were new. Each new event updates chain_takes once, so replays never double-count.
create function public.ingest_chain_events(p_network text, p_events jsonb) returns integer
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
          select t.id from public.takes t
          where encode(sha256(convert_to(t.claim, 'UTF8')), 'hex') = hash
          order by t.created_at desc
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

    elsif e ->> 'name' = 'takeSettled' then
      insert into public.chain_takes (network, address) values (p_network, d ->> 'take')
        on conflict do nothing;
      update public.chain_takes set
        settled = true,
        result_bps = (d ->> 'resultBps')::bigint,
        updated_at = now()
      where network = p_network and address = d ->> 'take';
    end if;
  end loop;
  return inserted;
end;
$$;

revoke all on function public.ingest_chain_events(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_chain_events(text, jsonb) to service_role;

-- Reads ----------------------------------------------------------------------------------------

-- The network the caller asked to see chain data for (`x-thesis-network` request header), or null.
create function public.request_network() returns text
language sql stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true)::jsonb ->> 'x-thesis-network', '')
$$;

-- Same as before, except that with a network header a take that's on-chain there shows its
-- on-chain backers, faders, money in and (once settled) result. A demo take mirrored more than
-- once uses its latest mirror.
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
    'author', (select public.person_json(p) from public.profiles p where p.id = t.author_id),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', l.name, 'kind', l.kind, 'weight', l.weight, 'why', l.why,
        'slot', l.slot, 'fade_how', l.fade_how, 'ret', l.ret_pct
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
