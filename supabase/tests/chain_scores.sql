-- Checks chain_positions and the chain leaderboard (migrations/*_chain_scores.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/chain_scores.sql
-- Each check raises if it fails. Events are shaped like functions/quicknode-stream sends them.
begin;
insert into public.profiles (id, handle, display_name, solana_address, created_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'winner', 'Winner', 'W_WIN', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000c2', 'loser', 'Loser', 'W_LOSE', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000c3', 'playmoney', 'Play money', 'W_NONE', now() - interval '4 days'),
  ('00000000-0000-4000-8000-0000000000c4', 'holder', 'Holder', 'W_OPEN', now() - interval '5 days'),
  ('00000000-0000-4000-8000-0000000000c5', 'backer', 'Backer', 'W_BACK', now() - interval '6 days'),
  ('00000000-0000-4000-8000-0000000000c6', 'fader', 'Fader', 'W_FADE', now() - interval '7 days');
insert into public.profile_stats (profile_id, period, cash, pct) values
  ('00000000-0000-4000-8000-0000000000c3', 'all', 9999, 99),
  ('00000000-0000-4000-8000-0000000000c3', 'week', 9999, 99);

do $$
declare
  t0 double precision := extract(epoch from now() - interval '1 hour');
  old double precision := extract(epoch from now() - interval '20 days');
  ev jsonb;
  j jsonb;
  s record;
begin
  ev := jsonb_build_array(
    -- Winner: $100 back, +20% at the horizon ($20), plus a $50 sale at -10% ($-5) settled 20 days ago.
    jsonb_build_object('signature','a1','ordinal',0,'slot',1,'block_time',old,'name','positionOpened',
      'data', jsonb_build_object('take','T1','position','P_W1','owner','W_WIN','side','back','stake','50000000','scored',true)),
    jsonb_build_object('signature','a2','ordinal',0,'slot',2,'block_time',old,'name','positionExited',
      'data', jsonb_build_object('take','T1','position','P_W1','owner','W_WIN','side','back','exitedAt', old::bigint::text)),
    jsonb_build_object('signature','a3','ordinal',0,'slot',3,'block_time',old,'name','positionSettled',
      'data', jsonb_build_object('take','T1','position','P_W1','owner','W_WIN','side','back','returnBps','-1000','pnl','-5000000','scored',true,'exited',true)),
    jsonb_build_object('signature','b1','ordinal',0,'slot',4,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_W2','owner','W_WIN','side','back','stake','100000000','scored',true)),
    jsonb_build_object('signature','b2','ordinal',0,'slot',5,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_W2','owner','W_WIN','side','back','returnBps','2000','pnl','20000000','scored',true,'exited',false)),
    jsonb_build_object('signature','b3','ordinal',0,'slot',6,'block_time',t0,'name','takeSettled',
      'data', jsonb_build_object('take','T2','author','W_WIN','resultBps','2000')),
    -- Loser: a $40 fade at -50% ($-20), and an unscored $5 dust position that "won" big.
    jsonb_build_object('signature','c1','ordinal',0,'slot',7,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_L1','owner','W_LOSE','side','fade','stake','40000000','scored',true)),
    jsonb_build_object('signature','c2','ordinal',0,'slot',8,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_L1','owner','W_LOSE','side','fade','returnBps','-5000','pnl','-20000000','scored',true,'exited',false)),
    jsonb_build_object('signature','c3','ordinal',0,'slot',9,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_L2','owner','W_LOSE','side','back','stake','5000000','scored',false)),
    jsonb_build_object('signature','c4','ordinal',0,'slot',10,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_L2','owner','W_LOSE','side','back','returnBps','90000','pnl','45000000','scored',false,'exited',false)),
    -- Holder: an open position only.
    jsonb_build_object('signature','d1','ordinal',0,'slot',11,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_O1','owner','W_OPEN','side','back','stake','30000000','scored',true)),
    -- A wallet with no profile.
    jsonb_build_object('signature','e1','ordinal',0,'slot',12,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_X1','owner','W_ANON','side','back','stake','30000000','scored',true)),
    -- Who posted the takes: Loser posted T1, Winner posted T2.
    jsonb_build_object('signature','f1','ordinal',0,'slot',13,'block_time',old,'name','takeCreated',
      'data', jsonb_build_object('take','T1','author','W_LOSE')),
    jsonb_build_object('signature','f2','ordinal',0,'slot',14,'block_time',t0,'name','takeCreated',
      'data', jsonb_build_object('take','T2','author','W_WIN')),
    -- Winner's backers on T2: Backer's $400 at +5% ($20), and a wallet with no profile, $50 at -10% ($-5).
    jsonb_build_object('signature','g1','ordinal',0,'slot',15,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_B1','owner','W_BACK','side','back','stake','400000000','scored',true)),
    jsonb_build_object('signature','g2','ordinal',0,'slot',16,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_B1','owner','W_BACK','side','back','returnBps','500','pnl','20000000','scored',true,'exited',false)),
    jsonb_build_object('signature','g3','ordinal',0,'slot',17,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_X2','owner','W_ANON','side','back','stake','50000000','scored',true)),
    jsonb_build_object('signature','g4','ordinal',0,'slot',18,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_X2','owner','W_ANON','side','back','returnBps','-1000','pnl','-5000000','scored',true,'exited',false)),
    -- Fader: an $80 fade of Winner's T2 at +50% ($40).
    jsonb_build_object('signature','h1','ordinal',0,'slot',19,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T2','position','P_F1','owner','W_FADE','side','fade','stake','80000000','scored',true)),
    jsonb_build_object('signature','h2','ordinal',0,'slot',20,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T2','position','P_F1','owner','W_FADE','side','fade','returnBps','5000','pnl','40000000','scored',true,'exited',false))
  );
  perform public.ingest_chain_events('solana-mainnet-fork', ev);

  -- Positions follow the events.
  if (select (exited_at is not null, settled_at is not null, pnl) from public.chain_positions where address = 'P_W1')
     is distinct from (true, true, -5000000::numeric) then raise exception 'sold position not tracked'; end if;
  if (select settled_at from public.chain_positions where address = 'P_O1') is not null then raise exception 'open position marked settled'; end if;

  -- Raw stats match the program's Profile rules.
  select * into s from public.chain_wallet_stats('solana-mainnet-fork') where owner = 'W_WIN';
  if (s.scored_stake, s.pnl, s.wins, s.settled, s.takes_settled) is distinct from (150000000::numeric, 15000000::numeric, 1::bigint, 2::bigint, 1::bigint) then
    raise exception 'winner all-time stats: %', row_to_json(s);
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork') where owner = 'W_LOSE';
  if (s.scored_stake, s.pnl, s.wins, s.settled) is distinct from (40000000::numeric, -20000000::numeric, 0::bigint, 2::bigint) then
    raise exception 'unscored positions must not count: %', row_to_json(s);
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork', now() - interval '7 days') where owner = 'W_WIN';
  if (s.scored_stake, s.pnl) is distinct from (100000000::numeric, 20000000::numeric) then raise exception 'week stats: %', row_to_json(s); end if;

  -- Without the header: the play-money board, as before.
  set local role anon;
  j := public.leaderboard('all', 100);
  if not exists (select 1 from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'playmoney') then
    raise exception 'the play-money board must still show without the header';
  end if;

  -- With it: chain activity only, by P&L.
  perform set_config('request.headers', '{"x-thesis-network":"solana-mainnet-fork"}', true);
  j := public.leaderboard('all', 100);
  if exists (select 1 from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'playmoney') then
    raise exception 'play-money accounts must not be on the chain board: %', j;
  end if;
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)
      where x -> 'person' ->> 'handle' in ('winner', 'loser', 'holder')) <> 'winner,holder,loser' then
    raise exception 'wrong order: %', j;
  end if;
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 15
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 10 then
    raise exception 'winner row: %', j;
  end if;
  if (select (x -> 'person' ->> 'made')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> -20 then
    raise exception 'person_json made must be the chain P&L: %', j;
  end if;
  j := public.leaderboard('week', 100);
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 20 then
    raise exception 'week board: %', j;
  end if;

  -- Sorted by percent: Winner's +10% beats Backer's +5%, though Backer made more dollars.
  j := public.leaderboard('all', 100, 'own', 'cash');
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)
      where x -> 'person' ->> 'handle' in ('winner', 'backer', 'holder', 'loser')) <> 'backer,winner,holder,loser' then
    raise exception 'own board by dollars: %', j;
  end if;
  j := public.leaderboard('all', 100, 'own', 'pct');
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)
      where x -> 'person' ->> 'handle' in ('winner', 'backer', 'holder', 'loser')) <> 'winner,backer,holder,loser' then
    raise exception 'own board by percent: %', j;
  end if;

  -- Made for backers: only backs by other wallets that settled and scored. Winner's backers made
  -- $20 - $5 on $450 (their own $100, the fade, the dust and the open positions don't count);
  -- Loser's one backer lost $5 on $50, 20 days ago.
  j := public.leaderboard('all', 100, 'backers');
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)
      where x -> 'person' ->> 'handle' in ('winner', 'backer', 'holder', 'loser', 'playmoney')) <> 'winner,loser' then
    raise exception 'backers board lists only take authors, by what backers made: %', j;
  end if;
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 15
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 3.3333
     or (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> -5
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> -10 then
    raise exception 'backers board rows: %', j;
  end if;
  if (select (x -> 'person' ->> 'backers_made')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 15
     or (select (x -> 'person' ->> 'backers_pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'winner') <> 3.3333 then
    raise exception 'person_json must carry what backers made: %', j;
  end if;
  j := public.leaderboard('week', 100, 'backers', 'pct');
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> 0
     or (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)) <> 'winner,loser' then
    raise exception 'week backers board: %', j;
  end if;
  -- Faders: Loser's $40 fade of Winner's take lost $20; Fader's $80 fade of it made $40. Nobody
  -- else has faded.
  j := public.leaderboard('all', 100, 'faders');
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)) <> 'fader,loser' then
    raise exception 'faders board lists only faders, by what they made: %', j;
  end if;
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'fader') <> 40
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'fader') <> 50
     or (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> -20
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'loser') <> -50 then
    raise exception 'faders board rows: %', j;
  end if;
  -- The fade doesn't count toward what Winner made for backers (checked above: still $15).
  begin
    perform public.leaderboard('all', 100, 'nope');
    raise exception 'an unknown board must be refused';
  exception when invalid_parameter_value then null;
  end;
  -- Without the header there is no backers board, and nobody has backers numbers.
  perform set_config('request.headers', '{}', true);
  if public.leaderboard('all', 100, 'backers') <> '[]'::jsonb then raise exception 'play money has no backers board'; end if;
  if exists (select 1 from jsonb_array_elements(public.leaderboard('all', 100, 'own', 'pct')) x where (x -> 'person' ->> 'backers_made')::numeric <> 0) then
    raise exception 'play money has no backers numbers';
  end if;
  reset role;
  select * into s from public.chain_backer_stats('solana-mainnet-fork') where author = 'W_WIN';
  if (s.backer_stake, s.backer_pnl, s.backers) is distinct from (450000000::numeric, 15000000::numeric, 2::bigint) then
    raise exception 'backer stats: %', row_to_json(s);
  end if;

  -- A fork reset that reuses an address starts the row over.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','z1','ordinal',0,'slot',99,'block_time',extract(epoch from now()),'name','positionOpened',
      'data', jsonb_build_object('take','T9','position','P_W2','owner','W_WIN','side','back','stake','10000000','scored',true))));
  if (select (stake, settled_at) from public.chain_positions where address = 'P_W2') is distinct from (10000000::numeric, null::timestamptz) then
    raise exception 'reused address not reset';
  end if;
  raise notice 'chain_scores: all checks passed';
end $$;
rollback;
