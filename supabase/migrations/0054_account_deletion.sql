-- Deleting an account keeps the takes other people are in (decided 2026-11-18).
--
-- Before, deleting a profile cascaded to its takes, so anyone who had backed or faded one lost the
-- take page their money was on, and an on-chain take lost its app side. Now a deleted account's
-- takes stay, with no author, and show "Deleted account" wherever an author is shown.
--
--   takes.author_id      nullable, `on delete set null`.
--   comments.author_id   nullable, `on delete set null` (a backstop: delete_account() removes the
--                        person's comments itself, see below).
--   deleted_person_json() the placeholder person for a missing author: same keys as person_json(),
--                        a fixed all-zero id (clients decode id as a string), no handle, the name
--                        "Deleted account" and `deleted: true`.
--   take_json(), take_comments()  show the placeholder when the author is gone.
--   delete_account(profile)  what functions/session's DELETE runs, in one transaction:
--     1. the person's takes that nobody else is in go: no on-chain take (chain_takes), no ledger
--        row (anyone's play-money trades, the author's own included), no backs or fades counted
--        in take_stats, no comments from anyone else. Everything else stays, anonymised.
--     2. their comments go. A top-level comment someone else replied to stays as "[deleted]" with
--        no author, so the replies keep their thread.
--     3. the profile goes, and with it (cascades, as before) the account row, follows, saves,
--        likes, notifications, push subscriptions, copied X accounts, play-money positions and
--        their own ledger rows. Their remaining takes and kept comments lose their author.
--     Returns { takes_deleted, takes_kept, comments_kept }.

-- Schema -------------------------------------------------------------------------------------------

-- The changes below take exclusive locks on takes and comments: fail fast rather than queue
-- behind a relay insert (both tables are small, so this shouldn't trip).
set lock_timeout = '5s';

alter table public.takes alter column author_id drop not null;
alter table public.takes drop constraint takes_author_id_fkey;
alter table public.takes add constraint takes_author_id_fkey
  foreign key (author_id) references public.profiles (id) on delete set null;

alter table public.comments alter column author_id drop not null;
alter table public.comments drop constraint comments_author_id_fkey;
alter table public.comments add constraint comments_author_id_fkey
  foreign key (author_id) references public.profiles (id) on delete set null;

-- The placeholder ----------------------------------------------------------------------------------

create function public.deleted_person_json() returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', '00000000-0000-0000-0000-000000000000',
    'handle', null,
    'display_name', 'Deleted account',
    'bio', '',
    'avatar_url', null,
    'made', 0,
    'return_pct', 0,
    'backers_made', 0,
    'backers_pct', 0,
    'takes', 0,
    'deleted', true
  )
$$;
grant execute on function public.deleted_person_json() to anon, authenticated, service_role;

-- Reads: 0032_sources_and_x_copy's take_json and 0006_social_reads' take_comments, with the
-- placeholder for a missing author. Nothing else changes.

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
    'author', coalesce((select public.person_json(p) from public.profiles p where p.id = t.author_id),
                       public.deleted_person_json()),
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

create or replace function public.take_comments(p_take uuid, p_viewer uuid default null) returns jsonb
language sql stable
set search_path = ''
as $$
  with c as (
    select
      cm.id, cm.parent_id, cm.created_at,
      jsonb_build_object(
        'id', cm.id,
        'author', coalesce((select public.person_json(p) from public.profiles p where p.id = cm.author_id),
                           public.deleted_person_json()),
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

-- Deleting ---------------------------------------------------------------------------------------

create function public.delete_account(p_profile uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  takes_deleted int;
  takes_kept int;
  comments_kept int;
begin
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'no profile' using errcode = 'P0002';
  end if;

  -- 1. Takes nobody else is in.
  with gone as (
    delete from public.takes t
    where t.author_id = p_profile
      and not exists (select 1 from public.chain_takes ct where ct.take_id = t.id)
      and not exists (select 1 from public.ledger l where l.take_id = t.id)
      and not exists (select 1 from public.take_stats s where s.take_id = t.id and (s.backs > 0 or s.fades > 0))
      and not exists (select 1 from public.comments c where c.take_id = t.id and c.author_id is distinct from p_profile)
    returning 1
  )
  select count(*) into takes_deleted from gone;
  select count(*) into takes_kept from public.takes where author_id = p_profile;

  -- 2. Comments: a top-level one with someone else's replies stays as "[deleted]"; the rest go.
  with kept as (
    update public.comments c set author_id = null, body = '[deleted]'
    where c.author_id = p_profile and c.parent_id is null
      and exists (select 1 from public.comments r where r.parent_id = c.id and r.author_id is distinct from p_profile)
    returning 1
  )
  select count(*) into comments_kept from kept;
  delete from public.comments where author_id = p_profile;

  -- 3. The profile, and everything that cascades from it. The kept takes lose their author.
  delete from public.profiles where id = p_profile;

  return jsonb_build_object('takes_deleted', takes_deleted, 'takes_kept', takes_kept, 'comments_kept', comments_kept);
end;
$$;
revoke all on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;
