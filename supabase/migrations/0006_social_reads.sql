-- Read functions for the app. Each returns one screen's data as JSON in the
-- shape the iOS models decode, so a screen is one request. They run as the
-- caller (security invoker), so they only see what the RLS policies allow.
--
--   person_json / take_json   building blocks
--   feed, following_feed, trending, search_takes, profile_takes, takes_by_ids, take
--   take_comments             top-level comments with their replies
--   followers, following      people lists
--   leaderboard               Scores
--   profile                   one person with follower counts

create function public.person_json(p public.profiles) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'handle', p.handle,
    'display_name', p.display_name,
    'bio', coalesce(p.bio, ''),
    'avatar_url', p.avatar_url,
    'made', coalesce(s.cash, 0),
    'return_pct', coalesce(s.pct, 0),
    'takes', (select count(*) from public.takes t where t.author_id = p.id)
  )
  from (select 1) as one
  left join public.profile_stats s on s.profile_id = p.id and s.period = 'all'
$$;

create function public.take_json(t public.takes) returns jsonb
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
    'author', (select public.person_json(p) from public.profiles p where p.id = t.author_id),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', l.name, 'kind', l.kind, 'weight', l.weight, 'why', l.why,
        'slot', l.slot, 'fade_how', l.fade_how, 'ret', l.ret_pct
      ) order by l.idx)
      from public.take_legs l where l.take_id = t.id
    ), '[]'::jsonb),
    'ret', coalesce(s.ret_pct, 0),
    'history', coalesce(to_jsonb(s.history), '[0, 0]'::jsonb),
    'backs', coalesce(s.backs, 0),
    'fades', coalesce(s.fades, 0),
    'money_in', coalesce(s.money_in, 0),
    'comments', (select count(*) from public.comments c where c.take_id = t.id)
  )
  from (select 1) as one
  left join public.take_stats s on s.take_id = t.id
$$;

-- Feeds ------------------------------------------------------------------------

create function public.feed(p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select * from public.takes order by created_at desc limit least(greatest(p_limit, 1), 100)
  ) t
$$;

create function public.following_feed(p_profile uuid, p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk
    join public.follows f on f.followee_id = tk.author_id and f.follower_id = p_profile
    order by tk.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) t
$$;

-- Most-traded first. p_tag filters to one topic chip ('AI', 'Energy'…).
create function public.trending(p_tag text default null, p_limit int default 30) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t.take) order by t.activity desc, (t.take).created_at desc), '[]'::jsonb)
  from (
    select tk as take, coalesce(s.backs + s.fades, 0) as activity
    from public.takes tk
    left join public.take_stats s on s.take_id = tk.id
    where p_tag is null or p_tag = any (tk.tags)
    order by activity desc, tk.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) t
$$;

-- Matches the claim, the author's handle or name, or any pick in the basket.
create function public.search_takes(p_query text, p_tag text default null) returns jsonb
language sql stable
set search_path = ''
as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk, q
    where (p_tag is null or p_tag = any (tk.tags))
      and (
        tk.claim ilike q.pattern
        or exists (
          select 1 from public.profiles p
          where p.id = tk.author_id and (p.handle ilike q.pattern or p.display_name ilike q.pattern)
        )
        or exists (select 1 from public.take_legs l where l.take_id = tk.id and l.name ilike q.pattern)
      )
    order by tk.created_at desc
    limit 50
  ) t
$$;

create function public.profile_takes(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from public.takes t where t.author_id = p_profile
$$;

create function public.takes_by_ids(p_ids uuid[]) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by array_position(p_ids, t.id)), '[]'::jsonb)
  from public.takes t where t.id = any (p_ids)
$$;

create function public.take(p_id uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select public.take_json(t) from public.takes t where t.id = p_id
$$;

-- Comments ---------------------------------------------------------------------

-- Top-level comments oldest first, each with its replies. `liked` is relative
-- to p_viewer (null when signed out).
create function public.take_comments(p_take uuid, p_viewer uuid default null) returns jsonb
language sql stable
set search_path = ''
as $$
  with c as (
    select
      cm.id, cm.parent_id, cm.created_at,
      jsonb_build_object(
        'id', cm.id,
        'author', (select public.person_json(p) from public.profiles p where p.id = cm.author_id),
        'body', cm.body,
        'created_at', cm.created_at,
        'likes', (select count(*) from public.comment_likes l where l.comment_id = cm.id),
        'liked', p_viewer is not null and exists (
          select 1 from public.comment_likes l where l.comment_id = cm.id and l.profile_id = p_viewer
        )
      ) as doc
    from public.comments cm
    where cm.take_id = p_take
  )
  select coalesce(jsonb_agg(
    top.doc || jsonb_build_object('replies', coalesce((
      select jsonb_agg(r.doc order by r.created_at) from c r where r.parent_id = top.id
    ), '[]'::jsonb))
    order by top.created_at
  ), '[]'::jsonb)
  from c top
  where top.parent_id is null
$$;

-- People -----------------------------------------------------------------------

-- Who follows p_profile. `follows_you` is always true here; kept for one shape.
create function public.followers(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    public.person_json(p) || jsonb_build_object('follows_you', true)
    order by f.created_at desc
  ), '[]'::jsonb)
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.followee_id = p_profile
$$;

-- Who p_profile follows, and whether each of them follows back.
create function public.following(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    public.person_json(p) || jsonb_build_object('follows_you', exists (
      select 1 from public.follows back
      where back.follower_id = p.id and back.followee_id = p_profile
    ))
    order by f.created_at desc
  ), '[]'::jsonb)
  from public.follows f
  join public.profiles p on p.id = f.followee_id
  where f.follower_id = p_profile
$$;

create function public.profile(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select public.person_json(p) || jsonb_build_object(
    'followers', (select count(*) from public.follows f where f.followee_id = p.id),
    'following', (select count(*) from public.follows f where f.follower_id = p.id)
  )
  from public.profiles p where p.id = p_profile
$$;

-- Scores: everyone with a handle, by cash made for the period.
create function public.leaderboard(p_period text, p_limit int default 100) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'person', public.person_json(p),
    'cash', coalesce(s.cash, 0),
    'pct', coalesce(s.pct, 0)
  ) order by coalesce(s.cash, 0) desc, p.created_at), '[]'::jsonb)
  from (
    select p.* from public.profiles p
    left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
    where p.handle is not null
    order by coalesce(s.cash, 0) desc, p.created_at
    limit least(greatest(p_limit, 1), 200)
  ) p
  left join public.profile_stats s on s.profile_id = p.id and s.period = p_period
$$;

-- Access -----------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'person_json(public.profiles)', 'take_json(public.takes)',
    'feed(int)', 'following_feed(uuid, int)', 'trending(text, int)', 'search_takes(text, text)',
    'profile_takes(uuid)', 'takes_by_ids(uuid[])', 'take(uuid)', 'take_comments(uuid, uuid)',
    'followers(uuid)', 'following(uuid)', 'profile(uuid)', 'leaderboard(text, int)'
  ] loop
    execute format('revoke execute on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', fn);
  end loop;
end;
$$;
