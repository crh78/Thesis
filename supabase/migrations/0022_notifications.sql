-- Notifications: an inbox per profile, filled by triggers on app activity and on chain events
-- (chain_events, from the QuickNode Stream / fork relay), plus a daily positions digest the
-- backend posts through functions/notify.
--
--   new_take         someone you follow posted a take
--   comment          someone commented on your take, or replied to your comment
--   take_traded      someone backed your take (chain)
--   take_faded       someone faded your take (chain)
--   take_settled     a take you hold or wrote settled, with its result (chain)
--   badge            you earned a "called it" badge (chain)
--   daily_positions  once a day: how your open positions are doing
--
-- Delivery: the app reads its inbox through functions/social (GET /notifications) and raises new
-- ones as local iOS notifications. Rows from chain activity carry their network; the inbox shows
-- them only to clients that ask for that network (x-thesis-network), like take_json().
-- Everything is service role only: notifications are private.

create table public.notifications (
  id          bigint generated always as identity primary key,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null,
  -- The chain network for chain activity ("solana-mainnet", "solana-mainnet-fork"); null for app activity.
  network     text,
  actor_id    uuid references public.profiles (id) on delete set null,
  take_id     uuid references public.takes (id) on delete cascade,
  title       text not null,
  body        text not null default '',
  data        jsonb not null default '{}'::jsonb,
  -- One notification per (profile, kind, dedupe_key): event replays and the daily job never repeat.
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,

  constraint notifications_kind check (kind in
    ('new_take', 'comment', 'take_traded', 'take_faded', 'take_settled', 'badge', 'daily_positions'))
);

create unique index notifications_dedupe on public.notifications (profile_id, kind, dedupe_key)
  where dedupe_key is not null;
create index notifications_inbox on public.notifications (profile_id, created_at desc);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select, insert, update, delete on public.notifications to service_role;

-- Helpers ------------------------------------------------------------------------------------

create function public.notify(
  p_profile uuid, p_kind text, p_network text, p_actor uuid, p_take uuid,
  p_title text, p_body text, p_data jsonb, p_dedupe text
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (profile_id, kind, network, actor_id, take_id, title, body, data, dedupe_key)
  select p_profile, p_kind, p_network, p_actor, p_take, left(p_title, 140), left(coalesce(p_body, ''), 280),
         coalesce(p_data, '{}'::jsonb), p_dedupe
  where p_profile is not null and p_profile is distinct from p_actor
  on conflict do nothing
$$;

revoke all on function public.notify(uuid, text, text, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;

-- "@handle", or a fallback for wallets with no profile (fork test wallets, mirrors).
create function public.notify_name(p_profile uuid, p_fallback text default 'Someone') returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select '@' || p.handle from public.profiles p where p.id = p_profile and p.handle is not null), p_fallback)
$$;

-- USDC base units (decimal string) → "$20" / "$20.50".
create function public.notify_usd(p_base_units text) returns text
language sql immutable
set search_path = ''
as $$
  select '$' || trim(trailing '.' from trim(trailing '0' from to_char(p_base_units::numeric / 1000000, 'FM999999990.00')))
$$;

-- App activity -------------------------------------------------------------------------------

create function public.notify_new_take() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.notify(f.follower_id, 'new_take', null, new.author_id, new.id,
    public.notify_name(new.author_id) || ' posted a take', new.claim, '{}'::jsonb, new.id::text)
  from public.follows f
  where f.followee_id = new.author_id;
  return new;
end;
$$;

create trigger takes_notify_followers after insert on public.takes
  for each row execute function public.notify_new_take();

create function public.notify_comment() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  take_author uuid;
  claim text;
  parent_author uuid;
begin
  select t.author_id, t.claim into take_author, claim from public.takes t where t.id = new.take_id;
  perform public.notify(take_author, 'comment', null, new.author_id, new.take_id,
    public.notify_name(new.author_id) || ' commented on your take', new.body,
    jsonb_build_object('claim', claim), new.id::text);
  if new.parent_id is not null then
    select c.author_id into parent_author from public.comments c where c.id = new.parent_id;
    if parent_author is distinct from take_author then
      perform public.notify(parent_author, 'comment', null, new.author_id, new.take_id,
        public.notify_name(new.author_id) || ' replied to you', new.body,
        jsonb_build_object('claim', claim), 'reply:' || new.id::text);
    end if;
  end if;
  return new;
end;
$$;

create trigger comments_notify after insert on public.comments
  for each row execute function public.notify_comment();

-- Chain activity -----------------------------------------------------------------------------

create function public.notify_chain_event() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := new.data;
  ct public.chain_takes;
  take_author uuid;
  claim text;
  owner_profile uuid;
  key text := new.signature || ':' || new.ordinal;
