-- The chain's takeCreated makes the posting take it was built from live, not the author's newest
-- posting take with the same claim.
--
-- What went wrong: one post created two posting rows 40 ms apart (the composer's effect ran twice).
-- The buy-in went on-chain for the older row, but chain_take_goes_live picked the newest posting
-- take with that author and claim hash, so the twin went live (untradeable: the fork knows the take
-- by the other id) and the real on-chain take stayed hidden as posting.
--
-- The event carries no Supabase id: its take address is a PDA from a hash of the take's uuid and
-- its legs' mints, which SQL can't recompute. What it does carry pins one row:
--   - horizonEnd: the fork API sets it from that row's settles_at, to the second (service.ts
--     #createIx). Rows posted in different seconds differ.
--   - A partial unique index allows one posting take per author and claim, so rows posted in the
--     same second (the twin case) can't exist.
-- With both, author + claim hash + horizonEnd is one row or none. Never guess: no match, or (for an
-- event without horizonEnd) more than one candidate, leaves every take as it is.

create unique index takes_one_posting_claim on public.takes (author_id, claim) where status = 'posting';

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
    and encode(sha256(convert_to(t.claim, 'UTF8')), 'hex') = hash
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
