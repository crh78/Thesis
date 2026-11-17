-- Checks the notification triggers, the daily digest and the inbox (migrations/*_notifications.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notifications.sql
begin;
insert into public.profiles (id, handle, display_name, solana_address) values
  ('00000000-0000-4000-8000-00000000a001', 'author', 'Author', 'WALLET_A'),
  ('00000000-0000-4000-8000-00000000a002', 'fan', 'Fan', 'WALLET_B');
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
  raise notice 'notifications: all checks passed';
end $$;
rollback;