begin
  if new.take is not null then
    select * into ct from public.chain_takes c where c.network = new.network and c.address = new.take;
    if ct.take_id is not null then
      select t.author_id, t.claim into take_author, claim from public.takes t where t.id = ct.take_id;
    end if;
  end if;

  if new.name = 'positionOpened' then
    -- Not the author's own buy-in (create_take opens it).
    if take_author is null or d ->> 'owner' = ct.author_wallet then
      return new;
    end if;
    select p.id into owner_profile from public.profiles p where p.solana_address = d ->> 'owner';
    if d ->> 'side' = 'fade' then
      perform public.notify(take_author, 'take_faded', new.network, owner_profile, ct.take_id,
        public.notify_name(owner_profile) || ' faded your take · ' || public.notify_usd(d ->> 'stake'), claim,
        jsonb_build_object('stake', d ->> 'stake'), key);
    else
      perform public.notify(take_author, 'take_traded', new.network, owner_profile, ct.take_id,
        public.notify_name(owner_profile) || ' traded your take · ' || public.notify_usd(d ->> 'stake'), claim,
        jsonb_build_object('stake', d ->> 'stake'), key);
    end if;

  elsif new.name = 'takeSettled' then
    if ct.take_id is null then
      return new;
    end if;
    -- Everyone holding a position on it (backers and faders with a profile), and the author.
    perform public.notify(x.profile_id, 'take_settled', new.network, null, ct.take_id,
      'A take you''re in settled at ' || to_char(round((d ->> 'resultBps')::numeric / 100, 1), 'FMS990.0') || '%',
      claim, jsonb_build_object('result_bps', d ->> 'resultBps'), new.take)
    from (
      select distinct p.id as profile_id
      from public.chain_events e
      join public.profiles p on p.solana_address = e.data ->> 'owner'
      where e.network = new.network and e.take = new.take and e.name = 'positionOpened'
      union
      select take_author
    ) x
    where x.profile_id is not null;

  elsif new.name = 'badgeMinted' then
    select p.id into owner_profile from public.profiles p where p.solana_address = d ->> 'owner';
    perform public.notify(owner_profile, 'badge', new.network, null, null,
      'You earned a badge: ' || case d ->> 'kind'
        when 'firstTake' then 'First take posted'
        when 'firstOver50' then 'First take at +50%'
        when 'firstOver100' then 'First take at +100%'
        when 'tenOver50' then 'Ten takes at +50%'
        when 'over1000' then 'A take at +1,000%'
        else 'Called it' end,
      'Non-transferable, on-chain.', jsonb_build_object('kind', d ->> 'kind', 'mint', d ->> 'mint'), d ->> 'mint');
  end if;
  return new;
end;
$$;

create trigger chain_events_notify after insert on public.chain_events
  for each row execute function public.notify_chain_event();

-- Daily positions digest ---------------------------------------------------------------------

-- Called by functions/notify (service role) with the digest the backend computed for a wallet.
-- One per profile per network per day.
create function public.post_daily_positions(
  p_wallet text, p_network text, p_day date, p_title text, p_body text, p_data jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid;
begin
  select p.id into who from public.profiles p where p.solana_address = p_wallet;
  if who is null then
    return false;
  end if;
  insert into public.notifications (profile_id, kind, network, title, body, data, dedupe_key)
  values (who, 'daily_positions', p_network, left(p_title, 140), left(coalesce(p_body, ''), 280),
          coalesce(p_data, '{}'::jsonb), p_network || ':' || p_day::text)
  on conflict do nothing;
  return found;
end;
$$;

revoke all on function public.post_daily_positions(text, text, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.post_daily_positions(text, text, date, text, text, jsonb) to service_role;

-- Inbox --------------------------------------------------------------------------------------

-- A profile's latest notifications for a network (rows with no network always show), newest first.
create function public.notification_inbox(p_profile uuid, p_network text, p_limit int default 50) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'unread', (
      select count(*) from public.notifications n
      where n.profile_id = p_profile and n.read_at is null and (n.network is null or n.network = p_network)
    ),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'take_id', n.take_id,
        'actor', (select public.person_json(p) from public.profiles p where p.id = n.actor_id),
        'data', n.data, 'created_at', n.created_at, 'read', n.read_at is not null
      ) order by n.created_at desc, n.id desc)
      from (
        select * from public.notifications n
        where n.profile_id = p_profile and (n.network is null or n.network = p_network)
        order by n.created_at desc, n.id desc
        limit least(greatest(p_limit, 1), 100)
      ) n
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.notification_inbox(uuid, text, int) from public, anon, authenticated;
grant execute on function public.notification_inbox(uuid, text, int) to service_role;
