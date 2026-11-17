-- Checks the web push trigger (migrations/*_web_push.sql): a new notification queues one call to
-- functions/web-push/send only when its person has a subscribed browser, and chain notifications
-- only for the fork's network. Run against a scratch database with the migrations applied (it
-- rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/web_push.sql
begin;
-- The project's API URL the trigger posts to (set by hand on a real project; rolled back here).
select vault.create_secret('https://project.example', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
insert into public.profiles (id, handle, display_name) values
  ('00000000-0000-4000-8000-00000000d001', 'pusher', 'Pusher'),
  ('00000000-0000-4000-8000-00000000d002', 'quiet', 'Quiet');
insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth) values
  ('00000000-0000-4000-8000-00000000d001', 'https://push.example/endpoint-1', repeat('B', 87), repeat('a', 22));

do $$
declare
  before bigint;
  queued bigint;
  sent text;
begin
  if public.web_push_secret() is null then raise exception 'no web_push_secret in the Vault'; end if;
  select count(*) into before from net.http_request_queue;

  -- Subscribed, app notification: queued.
  insert into public.notifications (profile_id, kind, title) values ('00000000-0000-4000-8000-00000000d001', 'comment', 'Hi');
  -- Subscribed, fork chain notification: queued.
  insert into public.notifications (profile_id, kind, network, title) values ('00000000-0000-4000-8000-00000000d001', 'take_traded', 'solana-mainnet-fork', 'Traded');
  -- Subscribed, another network: not queued.
  insert into public.notifications (profile_id, kind, network, title) values ('00000000-0000-4000-8000-00000000d001', 'take_traded', 'solana-mainnet', 'Mainnet');
  -- Not subscribed: not queued.
  insert into public.notifications (profile_id, kind, title) values ('00000000-0000-4000-8000-00000000d002', 'comment', 'Hi');

  select count(*) - before into queued from net.http_request_queue;
  if queued <> 2 then raise exception 'queued % push calls, expected 2', queued; end if;

  select q.url into sent from net.http_request_queue q order by q.id desc limit 1;
  if sent not like '%/functions/v1/web-push/send' then raise exception 'pushed to %', sent; end if;
end $$;

-- Deleting a profile removes its browsers.
delete from public.profiles where id = '00000000-0000-4000-8000-00000000d001';
do $$
begin
  if exists (select 1 from public.push_subscriptions where endpoint = 'https://push.example/endpoint-1') then
    raise exception 'subscription outlived its profile';
  end if;
end $$;
rollback;
