-- Checks ingest_chain_events() and take_json()'s network header (migrations/*_chain_events.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/chain_events.sql
-- Each check raises if it fails. Events are shaped like functions/quicknode-stream sends them.
begin;
insert into public.profiles (id, handle, display_name, solana_address) values ('00000000-0000-4000-8000-0000000000aa', 'tester', 'Tester', 'A1');
-- A seeded demo author: no wallet; the fork API mirrors their takes under a stand-in key.
insert into public.profiles (id, handle, display_name, is_demo) values ('00000000-0000-4000-8000-0000000000ad', 'demo', 'Demo', true);
insert into public.takes (id, author_id, claim, risk, horizon, settles_at) values
  ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000aa', 'Chip stocks keep leading', 'medium', '3mo', now() + interval '90 days'),
  ('00000000-0000-4000-8000-0000000000bd', '00000000-0000-4000-8000-0000000000ad', 'Demo copper call', 'medium', '3mo', now() + interval '90 days');
-- A newer demo take with the tester's claim: the tester's own take must still win T1.
insert into public.takes (id, author_id, claim, risk, horizon, settles_at, created_at) values
  ('00000000-0000-4000-8000-0000000000be', '00000000-0000-4000-8000-0000000000ad', 'Chip stocks keep leading', 'medium', '3mo', now() + interval '90 days', now() + interval '1 minute');
update public.take_stats set backs = 7, fades = 1, money_in = 140 where take_id = '00000000-0000-4000-8000-0000000000bb';

do $$
declare
  ev jsonb := '[
    {"signature":"s1","ordinal":0,"slot":1,"block_time":1800000000,"name":"takeCreated","data":{"take":"T1","author":"A1","claimHash":[45,89,149,155,210,129,19,12,253,50,27,216,48,223,217,79,28,59,186,78,234,65,232,185,22,186,5,49,29,157,54,25],"stake":"10000000"}},
    {"signature":"s1","ordinal":1,"slot":1,"block_time":1800000000,"name":"positionOpened","data":{"take":"T1","owner":"A1","side":"back","stake":"10000000"}},
    {"signature":"s2","ordinal":0,"slot":2,"block_time":1800000060,"name":"positionOpened","data":{"take":"T1","owner":"B1","side":"back","stake":"25000000"}},
    {"signature":"s3","ordinal":0,"slot":3,"block_time":1800000120,"name":"positionOpened","data":{"take":"T1","owner":"F1","side":"fade","stake":"20000000"}},
    {"signature":"s4","ordinal":0,"slot":4,"block_time":1800003600,"name":"takeSettled","data":{"take":"T1","author":"A1","resultBps":"1250"}}
  ]';
  c public.chain_takes;
  j jsonb;
begin
  if public.ingest_chain_events('solana-mainnet-fork', ev) <> 5 then raise exception 'first ingest should store 5 events'; end if;
  if public.ingest_chain_events('solana-mainnet-fork', ev) <> 0 then raise exception 'a replay must store nothing'; end if;
  select * into c from public.chain_takes where network = 'solana-mainnet-fork' and address = 'T1';
  if c.take_id is distinct from '00000000-0000-4000-8000-0000000000bb' then raise exception 'take not matched by claim hash'; end if;

  -- The same claim on-chain from another wallet isn't linked to this author's take
  -- (migrations/*_claim_hash_author.sql); a demo take still matches its stand-in author.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature', 's9', 'ordinal', 0, 'slot', 9, 'block_time', 1800000000, 'name', 'takeCreated',
      'data', jsonb_build_object('take', 'T9', 'author', 'Z9', 'claimHash', ev -> 0 -> 'data' -> 'claimHash')),
    jsonb_build_object('signature', 's9', 'ordinal', 1, 'slot', 9, 'block_time', 1800000000, 'name', 'takeCreated',
      'data', jsonb_build_object('take', 'TD', 'author', 'STANDIN', 'claimHash',
        (select to_jsonb(array_agg(get_byte(sha256(convert_to('Demo copper call', 'UTF8')), i) order by i)) from generate_series(0, 31) i)))));
  -- (It may land on the demo take with that claim, which is how demo mirrors are found.)
  if (select take_id from public.chain_takes where network = 'solana-mainnet-fork' and address = 'T9') = '00000000-0000-4000-8000-0000000000bb' then
    raise exception 'another wallet''s on-chain take was linked to the tester''s take by claim hash';
  end if;
  if (select take_id from public.chain_takes where network = 'solana-mainnet-fork' and address = 'TD') is distinct from '00000000-0000-4000-8000-0000000000bd' then
    raise exception 'a demo take must still match its mirror by claim hash';
  end if;
  if (c.backers, c.faders, c.backed_usd, c.faded_usd, c.settled, c.result_bps) is distinct from (2, 1, 35.00, 20.00, true, 1250::bigint) then
    raise exception 'wrong counters: %', row_to_json(c);
  end if;

  select public.take_json(t) into j from public.takes t where t.id = '00000000-0000-4000-8000-0000000000bb';
  if (j->>'backs')::int <> 7 or j->>'on_chain' is not null then raise exception 'without the header the backend numbers must show: %', j; end if;
  perform set_config('request.headers', '{"x-thesis-network":"solana-mainnet-fork"}', true);
  select public.take_json(t) into j from public.takes t where t.id = '00000000-0000-4000-8000-0000000000bb';
  if (j->>'backs')::int <> 2 or (j->>'fades')::int <> 1 or (j->>'money_in')::numeric <> 55 or (j->>'ret')::numeric <> 12.5 or j->>'on_chain' <> 'T1' then
    raise exception 'with the header the chain numbers must show: %', j;
  end if;
  raise notice 'chain_events: all checks passed';
end $$;
rollback;
