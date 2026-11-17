-- Follow privacy: people choose whether others can see who they follow and
-- who follows them. Counts stay public (like X); the lists are what's hidden.
--
-- The lists used to be readable by anyone with the publishable key, for any
-- profile (followers(), following(), and following_feed(), which reveals who
-- you follow). Now only the service role can call them; the `social` edge
-- function serves them, knows who's asking (Privy token) and enforces the
-- settings. You always see your own lists.

alter table public.profiles
  add column show_following boolean not null default true,
  add column show_followers boolean not null default true;

-- "follows_you" is relative to the viewer (default: the list's owner), so a
-- list on someone else's profile marks the people who follow *you*.
drop function public.followers(uuid);
drop function public.following(uuid);

create function public.followers(p_profile uuid, p_viewer uuid default null) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    public.person_json(p) || jsonb_build_object('follows_you', exists (
      select 1 from public.follows back
      where back.follower_id = p.id and back.followee_id = coalesce(p_viewer, p_profile)
    ))
    order by f.created_at desc
  ), '[]'::jsonb)
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.followee_id = p_profile
$$;

create function public.following(p_profile uuid, p_viewer uuid default null) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    public.person_json(p) || jsonb_build_object('follows_you', exists (
      select 1 from public.follows back
      where back.follower_id = p.id and back.followee_id = coalesce(p_viewer, p_profile)
    ))
    order by f.created_at desc
  ), '[]'::jsonb)
  from public.follows f
  join public.profiles p on p.id = f.followee_id
  where f.follower_id = p_profile
$$;

-- The profile page needs to know whether to offer the lists.
create or replace function public.profile(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select public.person_json(p) || jsonb_build_object(
    'followers', (select count(*) from public.follows f where f.followee_id = p.id),
    'following', (select count(*) from public.follows f where f.follower_id = p.id),
    'show_followers', p.show_followers,
    'show_following', p.show_following
  )
  from public.profiles p where p.id = p_profile
$$;

revoke execute on function public.followers(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.following(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.following_feed(uuid, int) from public, anon, authenticated;
grant execute on function public.followers(uuid, uuid) to service_role;
grant execute on function public.following(uuid, uuid) to service_role;
grant execute on function public.following_feed(uuid, int) to service_role;

-- Suggestions leave out who you already follow, so calling them for someone
-- else's id revealed their following list. Same for take_traders' viewer flag
-- ("you follow"). Both are now served by the `social` edge function for the
-- signed-in user only. "Followed by @x" only names people who show who they follow.
create or replace function public.suggested_follows(p_profile uuid, p_limit int default 20) returns jsonb
language sql stable
set search_path = ''
as $$
  with mine as (
    select followee_id from public.follows where follower_id = p_profile
  ),
  candidates as (
    select
      p.id,
      p.created_at,
      -- Only people who show who they follow can be a "Followed by" reason.
      (select count(*) from public.follows f join mine m on m.followee_id = f.follower_id
        join public.profiles pr on pr.id = f.follower_id
        where f.followee_id = p.id and pr.show_following) as mutuals,
      (select pr.handle from public.follows f
        join mine m on m.followee_id = f.follower_id
        join public.profiles pr on pr.id = f.follower_id
        where f.followee_id = p.id and pr.handle is not null and pr.show_following
        order by pr.handle limit 1) as via,
      exists (select 1 from public.follows f where f.follower_id = p.id and f.followee_id = p_profile) as follows_you,
      (select count(*) from public.follows f where f.followee_id = p.id) as followers,
      (select count(*) from public.takes t where t.author_id = p.id and t.created_at > now() - interval '30 days') as recent_takes,
      coalesce((select s.cash from public.profile_stats s where s.profile_id = p.id and s.period = 'all'), 0) as cash
    from public.profiles p
    where p.handle is not null
      and p.id is distinct from p_profile
      and not exists (select 1 from mine m where m.followee_id = p.id)
  ),
  ranked as (
    select c.*,
      c.mutuals * 10
        + case when c.follows_you then 8 else 0 end
        + ln(1 + c.followers) * 2
        + ln(1 + greatest(c.cash, 0))
        + least(c.recent_takes, 10) * 1.5 as score
    from candidates c
    order by score desc, c.created_at
    limit least(greatest(p_limit, 1), 50)
  )
  select coalesce(jsonb_agg(
    public.person_json(p) || jsonb_build_object(
      'follows_you', r.follows_you,
      'reason', case
        when r.mutuals = 1 then 'Followed by @' || r.via
        when r.mutuals > 1 then 'Followed by @' || r.via || ' and ' || (r.mutuals - 1)
                                  || case when r.mutuals = 2 then ' other' else ' others' end
        when r.follows_you then 'Follows you'
        when r.cash > 0 then 'Top caller'
        when r.recent_takes > 0 then 'Posting takes'
        else 'New on Thesis'
      end
    )
    order by r.score desc, r.created_at
  ), '[]'::jsonb)
  from ranked r
  join public.profiles p on p.id = r.id
$$;

revoke execute on function public.suggested_follows(uuid, int) from public, anon, authenticated;
grant execute on function public.suggested_follows(uuid, int) to service_role;
revoke execute on function public.take_traders(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.take_traders(uuid, uuid, int) to service_role;
