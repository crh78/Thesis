-- Checks chain_positions and the chain leaderboard (migrations/*_chain_scores.sql), partial
-- sales in them (migrations/*_partial_sales.sql), and inverted takes (migrations/*_inverted_takes.sql).
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

  -- The author's sale closes and settles a take early (migrations/*_author_sale_closes.sql); a
  -- backer who sells after that still counts toward what the author made for backers.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','k1','ordinal',0,'slot',30,'block_time',t0,'name','takeCreated',
      'data', jsonb_build_object('take','T3','author','W_WIN')),
    jsonb_build_object('signature','k2','ordinal',0,'slot',31,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T3','position','P_B3','owner','W_BACK','side','back','stake','100000000','scored',true)),
    jsonb_build_object('signature','k3','ordinal',0,'slot',32,'block_time',t0,'name','takeClosed',
      'data', jsonb_build_object('take','T3','author','W_WIN')),
    jsonb_build_object('signature','k4','ordinal',0,'slot',33,'block_time',t0,'name','takeSettled',
      'data', jsonb_build_object('take','T3','author','W_WIN','resultBps','1000')),
    jsonb_build_object('signature','k5','ordinal',0,'slot',34,'block_time',extract(epoch from now()),'name','positionExited',
      'data', jsonb_build_object('take','T3','position','P_B3','owner','W_BACK','side','back','exitedAt',extract(epoch from now())::bigint::text)),
    jsonb_build_object('signature','k6','ordinal',0,'slot',35,'block_time',extract(epoch from now()),'name','positionSettled',
      'data', jsonb_build_object('take','T3','position','P_B3','owner','W_BACK','side','back','returnBps','3000','pnl','30000000','scored',true,'exited',true))));
  select * into s from public.chain_backer_stats('solana-mainnet-fork') where author = 'W_WIN';
  if (s.backer_stake, s.backer_pnl, s.backers) is distinct from (550000000::numeric, 45000000::numeric, 2::bigint) then
    raise exception 'a backer settling after the take settled early must count: %', row_to_json(s);
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork') where owner = 'W_WIN';
  if s.takes_settled <> 2 then raise exception 'the early-settled take counts as settled: %', row_to_json(s); end if;

  -- Partial sales (migrations/*_partial_sales.sql). Parter backs Loser's T4 with $100, sells 25%
  -- ($25 of basis) at +20% ($5) 20 days ago, then another $25 that settles unscored at 0% (prices
  -- never came), then sells the last $50 at -4% ($-2). Each piece counts at its own settle time;
  -- the position is one win, since $5 + $0 - $2 > 0 though the final sale lost.
  insert into public.profiles (id, handle, display_name, solana_address, created_at) values
    ('00000000-0000-4000-8000-0000000000c7', 'parter', 'Parter', 'W_PART', now() - interval '8 days');
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','m1','ordinal',0,'slot',40,'block_time',old,'name','takeCreated',
      'data', jsonb_build_object('take','T4','author','W_LOSE')),
    jsonb_build_object('signature','m2','ordinal',0,'slot',41,'block_time',old,'name','positionOpened',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','stake','100000000','scored',true)),
    jsonb_build_object('signature','m3','ordinal',0,'slot',42,'block_time',old,'name','positionPartSold',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','seq',0,'bps',2500,
        'stakeSold','25000000','remainingStake','75000000','escrowReturned','0','soldAt',old::bigint::text)),
    jsonb_build_object('signature','m4','ordinal',0,'slot',43,'block_time',old,'name','partSettled',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','seq',0,
        'stake','25000000','returnBps','2000','pnl','5000000','scored',true))));
  if (select (remaining, realized_pnl, settled_at) from public.chain_positions where address = 'P_P1')
     is distinct from (75000000::numeric, 5000000::numeric, null::timestamptz) then
    raise exception 'a partial sale must lower remaining and realize P&L, leaving the position open';
  end if;
  if (select (bps, stake, remaining, sold_at, scored, pnl) from public.chain_position_parts where position = 'P_P1' and seq = 0)
     is distinct from (2500, 25000000::numeric, 75000000::numeric, to_timestamp(old::bigint), true, 5000000::numeric) then
    raise exception 'part row: %', (select row_to_json(pp) from public.chain_position_parts pp where position = 'P_P1' and seq = 0);
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork') where owner = 'W_PART';
  if (s.scored_stake, s.pnl, s.wins, s.settled) is distinct from (25000000::numeric, 5000000::numeric, 0::bigint, 0::bigint) then
    raise exception 'a settled partial sale counts before the position settles: %', row_to_json(s);
  end if;

  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','m5','ordinal',0,'slot',44,'block_time',t0,'name','positionPartSold',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','seq',1,'bps',3333,
        'stakeSold','25000000','remainingStake','50000000','escrowReturned','0','soldAt',t0::bigint::text)),
    jsonb_build_object('signature','m6','ordinal',0,'slot',45,'block_time',t0,'name','partSettled',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','seq',1,
        'stake','25000000','returnBps','0','pnl','0','scored',false)),
    jsonb_build_object('signature','m7','ordinal',0,'slot',46,'block_time',t0,'name','positionExited',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','exitedAt',t0::bigint::text,'stake','50000000')),
    jsonb_build_object('signature','m8','ordinal',0,'slot',47,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T4','position','P_P1','owner','W_PART','side','back','returnBps','-400','pnl','-2000000',
        'scored',true,'exited',true,'stake','50000000')),
    -- Fader fades T4 with $40 and sells a quarter at +20%. Its partSettled carries only the
    -- position (and positionPartSold never arrived): owner, take and side come from the position.
    jsonb_build_object('signature','m9','ordinal',0,'slot',48,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T4','position','P_F2','owner','W_FADE','side','fade','stake','40000000','scored',true)),
    jsonb_build_object('signature','m10','ordinal',0,'slot',49,'block_time',t0,'name','partSettled',
      'data', jsonb_build_object('position','P_F2','seq',0,'stake','10000000','returnBps','2000','pnl','2000000','scored',true))));
  if (select (remaining, settled_stake, realized_pnl) from public.chain_positions where address = 'P_P1')
     is distinct from (50000000::numeric, 50000000::numeric, 5000000::numeric) then
    raise exception 'settled position: %', (select row_to_json(cp) from public.chain_positions cp where address = 'P_P1');
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork') where owner = 'W_PART';
  if (s.scored_stake, s.pnl, s.wins, s.settled) is distinct from (75000000::numeric, 3000000::numeric, 1::bigint, 1::bigint) then
    raise exception 'parts plus the final settlement, unscored part left out, one win: %', row_to_json(s);
  end if;
  select * into s from public.chain_wallet_stats('solana-mainnet-fork', now() - interval '7 days') where owner = 'W_PART';
  if (s.scored_stake, s.pnl, s.wins, s.settled) is distinct from (50000000::numeric, -2000000::numeric, 1::bigint, 1::bigint) then
    raise exception 'a partial sale counts in the period it settled in: %', row_to_json(s);
  end if;
  if (select (made, pct) from public.chain_wallet_made('solana-mainnet-fork', 'W_PART')) is distinct from (3.00::numeric, 4.0000::numeric) then
    raise exception 'chain_wallet_made with partial sales: %', (select row_to_json(m) from public.chain_wallet_made('solana-mainnet-fork', 'W_PART') m);
  end if;
  -- Loser's backers: Winner's $50 at $-5 before, plus Parter's $75 scored at $+3.
  select * into s from public.chain_backer_stats('solana-mainnet-fork') where author = 'W_LOSE';
  if (s.backer_stake, s.backer_pnl, s.backers) is distinct from (125000000::numeric, -2000000::numeric, 2::bigint) then
    raise exception 'backer stats with partial sales: %', row_to_json(s);
  end if;
  if (select (made, pct) from public.chain_backers_made('solana-mainnet-fork', 'W_LOSE')) is distinct from (-2.00::numeric, -1.6000::numeric) then
    raise exception 'chain_backers_made with partial sales';
  end if;
  -- Fader: the $80 fade at $+40, plus the open fade's settled quarter ($10 at $+2); two positions.
  select * into s from public.chain_fader_stats('solana-mainnet-fork') where owner = 'W_FADE';
  if (s.fade_stake, s.fade_pnl, s.fades) is distinct from (90000000::numeric, 42000000::numeric, 2::bigint) then
    raise exception 'fader stats with partial sales: %', row_to_json(s);
  end if;
  set local role anon;
  perform set_config('request.headers', '{"x-thesis-network":"solana-mainnet-fork"}', true);
  j := public.leaderboard('all', 100);
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'parter') <> 3
     or (select (x ->> 'pct')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'parter') <> 4
     or (select (x -> 'person' ->> 'made')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'parter') <> 3 then
    raise exception 'the board counts partial sales: %', j;
  end if;
  j := public.leaderboard('all', 100, 'faders');
  if (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'fader') <> 42 then
    raise exception 'the faders board counts partial sales: %', j;
  end if;
  perform set_config('request.headers', '{}', true);
  reset role;

  -- A fork reset that reuses the address drops the old position's partial sales.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','m11','ordinal',0,'slot',100,'block_time',extract(epoch from now()) + 60,'name','positionOpened',
      'data', jsonb_build_object('take','T9','position','P_P1','owner','W_PART','side','back','stake','10000000','scored',true))));
  if (select (remaining, settled_stake, realized_pnl) from public.chain_positions where address = 'P_P1')
     is distinct from (null::numeric, null::numeric, null::numeric)
     or exists (select 1 from public.chain_position_parts where position = 'P_P1') then
    raise exception 'reused address keeps old partial sales';
  end if;

  -- Inverted takes (migrations/*_inverted_takes.sql). Winner posts T5, inverted: their buy-in is a
  -- fade. Backer agrees ($100 on-chain fade at +10%, $10): it counts toward what Winner made for
  -- backers, not on the faders board. Fader disagrees ($20 on-chain back at +20%, $4): it counts
  -- as a fade. A wallet with no profile disagrees too ($50 back, $-5): not a backer.
  perform public.ingest_chain_events('solana-mainnet-fork', jsonb_build_array(
    jsonb_build_object('signature','v1','ordinal',0,'slot',60,'block_time',t0,'name','takeCreated',
      'data', jsonb_build_object('take','T5','author','W_WIN','inverted',true)),
    jsonb_build_object('signature','v1','ordinal',1,'slot',60,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T5','position','P_V0','owner','W_WIN','side','fade','stake','10000000','scored',true)),
    jsonb_build_object('signature','v2','ordinal',0,'slot',61,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T5','position','P_V1','owner','W_BACK','side','fade','stake','100000000','scored',true)),
    jsonb_build_object('signature','v3','ordinal',0,'slot',62,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T5','position','P_V1','owner','W_BACK','side','fade','returnBps','1000','pnl','10000000','scored',true,'exited',true)),
    jsonb_build_object('signature','v4','ordinal',0,'slot',63,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T5','position','P_V2','owner','W_FADE','side','back','stake','20000000','scored',true)),
    jsonb_build_object('signature','v5','ordinal',0,'slot',64,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T5','position','P_V2','owner','W_FADE','side','back','returnBps','2000','pnl','4000000','scored',true,'exited',true)),
    jsonb_build_object('signature','v6','ordinal',0,'slot',65,'block_time',t0,'name','positionOpened',
      'data', jsonb_build_object('take','T5','position','P_V3','owner','W_ANON','side','back','stake','50000000','scored',true)),
    jsonb_build_object('signature','v7','ordinal',0,'slot',66,'block_time',t0,'name','positionSettled',
      'data', jsonb_build_object('take','T5','position','P_V3','owner','W_ANON','side','back','returnBps','-1000','pnl','-5000000','scored',true,'exited',true))));
  if (select side from public.chain_positions where address = 'P_V1') <> 'fade' then raise exception 'positions keep their on-chain side'; end if;
  -- Winner's backers: $550 at $+45 before, plus Backer's agreeing $100 at $+10; still two wallets.
  select * into s from public.chain_backer_stats('solana-mainnet-fork') where author = 'W_WIN';
  if (s.backer_stake, s.backer_pnl, s.backers) is distinct from (650000000::numeric, 55000000::numeric, 2::bigint) then
    raise exception 'an inverted take''s backers are who agreed (on-chain fades): %', row_to_json(s);
  end if;
  if (select (made, pct) from public.chain_backers_made('solana-mainnet-fork', 'W_WIN')) is distinct from (55.00::numeric, 8.4615::numeric) then
    raise exception 'chain_backers_made on an inverted take: %', (select row_to_json(m) from public.chain_backers_made('solana-mainnet-fork', 'W_WIN') m);
  end if;
  -- Fader: $90 at $+42 before, plus the disagreeing $20 back at $+4; three positions.
  select * into s from public.chain_fader_stats('solana-mainnet-fork') where owner = 'W_FADE';
  if (s.fade_stake, s.fade_pnl, s.fades) is distinct from (110000000::numeric, 46000000::numeric, 3::bigint) then
    raise exception 'an inverted take''s faders are who disagreed (on-chain backs): %', row_to_json(s);
  end if;
  if exists (select 1 from public.chain_fader_stats('solana-mainnet-fork') where owner in ('W_BACK', 'W_WIN')) then
    raise exception 'agreeing with an inverted take (or posting it) isn''t a fade';
  end if;
  set local role anon;
  perform set_config('request.headers', '{"x-thesis-network":"solana-mainnet-fork"}', true);
  j := public.leaderboard('all', 100, 'faders');
  if (select string_agg(x -> 'person' ->> 'handle', ',' order by o) from jsonb_array_elements(j) with ordinality y(x, o)) <> 'fader,loser'
     or (select (x ->> 'cash')::numeric from jsonb_array_elements(j) x where x -> 'person' ->> 'handle' = 'fader') <> 46 then
    raise exception 'the faders board on an inverted take: %', j;
  end if;
  perform set_config('request.headers', '{}', true);
  reset role;
  raise notice 'chain_scores: all checks passed';
end $$;
rollback;
