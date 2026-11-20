-- Checks the notification triggers, the daily digest and the inbox (migrations/*_notifications.sql),
-- and who traded or faded an inverted take (migrations/*_inverted_takes.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notifications.sql
begin;
insert into public.profiles (id, handle, display_name, solana_address) values
  ('00000000-0000-4000-8000-00000000a001', 'author', 'Author', 'WALLET_A'),
  ('00000000-0000-4000-8000-00000000a002', 'fan', 'Fan', 'WALLET_B'),
  ('00000000-0000-4000-8000-00000000a003', 'fader', 'Fader', 'WALLET_C'),
  ('00000000-0000-4000-8000-00000000a004', 'seller', 'Seller', 'WALLET_D');
insert into public.follows (follower_id, followee_id) values ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000a001');
insert into public.takes (id, author_id, claim, risk, horizon, settles_at) values
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'Notify test take', 'medium', '3mo', now() + interval '90 days');
insert into public.comments (id, take_id, author_id, body) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a002', 'Love this');
insert into public.comments (take_id, author_id, parent_id, body) values
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000c001', 'Thanks!');

do $$
declare
  ev jsonb := '[
    {"signature":"n1","ordinal":0,"slot":1,"block_time":1800000000,"name":"takeCreated","data":{"take":"TK","author":"WALLET_A","claimHash":[219,4,127,120,134,111,182,84,65,234,58,210,7,155,116,159,190,108,254,160,46,36,11,154,215,207,113,228,27,101,6,59],"stake":"10000000"}},
    {"signature":"n1","ordinal":1,"slot":1,"block_time":1800000000,"name":"positionOpened","data":{"take":"TK","owner":"WALLET_A","side":"back","stake":"10000000"}},
    {"signature":"n2","ordinal":0,"slot":2,"block_time":1800000060,"name":"positionOpened","data":{"take":"TK","owner":"WALLET_B","side":"back","stake":"20000000"}},
    {"signature":"n3","ordinal":0,"slot":3,"block_time":1800000120,"name":"positionOpened","data":{"take":"TK","owner":"WALLET_X","side":"fade","stake":"12500000"}},
    {"signature":"n4","ordinal":0,"slot":4,"block_time":1800003600,"name":"takeSettled","data":{"take":"TK","author":"WALLET_A","resultBps":"1250"}},
    {"signature":"n4","ordinal":1,"slot":4,"block_time":1800003600,"name":"badgeMinted","data":{"owner":"WALLET_A","kind":"firstOver50","mint":"MINT1"}}
  ]';
  a uuid := '00000000-0000-4000-8000-00000000a001';
  b uuid := '00000000-0000-4000-8000-00000000a002';
  got text;
  inbox jsonb;
begin
  perform public.ingest_chain_events('solana-mainnet-fork', ev);
  perform public.ingest_chain_events('solana-mainnet-fork', ev); -- a replay notifies nobody twice

  select string_agg(kind || '|' || title, ' ; ' order by id) into got from public.notifications where profile_id = a;
  if got is distinct from 'comment|@fan commented on your take ; take_traded|@fan traded your take · $20 ; take_faded|Someone faded your take · $12.5 ; take_settled|A take you''re in settled at +12.5% ; badge|You earned a badge: First take at +50%' then
    raise exception 'author got: %', got;
  end if;
  select string_agg(kind || '|' || title, ' ; ' order by id) into got from public.notifications where profile_id = b;
  if got is distinct from 'new_take|@author posted a take ; comment|@author replied to you ; take_settled|A take you''re in settled at +12.5%' then
    raise exception 'fan got: %', got;
  end if;

  if not public.post_daily_positions('WALLET_B', 'solana-mainnet-fork', '2026-12-07', 'Your positions are up 1.2% today', '1 open position', '{}') then raise exception 'digest not stored'; end if;
  if public.post_daily_positions('WALLET_B', 'solana-mainnet-fork', '2026-12-07', 'again', '', '{}') then raise exception 'digest stored twice in a day'; end if;
  if public.post_daily_positions('WALLET_NOBODY', 'solana-mainnet-fork', '2026-12-07', 'x', '', '{}') then raise exception 'digest for a wallet with no profile'; end if;

  inbox := public.notification_inbox(b, 'solana-mainnet-fork', 50);
  if (inbox ->> 'unread')::int <> 4 or inbox -> 'notifications' -> 0 ->> 'kind' <> 'daily_positions' then raise exception 'fork inbox: %', inbox; end if;
  inbox := public.notification_inbox(b, null, 50);
  if (inbox ->> 'unread')::int <> 2 then raise exception 'an inbox without a network shows only app activity: %', inbox; end if;

  -- The author's sale closes a take (migrations/*_author_sale_closes.sql). On "Closing test take":
  -- the fan backs and holds, a fader with a profile holds, a seller backs and sells before the
  -- close, then the author sells their buy-in.
  insert into public.takes (id, author_id, claim, risk, horizon, settles_at) values
    ('00000000-0000-4000-8000-00000000b002', a, 'Closing test take', 'medium', '12mo', now() + interval '365 days');
  update public.take_stats set ret_pct = 14.25 where take_id = '00000000-0000-4000-8000-00000000b002';
  ev := jsonb_build_array(
    jsonb_build_object('signature','m1','ordinal',0,'slot',11,'block_time',1800100000,'name','takeCreated',
      'data', jsonb_build_object('take','TC','author','WALLET_A','claimHash',
        (select to_jsonb(array_agg(get_byte(sha256(convert_to('Closing test take', 'UTF8')), i) order by i)) from generate_series(0, 31) i))),
    jsonb_build_object('signature','m1','ordinal',1,'slot',11,'block_time',1800100000,'name','positionOpened',
      'data', jsonb_build_object('take','TC','position','PC_A','owner','WALLET_A','side','back','stake','10000000')),
    jsonb_build_object('signature','m2','ordinal',0,'slot',12,'block_time',1800100060,'name','positionOpened',
      'data', jsonb_build_object('take','TC','position','PC_B','owner','WALLET_B','side','back','stake','20000000')),
    jsonb_build_object('signature','m3','ordinal',0,'slot',13,'block_time',1800100120,'name','positionOpened',
      'data', jsonb_build_object('take','TC','position','PC_C','owner','WALLET_C','side','fade','stake','15000000')),
    jsonb_build_object('signature','m4','ordinal',0,'slot',14,'block_time',1800100180,'name','positionOpened',
      'data', jsonb_build_object('take','TC','position','PC_D','owner','WALLET_D','side','back','stake','30000000')),
    jsonb_build_object('signature','m5','ordinal',0,'slot',15,'block_time',1800100240,'name','positionExited',
      'data', jsonb_build_object('take','TC','position','PC_D','owner','WALLET_D','side','back','exitedAt','1800100240')),
    jsonb_build_object('signature','m6','ordinal',0,'slot',16,'block_time',1800100300,'name','positionExited',
      'data', jsonb_build_object('take','TC','position','PC_A','owner','WALLET_A','side','back','exitedAt','1800100300')),
    jsonb_build_object('signature','m6','ordinal',1,'slot',16,'block_time',1800100300,'name','takeClosed',
      'data', jsonb_build_object('take','TC','author','WALLET_A','closedAt','1800100300'))
  );
  perform public.ingest_chain_events('solana-mainnet-fork', ev);
  perform public.ingest_chain_events('solana-mainnet-fork', ev);
  select string_agg(p.handle || '|' || n.title, ' ; ' order by p.handle) into got
  from public.notifications n join public.profiles p on p.id = n.profile_id
  where n.kind = 'take_closed';
  if got is distinct from 'fader|@author sold: closed at +14.3%. Your position stays open until you sell. ; fan|@author sold: closed at +14.3%. Your position stays open until you sell.' then
    raise exception 'take_closed went to: %', got;
  end if;
  if (select body from public.notifications where kind = 'take_closed' and profile_id = b) <> 'Closing test take' then
    raise exception 'take_closed body is the claim';
  end if;
  -- Its takeSettled (the sale's result): the author and the seller; the holders' positions run on.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','m7','ordinal',0,'slot',17,'block_time',1800100400,'name','takeSettled',
      'data', jsonb_build_object('take','TC','author','WALLET_A','resultBps','1400'))));
  select string_agg(p.handle, ',' order by p.handle) into got
  from public.notifications n join public.profiles p on p.id = n.profile_id
  where n.kind = 'take_settled' and n.take_id = '00000000-0000-4000-8000-00000000b002';
  if got is distinct from 'author,seller' then raise exception 'take_settled after a close went to: %', got; end if;

  -- Inverted takes (migrations/*_inverted_takes.sql): the author's buy-in is a fade. The fan fades
  -- it too, which agrees (take_traded); the fader backs it, which disagrees (take_faded).
  insert into public.takes (id, author_id, claim, risk, horizon, settles_at, inverted) values
    ('00000000-0000-4000-8000-00000000b003', a, 'Crypto sucks', 'high', '12mo', now() + interval '365 days', true);
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','v1','ordinal',0,'slot',21,'block_time',1800200000,'name','takeCreated',
      'data', jsonb_build_object('take','TV','author','WALLET_A','inverted',true,'claimHash',
        (select to_jsonb(array_agg(get_byte(sha256(convert_to('Crypto sucks', 'UTF8')), i) order by i)) from generate_series(0, 31) i))),
    jsonb_build_object('signature','v1','ordinal',1,'slot',21,'block_time',1800200000,'name','positionOpened',
      'data', jsonb_build_object('take','TV','position','PV_A','owner','WALLET_A','side','fade','stake','10000000')),
    jsonb_build_object('signature','v2','ordinal',0,'slot',22,'block_time',1800200060,'name','positionOpened',
      'data', jsonb_build_object('take','TV','position','PV_B','owner','WALLET_B','side','fade','stake','20000000')),
    jsonb_build_object('signature','v3','ordinal',0,'slot',23,'block_time',1800200120,'name','positionOpened',
      'data', jsonb_build_object('take','TV','position','PV_C','owner','WALLET_C','side','back','stake','15000000'))));
  select string_agg(kind || '|' || title, ' ; ' order by id) into got
  from public.notifications where profile_id = a and take_id = '00000000-0000-4000-8000-00000000b003';
  if got is distinct from 'take_traded|@fan traded your take · $20 ; take_faded|@fader faded your take · $15' then
    raise exception 'on an inverted take the author got: %', got;
  end if;
  raise notice 'notifications: all checks passed';
end $$;
rollback;
