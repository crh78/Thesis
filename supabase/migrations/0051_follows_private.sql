-- Who follows whom is no longer readable with the publishable key.
--
-- 0019_follow_privacy moved the follow lists behind the `social` edge function, which enforces
-- show_following / show_followers, but left the table itself readable by anon and authenticated
-- (0005_social's "follows are public" policy). So GET /rest/v1/follows returned anyone's list,
-- including people who chose to hide it.
--
--   follows             service role only (the social function's writes and lists, and the
--                       definer triggers that notify followers).
--   follow_counts(id)   follower and following counts, which stay public (like X), for profile().
--   profile()           same as 0019, with its counts from follow_counts().
-- The lists themselves are unchanged: followers() / following() are service role only, served by
-- `social`, which refuses a hidden list to anyone but its owner.

create function public.follow_counts(p_profile uuid, out n_followers bigint, out n_following bigint)
language sql stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.follows f where f.followee_id = p_profile),
         (select count(*) from public.follows f where f.follower_id = p_profile)
$$;

revoke execute on function public.follow_counts(uuid) from public;
grant execute on function public.follow_counts(uuid) to anon, authenticated, service_role;

create or replace function public.profile(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select public.person_json(p) || jsonb_build_object(
    'followers', c.n_followers,
    'following', c.n_following,
    'show_followers', p.show_followers,
    'show_following', p.show_following
  )
  from public.profiles p
  cross join lateral public.follow_counts(p.id) c
  where p.id = p_profile
$$;

drop policy "follows are public" on public.follows;
revoke select on public.follows from anon, authenticated;
