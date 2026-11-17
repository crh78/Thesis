-- Web push for the web app (apps/www): the browsers that turned notifications on, and a trigger that
-- sends each new notification to them through functions/web-push.
--
--   push_subscriptions      one row per browser (its push endpoint and keys), saved and removed by
--                           functions/web-push with the user's Privy token. Service role only.
--   web_push_secret()       the secret the trigger sends and the function checks (made here, in the
--                           Vault). Service role only.
--   notifications_web_push  after a notification is stored, if its person has a subscribed browser,
--                           pg_net POSTs <project_url>/functions/v1/web-push/send { notification_id }.
--                           Chain notifications are sent for the fork's network only, since that's
--                           what the web app shows (revisit for mainnet). project_url is the
--                           project's API URL in the Vault, set by hand once per project (no
--                           default): select vault.create_secret('https://<project-ref>.supabase.co',
--                           'project_url'). Without it nothing is sent (a warning, the notification
--                           is still stored).

create extension if not exists pg_net with schema extensions;

create table public.push_subscriptions (
  id            bigint generated always as identity primary key,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  -- The browser's push service URL; one row per browser, moved to whoever signed in on it last.
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_sent_at  timestamptz
);

create index push_subscriptions_profile on public.push_subscriptions (profile_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant all on public.push_subscriptions to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'web_push_secret')
where not exists (select 1 from vault.secrets where name = 'web_push_secret');

create function public.web_push_secret() returns text
language sql stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'web_push_secret'
$$;
revoke all on function public.web_push_secret() from public, anon, authenticated;
grant execute on function public.web_push_secret() to service_role;

create function public.push_new_notification() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
begin
  if (new.network is null or new.network = 'solana-mainnet-fork')
     and exists (select 1 from public.push_subscriptions s where s.profile_id = new.profile_id) then
    select rtrim(s.decrypted_secret, '/') into base from vault.decrypted_secrets s where s.name = 'project_url';
    if base is null then
      raise warning 'web push not sent: no project_url in the Vault';
    else
      perform net.http_post(
        url := base || '/functions/v1/web-push/send',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-push-secret', public.web_push_secret()),
        body := jsonb_build_object('notification_id', new.id),
        timeout_milliseconds := 10000);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.push_new_notification() from public, anon, authenticated;

create trigger notifications_web_push
  after insert on public.notifications
  for each row execute function public.push_new_notification();
