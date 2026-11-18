-- Checks posting takes (migrations/*_post_after_chain.sql): hidden from everyone but the author
-- until the chain's takeCreated for the author's wallet makes them live.
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/post_after_chain.sql
-- Each check raises if it fails.
begin;
insert into public.profiles (id, handle, display_name, solana_address) values
  ('00000000-0000-4000-8000-0000000000a1', 'poster', 'Poster', 'WALLET_A'),
  ('00000000-0000-4000-8000-0000000000a2', 'fan', 'Fan', 'WALLET_F');
insert into public.follows (follower_id, followee_id) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1');

do $$
declare
  legs jsonb := '[{"name":"Nvidia","kind":"Stock","weight":100,"why":"chips"}]';
  posting uuid;
  other uuid;
  live uuid;
  n int;
  j jsonb;
  hash jsonb;
begin
  posting := public.create_take('00000000-0000-4000-8000-0000000000a1', 'Chips keep leading', 'topic-chips', 'medium', '3mo', '{}', legs, 'posting');
  other := public.create_take('00000000-0000-4000-8000-0000000000a1', 'Rates fall by June', 'topic-coin', 'low', '3mo', '{}', legs, 'posting');
  live := public.create_take('00000000-0000-4000-8000-0000000000a1', 'Copper is the new oil', 'topic-coin', 'high', '1mo', '{}', legs);

  if (select status from public.takes where id = live) <> 'live' then raise exception 'takes are live by default'; end if;
  if (select status from public.takes where id = posting) <> 'posting' then raise exception 'posting take not posting'; end if;
  if exists (select 1 from public.notifications where kind = 'new_take' and take_id = posting) then
    raise exception 'followers must not hear about a posting take';
  end if;
  if not exists (select 1 from public.notifications where kind = 'new_take' and take_id = live) then
    raise exception 'followers hear about a live take';
  end if;

  -- What the app's publishable key sees.
  set local role anon;
  if exists (select 1 from public.takes where id = posting) then raise exception 'anon sees a posting take'; end if;
  if exists (select 1 from public.take_legs where take_id = posting) then raise exception 'anon sees a posting take''s legs'; end if;
  if exists (select 1 from public.take_stats where take_id = posting) then raise exception 'anon sees a posting take''s stats'; end if;
  if public.take(posting) is not null then raise exception 'take() shows a posting take'; end if;
  select jsonb_array_length(public.profile_takes('00000000-0000-4000-8000-0000000000a1')) into n;
  if n <> 1 then raise exception 'profile shows % takes, want the live one only', n; end if;
  if exists (select 1 from jsonb_array_elements(public.feed()) x where (x ->> 'id')::uuid = posting) then
    raise exception 'the feed shows a posting take';
  end if;
  if (public.profile('00000000-0000-4000-8000-0000000000a1') ->> 'takes')::int <> 1 then
    raise exception 'the take count includes a posting take: %', public.profile('00000000-0000-4000-8000-0000000000a1');
  end if;
  -- Follow counts stay public; who follows whom doesn't (migrations/*_follows_private.sql).
  if (public.profile('00000000-0000-4000-8000-0000000000a1') ->> 'followers')::int <> 1
     or (public.profile('00000000-0000-4000-8000-0000000000a2') ->> 'following')::int <> 1 then
    raise exception 'profile follow counts: %', public.profile('00000000-0000-4000-8000-0000000000a1');
  end if;
  begin
    perform 1 from public.follows;
    raise exception 'anon can read follows';
  exception when insufficient_privilege then null;
  end;
  -- The fork API builds the on-chain take from it, by id.
  j := public.take_for_chain(posting);
  if j ->> 'status' <> 'posting' or jsonb_array_length(j -> 'legs') <> 1 then raise exception 'take_for_chain: %', j; end if;
  -- The fork API tells a take a real user posted (it has their wallet) from a seeded demo take.
  if j ->> 'author_wallet' is distinct from 'WALLET_A' then raise exception 'take_for_chain: author_wallet %', j ->> 'author_wallet'; end if;
  reset role;

  -- The author's list, through the edge function.
  select jsonb_array_length(public.posting_takes('00000000-0000-4000-8000-0000000000a1')) into n;
  if n <> 2 then raise exception 'posting_takes shows %, want 2', n; end if;

  -- The edge function reads with the service role, which skips RLS (migrations/*_live_takes_only.sql):
  -- a follower's feed and every take count still leave posting takes out.
  select jsonb_array_length(public.following_feed('00000000-0000-4000-8000-0000000000a2')) into n;
  if n <> 1 then raise exception 'following_feed shows % takes, want the live one only', n; end if;
  if exists (select 1 from jsonb_array_elements(public.following_feed('00000000-0000-4000-8000-0000000000a2')) x where x ->> 'status' <> 'live') then
    raise exception 'following_feed shows a posting take';
  end if;
  if (public.profile('00000000-0000-4000-8000-0000000000a1') ->> 'takes')::int <> 1 then
    raise exception 'person_json counts posting takes for the service role';
  end if;
  if jsonb_array_length(public.profile_takes('00000000-0000-4000-8000-0000000000a1')) <> 1
     or jsonb_array_length(public.takes_by_ids(array[posting, live])) <> 1
     or exists (select 1 from jsonb_array_elements(public.feed()) x where (x ->> 'id')::uuid = posting) then
    raise exception 'a public read shows a posting take to the service role';
  end if;
  if (select claim_hash from public.takes where id = posting) <> encode(sha256(convert_to('Chips keep leading', 'UTF8')), 'hex') then
    raise exception 'takes.claim_hash is not the claim''s sha256';
  end if;

  -- Someone else's wallet publishing the same claim doesn't make it live.
  select to_jsonb(array_agg(get_byte(sha256(convert_to('Chips keep leading', 'UTF8')), i) order by i))
    into hash from generate_series(0, 31) i;
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(jsonb_build_object(
    'signature', 'x1', 'ordinal', 0, 'slot', 1, 'block_time', extract(epoch from now()), 'name', 'takeCreated',
    'data', jsonb_build_object('take', 'TX', 'author', 'WALLET_F', 'claimHash', hash))));
  if (select status from public.takes where id = posting) <> 'posting' then raise exception 'another wallet made it live'; end if;
  -- Nor does the claim-hash fallback link that wallet's on-chain take to this author's take
  -- (migrations/*_claim_hash_author.sql).
  if (select take_id from public.chain_takes where network = 'solana-mainnet-fork' and address = 'TX') is not null then
    raise exception 'another wallet''s on-chain take was linked to this take';
  end if;

  -- The author's takeCreated does.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(jsonb_build_object(
    'signature', 'x2', 'ordinal', 0, 'slot', 2, 'block_time', extract(epoch from now()), 'name', 'takeCreated',
    'data', jsonb_build_object('take', 'TA', 'author', 'WALLET_A', 'claimHash', hash))));
  if (select status from public.takes where id = posting) <> 'live' then raise exception 'the author''s takeCreated must make it live'; end if;
  if (select take_id from public.chain_takes where network = 'solana-mainnet-fork' and address = 'TA') is distinct from posting then
    raise exception 'on-chain take not linked to the app take';
  end if;
  if not exists (select 1 from public.notifications where kind = 'new_take' and take_id = posting) then
    raise exception 'followers hear about it when it goes live';
  end if;
  set local role anon;
  if public.take(posting) is null then raise exception 'a live take is public'; end if;
  reset role;

  -- Discard: only the author, only while posting.
  if public.discard_posting_take('00000000-0000-4000-8000-0000000000a2', other) then raise exception 'someone else discarded it'; end if;
  if public.discard_posting_take('00000000-0000-4000-8000-0000000000a1', posting) then raise exception 'discarded a live take'; end if;
  if not public.discard_posting_take('00000000-0000-4000-8000-0000000000a1', other) then raise exception 'the author can discard'; end if;
  if exists (select 1 from public.takes where id = other) then raise exception 'discard left the take'; end if;

  -- Go-live by take (migrations/*_go_live_by_take.sql): the event's horizonEnd pins the row.
  -- One posting take per author and claim: a twin is refused.
  posting := public.create_take('00000000-0000-4000-8000-0000000000a1', 'Gold to 3k', 'topic-coin', 'medium', '3mo', '{}', legs, 'posting');
  begin
    perform public.create_take('00000000-0000-4000-8000-0000000000a1', 'Gold to 3k', 'topic-coin', 'medium', '3mo', '{}', legs, 'posting');
    raise exception 'a second posting take with the same claim was created';
  exception when unique_violation then null;
  end;
  select to_jsonb(array_agg(get_byte(sha256(convert_to('Gold to 3k', 'UTF8')), i) order by i))
    into hash from generate_series(0, 31) i;
  -- Another take's horizon (a different row) doesn't make this one live.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(jsonb_build_object(
    'signature', 'x3', 'ordinal', 0, 'slot', 3, 'block_time', extract(epoch from now()), 'name', 'takeCreated',
    'data', jsonb_build_object('take', 'TG0', 'author', 'WALLET_A', 'claimHash', hash,
      'horizonEnd', (floor(extract(epoch from (select settles_at from public.takes where id = posting))) - 86400)::bigint::text))));
  if (select status from public.takes where id = posting) <> 'posting' then raise exception 'another horizon made it live'; end if;
  -- Its own horizon does.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(jsonb_build_object(
    'signature', 'x4', 'ordinal', 0, 'slot', 4, 'block_time', extract(epoch from now()), 'name', 'takeCreated',
    'data', jsonb_build_object('take', 'TG1', 'author', 'WALLET_A', 'claimHash', hash,
      'horizonEnd', floor(extract(epoch from (select settles_at from public.takes where id = posting)))::bigint::text))));
  if (select status from public.takes where id = posting) <> 'live' then raise exception 'its own takeCreated must make it live'; end if;
  if (select take_id from public.chain_takes where network = 'solana-mainnet-fork' and address = 'TG1') is distinct from posting then
    raise exception 'TG1 not linked to its take';
  end if;
  -- The same claim posted again later: the earlier take's event, delivered again, leaves it posting.
  update public.takes set settles_at = settles_at - interval '1 day' where id = posting;
  other := public.create_take('00000000-0000-4000-8000-0000000000a1', 'Gold to 3k', 'topic-coin', 'medium', '3mo', '{}', legs, 'posting');
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(jsonb_build_object(
    'signature', 'x5', 'ordinal', 0, 'slot', 5, 'block_time', extract(epoch from now()), 'name', 'takeCreated',
    'data', jsonb_build_object('take', 'TG2', 'author', 'WALLET_A', 'claimHash', hash,
      'horizonEnd', floor(extract(epoch from (select settles_at from public.takes where id = posting)))::bigint::text))));
  if (select status from public.takes where id = other) <> 'posting' then raise exception 'an earlier take''s event made the newer post live'; end if;

  if not exists (select 1 from cron.job where jobname = 'delete-stale-posting-takes') then raise exception 'cleanup job missing'; end if;
  raise notice 'post_after_chain: all checks passed';
end $$;
rollback;
