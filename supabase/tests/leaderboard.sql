-- Checks the leaderboard's direction and the viewer's own rank
-- (migrations/*_leaderboard_dir_viewer.sql). A network of its own keeps other rows off the board.
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/leaderboard.sql
-- Each check raises if it fails.
begin;
insert into public.profiles (id, handle, display_name, solana_address, created_at) values
  ('00000000-0000-4000-8000-0000000000e1', 'lb_big', 'Big', 'LB_BIG', now() - interval '4 days'),
  ('00000000-0000-4000-8000-0000000000e2', 'lb_sharp', 'Sharp', 'LB_SHARP', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e3', 'lb_down', 'Down', 'LB_DOWN', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e4', 'lb_open', 'Open', 'LB_OPEN', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e5', 'lb_none', 'None', 'LB_NONE', now()),
  ('00000000-0000-4000-8000-0000000000e6', 'lb_fader', 'Fader', 'LB_FADER', now() - interval '5 days');

-- Big: +$30 on $100 (30%). Sharp: +$10 on $20 (50%). Down: -$5 on $50 (-10%). Open: an open
-- position only ($0, 0%). Fader faded someone's take and made $8 on $40 (20%).
insert into public.chain_positions (network, address, take, owner, side, stake, opened_at, settled_at, scored, pnl) values
  ('lb-test-net', 'LB_P1', 'LB_T', 'LB_BIG', 'back', 100000000, now() - interval '1 day', now(), true, 30000000),
  ('lb-test-net', 'LB_P2', 'LB_T', 'LB_SHARP', 'back', 20000000, now() - interval '1 day', now(), true, 10000000),
  ('lb-test-net', 'LB_P3', 'LB_T', 'LB_DOWN', 'back', 50000000, now() - interval '1 day', now(), true, -5000000),
  ('lb-test-net', 'LB_P4', 'LB_T', 'LB_OPEN', 'back', 30000000, now() - interval '1 day', null, null, null),
  ('lb-test-net', 'LB_P5', 'LB_T', 'LB_FADER', 'fade', 40000000, now() - interval '1 day', now(), true, 8000000);

do $$
declare
  down uuid := '00000000-0000-4000-8000-0000000000e3';
  j jsonb;
  order_of text;
begin
  set local role anon;

  -- Without a network: the play-money board, as an array, and no board but 'own'.
  if jsonb_typeof(public.leaderboard('all', 5)) <> 'array' then raise exception 'old call must answer an array'; end if;
  if public.leaderboard('all', 5, 'backers', 'cash', 'desc', down) <> '{"rows": [], "viewer": null}'::jsonb then
    raise exception 'no-network backers board with a viewer: %', public.leaderboard('all', 5, 'backers', 'cash', 'desc', down);
  end if;

  perform set_config('request.headers', '{"x-thesis-network":"lb-test-net"}', true);

  -- Called as before: an array, best first.
  j := public.leaderboard('all', 100, 'own', 'cash');
  if jsonb_typeof(j) <> 'array' then raise exception 'four arguments must still answer an array: %', j; end if;
  select string_agg(x -> 'person' ->> 'handle', ',' order by o) into order_of from jsonb_array_elements(j) with ordinality y(x, o);
  if order_of <> 'lb_big,lb_sharp,lb_fader,lb_open,lb_down' then raise exception 'best first by dollars: %', order_of; end if;

  -- Lowest first, by dollars and by percent.
  j := public.leaderboard('all', 100, 'own', 'cash', 'asc');
  select string_agg(x -> 'person' ->> 'handle', ',' order by o) into order_of from jsonb_array_elements(j) with ordinality y(x, o);
  if order_of <> 'lb_down,lb_open,lb_fader,lb_sharp,lb_big' then raise exception 'lowest first by dollars: %', order_of; end if;
  j := public.leaderboard('all', 100, 'own', 'pct', 'desc');
  select string_agg(x -> 'person' ->> 'handle', ',' order by o) into order_of from jsonb_array_elements(j) with ordinality y(x, o);
  if order_of <> 'lb_sharp,lb_big,lb_fader,lb_open,lb_down' then raise exception 'best first by percent: %', order_of; end if;
  j := public.leaderboard('all', 100, 'own', 'pct', 'asc');
  select string_agg(x -> 'person' ->> 'handle', ',' order by o) into order_of from jsonb_array_elements(j) with ordinality y(x, o);
  if order_of <> 'lb_down,lb_open,lb_fader,lb_big,lb_sharp' then raise exception 'lowest first by percent: %', order_of; end if;
  -- The limit cuts the lowest-first board from the bottom.
  j := public.leaderboard('all', 1, 'own', 'cash', 'asc');
  if jsonb_array_length(j) <> 1 or j -> 0 -> 'person' ->> 'handle' <> 'lb_down' then raise exception 'lowest first, limit 1: %', j; end if;

  -- With a viewer: the rows, and their place on the whole board, past the limit too.
  j := public.leaderboard('all', 2, 'own', 'cash', 'desc', down);
  if jsonb_typeof(j) <> 'object' or jsonb_array_length(j -> 'rows') <> 2 then raise exception 'viewer shape: %', j; end if;
  if j -> 'rows' <> public.leaderboard('all', 2, 'own', 'cash', 'desc') then raise exception 'rows must be the same as without a viewer: %', j; end if;
  if (j -> 'viewer' ->> 'rank')::int <> 5 or (j -> 'viewer' ->> 'cash')::numeric <> -5 or (j -> 'viewer' ->> 'pct')::numeric <> -10
     or j -> 'viewer' -> 'person' ->> 'handle' <> 'lb_down' then
    raise exception 'viewer, best first: %', j -> 'viewer';
  end if;
  j := public.leaderboard('all', 2, 'own', 'cash', 'asc', down);
  if (j -> 'viewer' ->> 'rank')::int <> 1 then raise exception 'viewer, lowest first: %', j -> 'viewer'; end if;
  j := public.leaderboard('all', 100, 'own', 'pct', 'desc', '00000000-0000-4000-8000-0000000000e2');
  if (j -> 'viewer' ->> 'rank')::int <> 1 or (j -> 'viewer' ->> 'pct')::numeric <> 50 then raise exception 'viewer by percent: %', j -> 'viewer'; end if;

  -- Not on the board: viewer null.
  j := public.leaderboard('all', 100, 'own', 'cash', 'desc', '00000000-0000-4000-8000-0000000000e5');
  if j -> 'viewer' <> 'null'::jsonb then raise exception 'off the board must be null: %', j; end if;

  -- The fader board takes the same arguments.
  j := public.leaderboard('all', 100, 'faders', 'cash', 'desc', '00000000-0000-4000-8000-0000000000e6');
  if jsonb_array_length(j -> 'rows') <> 1 or (j -> 'viewer' ->> 'rank')::int <> 1 or (j -> 'viewer' ->> 'cash')::numeric <> 8
     or (j -> 'viewer' ->> 'pct')::numeric <> 20 then
    raise exception 'fader board with a viewer: %', j;
  end if;

  begin
    perform public.leaderboard('all', 100, 'own', 'cash', 'sideways');
    raise exception 'an unknown direction must fail';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

rollback;
