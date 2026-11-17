-- Suggested follows for a profile (onboarding + "Suggested for you").
--
-- Everyone with a handle you don't already follow, ranked by:
--   people followed by people you follow (strongest), people who follow you,
--   then followers, cash made and takes posted in the last 30 days.
-- Each comes with a short `reason` for the UI. Same person shape as the other
-- people lists (person_json + follows_you). Runs as the caller; all inputs are
-- public (profiles, follows, takes, profile_stats).

create function public.suggested_follows(p_profile uuid, p_limit int default 20) returns jsonb
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
      (select count(*) from public.follows f join mine m on m.followee_id = f.follower_id
        where f.followee_id = p.id) as mutuals,
      (select pr.handle from public.follows f
        join mine m on m.followee_id = f.follower_id
        join public.profiles pr on pr.id = f.follower_id
        where f.followee_id = p.id and pr.handle is not null
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

revoke execute on function public.suggested_follows(uuid, int) from public;
grant execute on function public.suggested_follows(uuid, int) to anon, authenticated, service_role;
