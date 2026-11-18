-- Posting takes stay hidden from everyone but their author, whoever runs the read.
--
-- 0026_post_after_chain hid posting takes with RLS, which holds for the publishable key. The
-- `social` edge function runs reads with the service role, which skips RLS, so the following feed
-- showed people's still-posting takes to their followers, and every take count (person_json, the
-- follow lists, suggestions) counted them. Each read below now asks for live takes itself, so it
-- doesn't matter which role calls it. The author still sees their own posting takes through
-- posting_takes() and take_for_chain(), as before.
--
-- Same functions, signatures and grants as before (0006_social_reads, 0019_follow_privacy,
-- 0023_assets, 0030_two_scores); only `status = 'live'` is added. take() is left as it is: the
-- social function returns a new posting take to its author through it, and RLS keeps it from
-- anyone else.

-- Same as 0030_two_scores, counting live takes only.
create or replace function public.person_json(p public.profiles) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'handle', p.handle,
    'display_name', p.display_name,
    'bio', coalesce(p.bio, ''),
    'avatar_url', p.avatar_url,
    'made', case when n.network is null then coalesce(s.cash, 0) else coalesce(c.made, 0) end,
    'return_pct', case when n.network is null then coalesce(s.pct, 0) else coalesce(c.pct, 0) end,
    'backers_made', coalesce(b.made, 0),
    'backers_pct', coalesce(b.pct, 0),
    'takes', (select count(*) from public.takes t where t.author_id = p.id and t.status = 'live')
  )
  from (select public.request_network() as network) as n
  left join public.profile_stats s on n.network is null and s.profile_id = p.id and s.period = 'all'
  left join lateral public.chain_wallet_made(n.network, p.solana_address) c on n.network is not null
  left join lateral public.chain_backers_made(n.network, p.solana_address) b on n.network is not null
$$;

-- Feeds (0006_social_reads) ---------------------------------------------------------------------

create or replace function public.feed(p_limit int default 50) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select * from public.takes where status = 'live'
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
    where tk.status = 'live'
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
    where tk.status = 'live' and (p_tag is null or p_tag = any (tk.tags))
    order by activity desc, tk.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) t
$$;

create or replace function public.search_takes(p_query text, p_tag text default null) returns jsonb
language sql stable
set search_path = ''
as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk, q
    where tk.status = 'live'
      and (p_tag is null or p_tag = any (tk.tags))
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

create or replace function public.profile_takes(p_profile uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from public.takes t where t.author_id = p_profile and t.status = 'live'
$$;

create or replace function public.takes_by_ids(p_ids uuid[]) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.take_json(t) order by array_position(p_ids, t.id)), '[]'::jsonb)
  from public.takes t where t.id = any (p_ids) and t.status = 'live'
$$;

-- Same as 0023_assets.
create or replace function public.asset_takes(p_asset text, p_limit int default 20) returns jsonb
language sql stable
set search_path = ''
as $$
  with a as (select s.id, s.underlying from public.securities s where s.id = p_asset)
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk
    where tk.status = 'live'
      and exists (
        select 1 from public.take_legs l
        join public.securities s on s.id = l.asset_id
        join a on (a.underlying is not null and s.underlying = a.underlying and s.kind <> 'yield') or s.id = a.id
        where l.take_id = tk.id
      )
    order by tk.created_at desc
    limit least(greatest(p_limit, 1), 50)
  ) t
$$;

-- Same as 0019_follow_privacy: "Posting takes" counts live takes only.
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
      (select count(*) from public.takes t
        where t.author_id = p.id and t.status = 'live' and t.created_at > now() - interval '30 days') as recent_takes,
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
