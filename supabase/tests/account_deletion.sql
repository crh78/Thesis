-- Checks deleting an account (migrations/*_account_deletion.sql): takes other people are in stay,
-- with "Deleted account" as their author; takes nobody else touched go; comments go, except a
-- top-level one others replied to, which stays as "[deleted]".
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/account_deletion.sql
-- Each check raises if it fails.
begin;
insert into public.profiles (id, handle, display_name, solana_address) values
  ('00000000-0000-4000-8000-0000000000d1', 'leaving', 'Leaving', 'W_LEAVING'),
  ('00000000-0000-4000-8000-0000000000d2', 'staying', 'Staying', 'W_STAYING'),
  ('00000000-0000-4000-8000-0000000000d3', 'chatty', 'Chatty', 'W_CHATTY');
insert into public.follows (follower_id, followee_id) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d1');

do $$
declare
  me uuid := '00000000-0000-4000-8000-0000000000d1';
  staying uuid := '00000000-0000-4000-8000-0000000000d2';
  chatty uuid := '00000000-0000-4000-8000-0000000000d3';
  legs jsonb := '[{"name":"Nvidia","kind":"Stock","weight":100,"why":"chips"}]';
  lonely uuid; posting uuid; on_chain uuid; backed uuid; discussed uuid; theirs uuid;
  answered uuid; unanswered uuid; their_comment uuid; my_reply uuid; reply uuid;
  answer jsonb;
  j jsonb;
begin
  lonely := public.create_take(me, 'Nobody else cares about this one', 'topic-coin', 'medium', '3mo', '{}', legs, 'live');
  posting := public.create_take(me, 'This one never made it on-chain', 'topic-coin', 'medium', '3mo', '{}', legs, 'posting');
  on_chain := public.create_take(me, 'Chips keep leading all year', 'topic-chips', 'medium', '3mo', '{}', legs, 'live');
  backed := public.create_take(me, 'Copper is the new oil', 'topic-coin', 'high', '1mo', '{}', legs, 'live');
  discussed := public.create_take(me, 'Rates fall by June', 'topic-coin', 'low', '3mo', '{}', legs, 'live');
  theirs := public.create_take(staying, 'Gold has more room to run', 'topic-coin', 'low', '6mo', '{}', legs, 'live');

  -- Someone else is in each of these: an on-chain take, a counted back, another person's comment.
  insert into public.chain_takes (network, address, take_id, author_wallet, backers)
  values ('deletion-test-net', 'T_DELETION', on_chain, 'W_LEAVING', 1);
  update public.take_stats set backs = 1 where take_id = backed;
  insert into public.comments (take_id, author_id, body) values (discussed, chatty, 'Bold call');

  -- On someone else's take: a comment with a reply from someone else, one without, and a reply.
  insert into public.comments (take_id, author_id, body) values (theirs, me, 'Gold is done') returning id into answered;
  insert into public.comments (take_id, author_id, parent_id, body) values (theirs, chatty, answered, 'Disagree') returning id into reply;
  insert into public.comments (take_id, author_id, body) values (theirs, me, 'Second thought') returning id into unanswered;
  insert into public.comments (take_id, author_id, body) values (theirs, staying, 'Thanks all') returning id into their_comment;
  insert into public.comments (take_id, author_id, parent_id, body) values (theirs, me, their_comment, 'Anytime') returning id into my_reply;
  insert into public.comment_likes (comment_id, profile_id) values (reply, me), (their_comment, me), (answered, chatty);
  insert into public.saves (profile_id, take_id) values (me, theirs), (staying, lonely);

  answer := public.delete_account(me);
  if answer <> '{"takes_deleted": 2, "takes_kept": 3, "comments_kept": 1}'::jsonb then
    raise exception 'delete_account answered %', answer;
  end if;

  -- The profile and what hangs off it are gone.
  if exists (select 1 from public.profiles where id = me) then raise exception 'profile still there'; end if;
  if exists (select 1 from public.accounts where profile_id = me) then raise exception 'account row still there'; end if;
  if exists (select 1 from public.follows where me in (follower_id, followee_id)) then raise exception 'follows still there'; end if;
  if exists (select 1 from public.comment_likes where profile_id = me) then raise exception 'likes still there'; end if;
  if exists (select 1 from public.saves where profile_id = me) then raise exception 'saves still there'; end if;

  -- Takes nobody else touched went; the rest stayed, with no author.
  if exists (select 1 from public.takes where id in (lonely, posting)) then raise exception 'untouched takes must go'; end if;
  if (select count(*) from public.takes where id in (on_chain, backed, discussed) and author_id is null) <> 3 then
    raise exception 'takes others are in must stay, anonymised';
  end if;
  if (select take_id from public.chain_takes where address = 'T_DELETION') is distinct from on_chain then
    raise exception 'the on-chain take lost its app take';
  end if;

  -- Shown as "Deleted account", with an id clients can decode.
  j := public.take(on_chain);
  if j -> 'author' <> public.deleted_person_json()
     or j -> 'author' ->> 'display_name' <> 'Deleted account'
     or j -> 'author' ->> 'id' <> '00000000-0000-0000-0000-000000000000'
     or (j -> 'author' ->> 'deleted')::boolean is not true then
    raise exception 'the author of a kept take: %', j -> 'author';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.feed(100)) x where (x ->> 'id')::uuid = backed and x -> 'author' ->> 'display_name' = 'Deleted account') then
    raise exception 'the feed must show the kept take with the placeholder author';
  end if;
  if (public.take(discussed) ->> 'comments')::int <> 1 then raise exception 'others'' comments on a kept take stay'; end if;

  -- Comments: the answered one stays as "[deleted]" with its reply; the rest of theirs went.
  if exists (select 1 from public.comments where id in (unanswered, my_reply)) then raise exception 'their comments must go'; end if;
  if (select (author_id, body) from public.comments where id = answered) is distinct from (null::uuid, '[deleted]'::text) then
    raise exception 'an answered comment stays as [deleted] with no author';
  end if;
  if not exists (select 1 from public.comment_likes where comment_id = answered and profile_id = chatty) then
    raise exception 'others'' likes on a kept comment stay';
  end if;
  j := public.take_comments(theirs);
  if jsonb_array_length(j) <> 2 then raise exception 'thread: %', j; end if;
  if (select x -> 'author' ->> 'display_name' from jsonb_array_elements(j) x where (x ->> 'id')::uuid = answered) <> 'Deleted account'
     or (select jsonb_array_length(x -> 'replies') from jsonb_array_elements(j) x where (x ->> 'id')::uuid = answered) <> 1 then
    raise exception 'the kept comment keeps its reply and shows the placeholder: %', j;
  end if;
  if (select jsonb_array_length(x -> 'replies') from jsonb_array_elements(j) x where (x ->> 'id')::uuid = their_comment) <> 0 then
    raise exception 'their reply under someone else''s comment must go: %', j;
  end if;

  -- Commenting on a kept take still works (no author to notify).
  insert into public.comments (take_id, author_id, body) values (backed, chatty, 'Still here');

  -- Only the service role may delete accounts.
  if has_function_privilege('anon', 'public.delete_account(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.delete_account(uuid)', 'execute') then
    raise exception 'delete_account must be service role only';
  end if;

  begin
    perform public.delete_account(me);
    raise exception 'deleting a missing profile must fail';
  exception when no_data_found then null;
  end;
end;
$$;

rollback;
