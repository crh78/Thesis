-- Checks ingest_chain_events() and take_json()'s network header (migrations/*_chain_events.sql), and
-- takeClosed / settled_at (migrations/*_author_sale_closes.sql), and partial-sale price events
-- (migrations/*_partial_sales.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/chain_events.sql
-- Each check raises if it fails. Events are shaped like functions/quicknode-stream sends them.
begin;
insert into public.profiles (id, handle, display_name, solana_address) values ('00000000-0000-4000-8000-0000000000aa', 'tester', 'Tester', 'A1');
-- A seeded demo author: no wallet; the fork API mirrors their takes under a stand-in key.
insert into public.profiles (id, handle, display_name, is_demo) values ('00000000-0000-4000-8000-0000000000ad', 'demo', 'Demo', true);
insert into public.takes (id, author_id, claim, risk, horizon, settles_at) values
  ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000aa', 'Chip stocks keep leading', 'medium', '3mo', now() + interval '90 days'),
  ('00000000-0000-4000-8000-0000000000bd', '00000000-0000-4000-8000-0000000000ad', 'Demo copper call', 'medium', '3mo', now() + interval '90 days'),
  ('00000000-0000-4000-8000-0000000000bc', '00000000-0000-4000-8000-0000000000aa', 'Copper closes early', 'high', '12mo', now() + interval '365 days');
insert into public.take_legs (take_id, idx, name, kind, weight, slot) values ('00000000-0000-4000-8000-0000000000bc', 0, 'Copper', 'Commodity', 100, 0);
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
  -- Settled on-chain: settled and its date show; it never closed (no author's sale).
  if (j->>'settled')::boolean is not true or (j->>'settled_at')::timestamptz <> to_timestamp(1800003600) or j->>'closed_at' is not null then
    raise exception 'settled take: %', j;
  end if;
  if (select settled_at from public.chain_takes where network = 'solana-mainnet-fork' and address = 'T1') <> to_timestamp(1800003600) then
    raise exception 'takeSettled must set settled_at';
  end if;

  -- The author's sale closes a take (migrations/*_author_sale_closes.sql): takeClosed sets
  -- closed_at, and its return stops following the marks while open positions keep theirs.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature', 'c1', 'ordinal', 0, 'slot', 20, 'block_time', 1800010000, 'name', 'takeCreated',
      'data', jsonb_build_object('take', 'TC', 'author', 'A1', 'claimHash',
        (select to_jsonb(array_agg(get_byte(sha256(convert_to('Copper closes early', 'UTF8')), i) order by i)) from generate_series(0, 31) i))),
    jsonb_build_object('signature', 'c2', 'ordinal', 0, 'slot', 21, 'block_time', 1800010060, 'name', 'positionOpened',
      'data', jsonb_build_object('take', 'TC', 'position', 'PC_B', 'owner', 'B1', 'side', 'back', 'stake', '25000000'))));
  select public.take_json(t) into j from public.takes t where t.id = '00000000-0000-4000-8000-0000000000bc';
  if j->>'on_chain' <> 'TC' or j->>'closed_at' is not null or (j->>'settled')::boolean then raise exception 'open take: %', j; end if;
  if public.apply_marks('{"takes":[{"take_id":"00000000-0000-4000-8000-0000000000bc","ret_pct":3}]}') ->> 'takes' <> '1' then
    raise exception 'an open take follows the marks';
  end if;
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature', 'c3', 'ordinal', 0, 'slot', 22, 'block_time', 1800020000, 'name', 'takeClosed',
      'data', jsonb_build_object('take', 'TC', 'author', 'A1', 'closedAt', '1800019999')),
    -- A replay with another time changes nothing.
    jsonb_build_object('signature', 'c4', 'ordinal', 0, 'slot', 23, 'block_time', 1800030000, 'name', 'takeClosed',
      'data', jsonb_build_object('take', 'TC', 'author', 'A1'))));
  select public.take_json(t) into j from public.takes t where t.id = '00000000-0000-4000-8000-0000000000bc';
  if (j->>'closed_at')::timestamptz <> to_timestamp(1800019999) or (j->>'settled')::boolean or j->>'settled_at' is not null then
    raise exception 'closed take: %', j;
  end if;
  if public.apply_marks('{"takes":[{"take_id":"00000000-0000-4000-8000-0000000000bc","ret_pct":9}],
                          "legs":[{"take_id":"00000000-0000-4000-8000-0000000000bc","idx":0,"mark_price":2,"ret_pct":9,"base_price":1}],
                          "positions":[{"network":"solana-mainnet-fork","address":"PC_B","live_return_bps":900}]}')
     is distinct from '{"legs":0,"takes":0,"positions":1}'::jsonb then
    raise exception 'a closed take''s return must freeze; its open positions still move';
  end if;
  select public.take_json(t) into j from public.takes t where t.id = '00000000-0000-4000-8000-0000000000bc';
  if (j->>'ret')::numeric <> 3 then raise exception 'closed take''s return moved: %', j; end if;
  -- A takeClosed for a take ingestion never saw still records it.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature', 'c5', 'ordinal', 0, 'slot', 24, 'block_time', 1800040000, 'name', 'takeClosed',
      'data', jsonb_build_object('take', 'TU', 'author', 'A9'))));
  if (select closed_at from public.chain_takes where network = 'solana-mainnet-fork' and address = 'TU') <> to_timestamp(1800040000) then
    raise exception 'takeClosed without closedAt uses the block time';
  end if;

  -- A partial sale's prices (migrations/*_partial_sales.sql): price_audit takes moment 'part' with
  -- its seq, and price_events() lists partPricesRecorded with that seq.
  insert into public.price_audit (hash, network, position, moment, moment_at, part_seq, canonical, doc)
  select encode(extensions.digest(convert_to(x.doc_text, 'UTF8'), 'sha256'), 'hex'), 'solana-mainnet-fork', 'PP_A', 'part', 1800050000, 2, x.doc_text, x.doc_text::jsonb
  from (select '{"moment":"part","momentAt":1800050000,"partSeq":2,"position":"PP_A"}'::text as doc_text) x;
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature', 'pp1', 'ordinal', 0, 'slot', 30, 'block_time', 1800050010, 'name', 'partPricesRecorded',
      'data', jsonb_build_object('take', 'TP', 'position', 'PP_A', 'seq', 2, 'legs', 1,
        'sourceHash', (select jsonb_agg(get_byte(decode(a.hash, 'hex'), i) order by i) from public.price_audit a, generate_series(0, 31) i
                       where a.position = 'PP_A')))));
  if (select (name, part_seq, published) from public.price_events('PP_A'))
     is distinct from ('partPricesRecorded'::text, 2, true) then
    raise exception 'price_events must list a partial sale''s prices with its seq: %', (select jsonb_agg(row_to_json(p)) from public.price_events('PP_A') p);
  end if;
  begin
    insert into public.price_audit (hash, moment, canonical, doc)
    select encode(extensions.digest(convert_to('{}', 'UTF8'), 'sha256'), 'hex'), 'later', '{}', '{}'::jsonb;
    raise exception 'an unknown moment must be refused';
  exception when check_violation then null;
  end;
  raise notice 'chain_events: all checks passed';
end $$;
rollback;
