-- Checks copy trading's queue (migrations/*_copy_trading.sql): a new call from an auto-copied X
-- account queues a job for each auto-copier who turned it on before the post, once; a copied
-- trader's take going live queues a back; the runner claims each job once; the daily count; the
-- feeds leave auto-copied takes out.
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/copy_trading.sql
-- Each check raises if it fails.
begin;
insert into public.profiles (id, handle, display_name) values
  ('00000000-0000-4000-8000-0000000c0001', 'copier_a', 'A'),
  ('00000000-0000-4000-8000-0000000c0002', 'copier_b', 'B'),
  ('00000000-0000-4000-8000-0000000c0003', 'trader_t', 'T');
insert into public.x_accounts (handle, username) values ('goldbug_test', 'GoldBug_Test');
insert into public.x_follows (profile_id, handle, auto, auto_usd, auto_since) values
  ('00000000-0000-4000-8000-0000000c0001', 'goldbug_test', true, 25, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000c0002', 'goldbug_test', false, 20, null);
insert into public.trader_follows (profile_id, trader_id, auto_usd, auto_since) values
  ('00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000c0003', 30, now() - interval '1 hour');

do $$
declare
  n integer;
  j public.copy_jobs;
  tid uuid;
begin
  -- A call after auto_since: one job for A (auto on), none for B (auto off), at A's amount.
  insert into public.x_calls (post_id, handle, url, text, posted_at, claim, risk)
  values ('900000000000000001', 'goldbug_test', 'https://x.com/GoldBug_Test/status/900000000000000001', 'Gold to 5k this year', now(), 'Gold rises to 5k', 'medium');
  select count(*) into n from public.copy_jobs where post_id = '900000000000000001';
  if n <> 1 then raise exception 'a call queues one job for the auto-copier: %', n; end if;
  select * into j from public.copy_jobs where post_id = '900000000000000001';
  if j.profile_id <> '00000000-0000-4000-8000-0000000c0001' or j.usd <> 25 or j.status <> 'queued' or j.kind <> 'x_call' then raise exception 'job: %', row_to_json(j); end if;

  -- Not a call (no claim), or posted before auto-copy was on: nothing queued.
  insert into public.x_calls (post_id, handle, url, text, posted_at, claim)
  values ('900000000000000002', 'goldbug_test', 'https://x.com/x/status/2', 'gm everyone', now(), null);
  insert into public.x_calls (post_id, handle, url, text, posted_at, claim, risk)
  values ('900000000000000003', 'goldbug_test', 'https://x.com/x/status/3', 'Old call', now() - interval '2 hours', 'Gold rises', 'medium');
  select count(*) into n from public.copy_jobs where post_id in ('900000000000000002', '900000000000000003');
  if n <> 0 then raise exception 'non-calls and older calls queue nothing: %', n; end if;

  -- The runner claims each job once.
  select count(*) into n from public.claim_copy_jobs(10);
  if n <> 1 then raise exception 'claimed: %', n; end if;
  select count(*) into n from public.claim_copy_jobs(10);
  if n <> 0 then raise exception 'claimed twice: %', n; end if;
  update public.copy_jobs set status = 'done' where post_id = '900000000000000001';
  if public.copies_today('00000000-0000-4000-8000-0000000c0001', 'goldbug_test', null) <> 1 then raise exception 'copies today'; end if;

  -- A copied trader's take going live queues a back for their auto-copier (B), once.
  tid := public.create_take('00000000-0000-4000-8000-0000000c0003', 'Copper squeezes higher', 'topic-coin', 'medium', null, '{}',
    '[{"name":"Copper","kind":"Commodity","weight":100,"why":"","slot":0}]'::jsonb, 'posting');
  update public.takes set status = 'live' where id = tid;
  update public.takes set status = 'live' where id = tid;
  select count(*) into n from public.copy_jobs where source_take = tid and profile_id = '00000000-0000-4000-8000-0000000c0002' and kind = 'take' and usd = 30;
  if n <> 1 then raise exception 'a copied trader''s live take queues one back: %', n; end if;

  -- Auto-copied takes stay out of the feeds.
  update public.takes set auto_copy = true where id = tid;
  if public.feed(100)::text like '%' || tid::text || '%' then raise exception 'an auto-copied take is in the feed'; end if;
  if public.trending(null, 100)::text like '%' || tid::text || '%' then raise exception 'an auto-copied take is trending'; end if;

  begin
    set local role anon;
    perform 1 from public.copy_jobs;
    raise exception 'anon can read copy_jobs';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
