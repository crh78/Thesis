-- Copying X accounts, part 2: poll every 15 minutes (functions/source /poll).
--
--   source_secret(name)  the source function's secrets that live in the Vault: apify_token (set
--                        by hand: select vault.create_secret('<token>', 'apify_token')) and
--                        x_poll_secret (made here). Service role only.
--   cron x-poll          pg_net POSTs <project_url>/functions/v1/source/poll with x-poll-secret.
--                        The function returns at once without calling Apify when nobody copies
--                        anyone. project_url is the project's API URL in the Vault, set by hand
--                        once per project (no default): select vault.create_secret(
--                        'https://<project-ref>.supabase.co', 'project_url'). Without it each run
--                        fails (see cron.job_run_details).

create extension if not exists pg_net with schema extensions;

create function public.source_secret(p_name text) returns text
language sql stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  where s.name = p_name and p_name in ('apify_token', 'x_poll_secret')
$$;
revoke all on function public.source_secret(text) from public, anon, authenticated;
grant execute on function public.source_secret(text) to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'x_poll_secret')
where not exists (select 1 from vault.secrets where name = 'x_poll_secret');

select cron.schedule('x-poll', '*/15 * * * *', $$
  select net.http_post(
    url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/source/poll',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-poll-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'x_poll_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$$);
