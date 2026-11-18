-- An on-chain take is linked only to its own author's take, found through an indexed claim hash.
--
-- When chain_take_goes_live (0047) doesn't link a takeCreated event (no posting row matched, or
-- the take was already live), ingest_chain_events (0021) fell back to the newest take anywhere with
-- the same claim text, whoever wrote it. With short, common claims ("Bitcoin goes up") that linked
-- one user's on-chain take, its backers, money in and result to another user's take, and told the
-- wrong author about trades. It also hashed every take's claim on each event.
--
--   takes.claim_hash        sha256 of the claim (hex), generated and indexed: the same value the
--                           program stores as claimHash.
--   ingest_chain_events     same as 0021, except the fallback only matches takes whose author's
--                           wallet is the event's author. Seeded demo takes (is_demo authors, who
--                           have no wallet) keep matching by claim alone: the fork API mirrors them
--                           under a stand-in author key (0042).
--   chain_take_goes_live    same as 0047, reading the indexed hash.

-- convert_to depends only on the database encoding (UTF8), so this is immutable in practice.
create function public.claim_sha256(p_claim text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select encode(sha256(convert_to(p_claim, 'UTF8')), 'hex')
$$;

alter table public.takes
  add column claim_hash text generated always as (public.claim_sha256(claim)) stored;

create index takes_claim_hash on public.takes (claim_hash);

-- Called only when a take is written, by the service role (create_take) or a definer function;
-- reading the stored column doesn't call it.
revoke execute on function public.claim_sha256(text) from public, anon, authenticated;
grant execute on function public.claim_sha256(text) to service_role;

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
          -- The author's own take with this claim (a demo take: any, see above).
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
