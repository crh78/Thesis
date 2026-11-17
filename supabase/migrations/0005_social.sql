-- Social layer: takes, follows, saves, comments, and the stats the app shows.
--
-- Same model as onboarding: clients read public tables (directly or through the
-- read functions below) with the publishable key; every write goes through the
-- `social` edge function, which verifies the Privy token and uses the service role.
--
--   takes / take_legs   a claim and its basket. Immutable once posted (no edit or
--                       delete), matching the on-chain receipt.
--   follows             public, like X.
--   saves               private bookmarks. Service role only.
--   comments            public; one level of replies.
--   comment_likes       public.
--   take_stats          return, history, backs/fades, money in per take.
--   profile_stats       cash made / return per period, for Scores.
--
-- take_stats, profile_stats and take_legs.ret_pct are placeholders until paper
-- trading lands: a pricing job will own them. Demo rows are seeded by
-- supabase/seed/demo.sql.

alter table public.profiles
  add column bio text,
  add column is_demo boolean not null default false,
  add constraint profiles_bio_len check (bio is null or char_length(bio) <= 160);

-- Takes ----------------------------------------------------------------------

create table public.takes (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles (id) on delete cascade,
  claim         text not null,
  -- Image key for the topic tile, e.g. 'topic-energy'.
  topic         text not null default 'topic-coin',
  risk          text not null,
  -- '2wk', '1mo', '3mo', '6mo'…
  horizon       text not null,
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  settles_at    timestamptz not null,
  -- Set once the take has an on-chain receipt.
  chain_address text unique,

  constraint takes_claim_len check (char_length(claim) between 3 and 140),
  constraint takes_topic_format check (topic ~ '^topic-[a-z]+$'),
  constraint takes_risk check (risk in ('low', 'medium', 'high')),
  constraint takes_horizon_format check (horizon ~ '^[0-9]{1,2}(wk|mo)$'),
  constraint takes_tags_count check (cardinality(tags) <= 5),
  constraint takes_settles_after_created check (settles_at > created_at)
);

create index takes_author_created on public.takes (author_id, created_at desc);
create index takes_created on public.takes (created_at desc);

create table public.take_legs (
  take_id  uuid not null references public.takes (id) on delete cascade,
  idx      smallint not null,
  name     text not null,
  -- "Stock", "Prediction · Yes", "Stock · 2x", "Earns interest"…
  kind     text not null,
  weight   numeric(5, 2) not null,
  why      text not null default '',
  -- Categorical colour slot; follows the pick, not its rank.
  slot     smallint not null,
  -- What fading this leg does, or null if it can't be faded.
  fade_how text,
  -- Placeholder until the pricing job owns it.
  ret_pct  numeric(9, 4) not null default 0,

  primary key (take_id, idx),
  constraint take_legs_idx check (idx between 0 and 9),
  constraint take_legs_name_len check (char_length(name) between 1 and 60),
  constraint take_legs_kind_len check (char_length(kind) between 1 and 40),
  constraint take_legs_why_len check (char_length(why) <= 300),
  constraint take_legs_weight check (weight > 0 and weight <= 100),
  constraint take_legs_slot check (slot between 0 and 9),
  constraint take_legs_fade_how_len check (fade_how is null or char_length(fade_how) <= 60)
);

create table public.take_stats (
  take_id    uuid primary key references public.takes (id) on delete cascade,
  ret_pct    numeric(9, 4) not null default 0,
  -- Return (%) over time, oldest first.
  history    numeric(9, 4)[] not null default '{0,0}',
  backs      integer not null default 0,
  fades      integer not null default 0,
  money_in   numeric(14, 2) not null default 0,
  updated_at timestamptz not null default now()
);

create trigger take_stats_set_updated_at before update on public.take_stats
  for each row execute function public.set_updated_at();

-- Every take gets a stats row, so reads never have to special-case a missing one.
create function public.create_take_stats() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.take_stats (take_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger takes_create_stats after insert on public.takes
  for each row execute function public.create_take_stats();

create table public.profile_stats (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  period     text not null,
  cash       numeric(14, 2) not null default 0,
  pct        numeric(9, 4) not null default 0,
  updated_at timestamptz not null default now(),

  primary key (profile_id, period),
  constraint profile_stats_period check (period in ('week', 'month', 'all'))
);

create trigger profile_stats_set_updated_at before update on public.profile_stats
  for each row execute function public.set_updated_at();

-- Follows, saves -------------------------------------------------------------

create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),

  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);

create index follows_followee on public.follows (followee_id);

create table public.saves (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  take_id    uuid not null references public.takes (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (profile_id, take_id)
);

-- Comments -------------------------------------------------------------------

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  take_id    uuid not null references public.takes (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  -- One level of replies: a reply's parent is always a top-level comment.
  parent_id  uuid references public.comments (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),

  constraint comments_body_len check (char_length(body) between 1 and 500)
);

create index comments_take_created on public.comments (take_id, created_at);
create index comments_parent on public.comments (parent_id);

create table public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (comment_id, profile_id)
);

create index comment_likes_profile on public.comment_likes (profile_id);

-- Access ---------------------------------------------------------------------
-- Public tables: read-only for clients. saves: service role only.

alter table public.takes enable row level security;
alter table public.take_legs enable row level security;
alter table public.take_stats enable row level security;
alter table public.profile_stats enable row level security;
alter table public.follows enable row level security;
alter table public.saves enable row level security;
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;

create policy "takes are public" on public.takes for select to anon, authenticated using (true);
create policy "take legs are public" on public.take_legs for select to anon, authenticated using (true);
create policy "take stats are public" on public.take_stats for select to anon, authenticated using (true);
create policy "profile stats are public" on public.profile_stats for select to anon, authenticated using (true);
create policy "follows are public" on public.follows for select to anon, authenticated using (true);
create policy "comments are public" on public.comments for select to anon, authenticated using (true);
create policy "comment likes are public" on public.comment_likes for select to anon, authenticated using (true);

revoke all on public.takes, public.take_legs, public.take_stats, public.profile_stats,
  public.follows, public.saves, public.comments, public.comment_likes
  from anon, authenticated;

grant select on public.takes, public.take_legs, public.take_stats, public.profile_stats,
  public.follows, public.comments, public.comment_likes
  to anon, authenticated;

grant select, insert, update, delete on public.takes, public.take_legs, public.take_stats,
  public.profile_stats, public.follows, public.saves, public.comments, public.comment_likes
  to service_role;
