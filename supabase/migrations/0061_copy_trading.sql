-- Copy trading (owner's decisions 2026-11-19): Thesis trades for you when someone you copy makes a
-- call, within your trading-by-text limits (functions/agent, its session signer).
--
--   x_follows.auto*      auto-copy an X account you copy: $ per call (default $20), at most
--                        auto_daily a day (default 3), calls posted after auto_since only.
--   trader_follows       copying a Thesis trader: each new take of theirs is backed for you.
--   copy_jobs            one per (copier, call) or (copier, take), queued by the triggers below
--                        and run by functions/agent POST /agent/copy-run (pg_cron, every minute).
--   x_calls.draft_id     the one basket built for a call, copied to every copier (no rebuild).
--   takes.auto_copy      an auto-copied take: kept out of the feeds (For you, Following,
--                        trending), so many copiers never mean many identical posts; it counts on
--                        profiles, positions and scores like any take.
--   notifications        copy_done / copy_skipped tell the copier what happened.
--
-- Service role only, like x_follows and x_calls.

alter table public.x_follows
  add column auto       boolean not null default false,
  add column auto_usd   numeric not null default 20 check (auto_usd >= 10 and auto_usd <= 10000),
  add column auto_daily integer not null default 3 check (auto_daily between 1 and 20),
  add column auto_since timestamptz;

create table public.trader_follows (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  trader_id  uuid not null references public.profiles (id) on delete cascade,
  auto       boolean not null default true,
  auto_usd   numeric not null default 20 check (auto_usd >= 10 and auto_usd <= 10000),
  auto_daily integer not null default 3 check (auto_daily between 1 and 20),
  auto_since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (profile_id, trader_id),
  check (profile_id <> trader_id)
);
create index trader_follows_trader on public.trader_follows (trader_id) where auto;

alter table public.x_calls add column draft_id text references public.take_drafts (id) on delete set null;
-- 'basket' once built, 'no_clean_exposure' when the builder found none (never built twice).
alter table public.x_calls add column basket text check (basket is null or basket in ('basket', 'no_clean_exposure'));

alter table public.takes add column auto_copy boolean not null default false;

create table public.copy_jobs (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('x_call', 'take')),
  -- x_call: the call and its account; take: the trader's take to back, and the trader.
  post_id     text references public.x_calls (post_id) on delete cascade,
  handle      text,
  source_take uuid references public.takes (id) on delete cascade,
  trader_id   uuid references public.profiles (id) on delete set null,
  usd         numeric not null check (usd >= 10),
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 200),
  -- The copier's take or position it made (their own take for a call; the trader's take for a back).
  result_take uuid references public.takes (id) on delete set null,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((kind = 'x_call' and post_id is not null) or (kind = 'take' and source_take is not null))
);
create unique index copy_jobs_call on public.copy_jobs (profile_id, post_id) where post_id is not null;
create unique index copy_jobs_take on public.copy_jobs (profile_id, source_take) where source_take is not null;
create index copy_jobs_queue on public.copy_jobs (created_at) where status = 'queued';
create index copy_jobs_profile on public.copy_jobs (profile_id, created_at desc);

alter table public.trader_follows enable row level security;
alter table public.copy_jobs enable row level security;
revoke all on public.trader_follows, public.copy_jobs from anon, authenticated;
grant select, insert, update, delete on public.trader_follows, public.copy_jobs to service_role;

-- Queue: a new call from an X account → a job for each auto-copier who turned it on before the post.
create function public.queue_x_call_copies() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.claim is null then
    return new;
  end if;
  insert into public.copy_jobs (profile_id, kind, post_id, handle, usd)
  select f.profile_id, 'x_call', new.post_id, new.handle, f.auto_usd
  from public.x_follows f
  where f.handle = new.handle and f.auto and f.auto_since is not null and new.posted_at >= f.auto_since
  on conflict do nothing;
  return new;
end
$$;
create trigger x_calls_queue_copies after insert on public.x_calls
  for each row execute function public.queue_x_call_copies();

-- Queue: a copied trader's take goes live → a back for each of their auto-copiers.
create function public.queue_take_copies() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'live' and old.status is distinct from 'live' then
    insert into public.copy_jobs (profile_id, kind, source_take, trader_id, usd)
    select f.profile_id, 'take', new.id, new.author_id, f.auto_usd
    from public.trader_follows f
    where f.trader_id = new.author_id and f.auto and new.created_at >= f.auto_since - interval '5 minutes'
    on conflict do nothing;
  end if;
  return new;
end
$$;
create trigger takes_queue_copies after update of status on public.takes
  for each row execute function public.queue_take_copies();

-- The runner takes queued jobs (oldest first) without two runs taking the same one.
create function public.claim_copy_jobs(p_limit integer) returns setof public.copy_jobs
language sql
security definer
set search_path = ''
as $$
  update public.copy_jobs j set status = 'running', attempts = j.attempts + 1, updated_at = now()
  where j.id in (
    select id from public.copy_jobs where status = 'queued'
    order by created_at limit least(greatest(p_limit, 1), 20)
    for update skip locked
  )
  returning j.*
$$;
revoke all on function public.claim_copy_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_copy_jobs(integer) to service_role;

-- How many copies of this account (or trader) this copier got today (the daily cap).
create function public.copies_today(p_profile uuid, p_handle text, p_trader uuid) returns integer
language sql stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.copy_jobs
  where profile_id = p_profile and status = 'done' and updated_at > now() - interval '24 hours'
    and ((p_handle is not null and handle = p_handle) or (p_trader is not null and trader_id = p_trader))
$$;
revoke all on function public.copies_today(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.copies_today(uuid, text, uuid) to service_role;

-- Feeds leave auto-copied takes out (0050_live_takes_only, plus "and not auto_copy").
create or replace function public.feed(p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select * from public.takes where status = 'live' and not auto_copy
    order by created_at desc limit least(greatest(p_limit, 1), 100)
  ) t
$$;

create or replace function public.following_feed(p_profile uuid, p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk
    join public.follows f on f.followee_id = tk.author_id and f.follower_id = p_profile
    where tk.status = 'live' and not tk.auto_copy
    order by tk.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) t
$$;

create or replace function public.trending(p_tag text default null, p_limit int default 30) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t.take) order by t.activity desc, (t.take).created_at desc), '[]'::jsonb)
  from (
    select tk as take, coalesce(s.backs + s.fades, 0) as activity
    from public.takes tk
    left join public.take_stats s on s.take_id = tk.id
    where tk.status = 'live' and not tk.auto_copy and (p_tag is null or p_tag = any (tk.tags))
    order by activity desc, tk.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) t
$$;

-- Notifications: what an auto-copy did.
alter table public.notifications drop constraint notifications_kind;
alter table public.notifications add constraint notifications_kind check (kind in
  ('new_take', 'comment', 'take_traded', 'take_faded', 'take_settled', 'badge', 'daily_positions',
   'liquidation_risk', 'x_call', 'take_closed', 'copy_done', 'copy_skipped'));

-- The runner, every minute: functions/agent POST /agent/copy-run with the bots' secret (the Vault's
-- bot_secret). It returns at once when nothing is queued.
select cron.schedule('copy-run', '* * * * *', $$
  select net.http_post(
    url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/agent/copy-run',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-bot-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bot_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000)
  where exists (select 1 from public.copy_jobs where status = 'queued')
$$);
