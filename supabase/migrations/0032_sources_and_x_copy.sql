-- Takes from what you read, and copying X accounts.
--
--   takes.source_*   where a take came from: an article shared into Thesis from the iOS share sheet
--                    ("Reuters"), or an X post ("@KobeissiLetter on X"). Shown on the take and its
--                    web page as "via …", linking to the original.
--   x_accounts       X accounts someone on Thesis copies. functions/x-poll reads their new posts
--                    (Apify) every 15 minutes.
--   x_follows        who copies whom.
--   x_calls          each new post, with the take Thesis drafted from it, or a null claim when the
--                    post isn't a market call ("Happy Friday"). A call notifies everyone copying
--                    the account (kind x_call); tapping it opens the take, basket built, credited
--                    to the post, and one tap posts and buys in.
--
-- Everything X is service role only; the app reads and writes it through functions/social.

alter table public.takes
  add column source_url   text,
  add column source_label text,
  add column source_kind  text,
  add constraint takes_source_url check (source_url is null or (source_url ~ '^https?://' and char_length(source_url) <= 500)),
  add constraint takes_source_label check (source_label is null or char_length(source_label) between 1 and 60),
  add constraint takes_source_kind check (source_kind is null or source_kind in ('link', 'x'));

create table public.x_accounts (
  -- Lowercase, as X compares them.
  handle      text primary key check (handle ~ '^[a-z0-9_]{1,15}$'),
  -- As X shows it ("KobeissiLetter"), and the display name.
  username    text not null,
  name        text,
  avatar_url  text,
  -- Posts after this are new (the newest post we've seen, or when the first follow happened).
  seen_until  timestamptz not null default now(),
  polled_at   timestamptz,
  created_at  timestamptz not null default now()
);

create table public.x_follows (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  handle     text not null references public.x_accounts (handle) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, handle)
);
create index x_follows_handle on public.x_follows (handle);

create table public.x_calls (
  post_id    text primary key check (post_id ~ '^[0-9]{1,25}$'),
  handle     text not null references public.x_accounts (handle) on delete cascade,
  url        text not null,
  text       text not null,
  posted_at  timestamptz not null,
  -- The drafted take, or null when the post isn't a market call.
  claim      text check (claim is null or char_length(claim) between 3 and 140),
  risk       text check (risk is null or risk in ('low', 'medium', 'high')),
  horizon    text check (horizon is null or horizon in ('2 weeks', '1 month', '3 months', '6 months')),
  created_at timestamptz not null default now()
);
create index x_calls_handle_posted on public.x_calls (handle, posted_at desc);

alter table public.x_accounts enable row level security;
alter table public.x_follows enable row level security;
alter table public.x_calls enable row level security;
revoke all on public.x_accounts, public.x_follows, public.x_calls from anon, authenticated;
grant select, insert, update, delete on public.x_accounts, public.x_follows, public.x_calls to service_role;

-- A call notifies everyone copying the account, once per post.
alter table public.notifications drop constraint notifications_kind;
alter table public.notifications add constraint notifications_kind check (kind in
  ('new_take', 'comment', 'take_traded', 'take_faded', 'take_settled', 'badge', 'daily_positions',
   'liquidation_risk', 'x_call'));

create function public.notify_x_call() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text;
begin
  if new.claim is null then return new; end if;
  select '@' || a.username into who from public.x_accounts a where a.handle = new.handle;
  perform public.notify(f.profile_id, 'x_call', null, null, null,
    who || ' made a call', new.claim,
    jsonb_build_object('claim', new.claim, 'risk', new.risk, 'horizon', new.horizon,
                       'source_url', new.url, 'source_label', who || ' on X', 'post', new.text),
    new.post_id)
  from public.x_follows f
  -- Only posts made after you started copying: following someone backfills their recent calls
  -- for the list, without a notification for each.
  where f.handle = new.handle and new.posted_at > f.created_at;
  return new;
end;
$$;
revoke all on function public.notify_x_call() from public, anon, authenticated;

create trigger x_calls_notify after insert on public.x_calls
  for each row execute function public.notify_x_call();

-- take_json: the live definition (0026_post_after_chain, as since changed on the
-- database), plus the source.
create or replace function public.take_json(t public.takes) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'claim', t.claim,
    'topic', t.topic,
    'risk', t.risk,
    'horizon', t.horizon,
    'tags', to_jsonb(t.tags),
    'created_at', t.created_at,
    'settles_at', t.settles_at,
    'status', t.status,
    'author', (select public.person_json(p) from public.profiles p where p.id = t.author_id),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', l.name, 'kind', l.kind, 'weight', l.weight, 'why', l.why,
        'slot', l.slot, 'fade_how', l.fade_how, 'ret', l.ret_pct, 'asset_id', l.asset_id
      ) order by l.idx)
      from public.take_legs l where l.take_id = t.id
    ), '[]'::jsonb),
    'ret', case when c.settled then round(c.result_bps / 100.0, 4) else coalesce(s.ret_pct, 0) end,
    'history', coalesce(to_jsonb(s.history), '[0, 0]'::jsonb),
    'backs', coalesce(c.backers, s.backs, 0),
    'fades', coalesce(c.faders, s.fades, 0),
    'money_in', coalesce(c.backed_usd + c.faded_usd, s.money_in, 0),
    'comments', (select count(*) from public.comments cm where cm.take_id = t.id),
    'on_chain', c.address,
    'source', case when t.source_url is null then null else jsonb_build_object(
      'url', t.source_url, 'label', t.source_label, 'kind', t.source_kind) end
  )
  from (select 1) as one
  left join public.take_stats s on s.take_id = t.id
  left join lateral (
    select * from public.chain_takes ct
    where ct.take_id = t.id and ct.network = public.request_network()
    order by ct.created_at desc nulls last
    limit 1
  ) c on true
$$;
