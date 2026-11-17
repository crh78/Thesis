-- Live marks: what moves a take's return, and every position on it, between posting and settling.
--
-- Until now nothing wrote take_stats.ret_pct / history or take_legs.ret_pct, and take_price()
-- (0018_positions_and_selling.sql) is 1 + ret_pct / 100, so paper positions and sales
-- were frozen at what was paid. The marker (apps/executor/src/marker.ts) now prices every pick of
-- every open take every few minutes with the settler's own rules and posts the result through the
-- `marks` edge function, which calls apply_marks() below.
--
-- A take's return is an index since it was posted: each pick has a base price,
-- fixed once, and a mark, updated each run. A pick's return uses the program's own per-leg formula
-- as a back (positionReturnBps in @thesis/chain: spot and perp legs move by leverage × the price
-- move, a prediction by mark / base − 1, no leg below −100%); the take's return is the
-- weight-weighted average over the picks that can be priced (cards until they have a price source, and picks with no catalog row
-- are left out, as a position leaves out legs it couldn't buy). A take settled on chain keeps its
-- signed result (take_json already prefers chain_takes.result_bps).
--
--   take_legs.base_price   USD per unit of the underlying (one share, one ounce, one contract
--                          side), in the terms the pick is marked in. Set once, never moved.
--   take_legs.base_at      when the base price was published (the posting, or the first trade
--                          at or after it for older takes, backfilled).
--   take_legs.base_source  what priced the base: { rule, source, ... } (token mint and its
--                          ScaledUiAmount multiplier, the stock trade, the Phoenix bar, the Gemini
--                          contract), so a mark can be checked and later marks use the same basis.
--   take_legs.mark_price / marked_at   the latest mark, in the base's terms.
--   take_stats.history_at  when history last got a new point (it gets at most one an hour; the
--                          latest point is overwritten in between).
--   chain_positions.live_return_bps / live_marked_at   an open on-chain position's return right
--                          now: the program's formula on the entry prices the settler signed for
--                          it and the live marks as exits. The settled return stays in return_bps.

alter table public.take_legs
  add column base_price  double precision,
  add column base_at     timestamptz,
  add column base_source jsonb,
  add column mark_price  double precision,
  add column marked_at   timestamptz,
  add constraint take_legs_base_price check (base_price is null or base_price > 0),
  add constraint take_legs_mark_price check (mark_price is null or mark_price >= 0);

alter table public.take_stats
  add column history_at timestamptz;

alter table public.chain_positions
  add column live_return_bps bigint,
  add column live_marked_at  timestamptz;

-- Applies one marker run. p:
--   { "legs":      [{ "take_id", "idx", "mark_price", "marked_at", "ret_pct",
--                     "base_price"?, "base_at"?, "base_source"? }],
--     "takes":     [{ "take_id", "ret_pct" }],
--     "positions": [{ "network", "address", "live_return_bps" }],
--     "history_every_secs": 3600 (optional), "history_max": 240 (optional) }
-- A base is written only where the leg has none (set once). Takes past settles_at, or settled on
-- chain, aren't touched. Returns how many rows each part changed.
create function public.apply_marks(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  every_secs int := coalesce((p ->> 'history_every_secs')::int, 3600);
  keep int := least(greatest(coalesce((p ->> 'history_max')::int, 240), 2), 1000);
  n_legs int := 0;
  n_takes int := 0;
  n_positions int := 0;
begin
  if jsonb_typeof(coalesce(p -> 'legs', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p -> 'takes', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p -> 'positions', '[]')) <> 'array' then
    raise exception 'legs, takes and positions must be arrays' using errcode = '22023';
  end if;

  with x as (
    select (e ->> 'take_id')::uuid as take_id,
           (e ->> 'idx')::smallint as idx,
           (e ->> 'mark_price')::double precision as mark_price,
           coalesce((e ->> 'marked_at')::timestamptz, now()) as marked_at,
           (e ->> 'ret_pct')::numeric as ret_pct,
           (e ->> 'base_price')::double precision as base_price,
           (e ->> 'base_at')::timestamptz as base_at,
           e -> 'base_source' as base_source
    from jsonb_array_elements(coalesce(p -> 'legs', '[]')) e
  )
  update public.take_legs l
  set mark_price  = x.mark_price,
      marked_at   = x.marked_at,
      ret_pct     = round(greatest(x.ret_pct, -100), 4),
      base_price  = coalesce(l.base_price, x.base_price),
      base_at     = case when l.base_price is null then x.base_at else l.base_at end,
      base_source = case when l.base_price is null then x.base_source else l.base_source end
  from x
  join public.takes t on t.id = x.take_id
  where l.take_id = x.take_id and l.idx = x.idx
    and x.mark_price is not null and x.ret_pct is not null
    and (l.base_price is not null or x.base_price is not null)
    and t.settles_at > now()
    and not exists (select 1 from public.chain_takes c where c.take_id = t.id and c.settled);
  get diagnostics n_legs = row_count;

  with x as (
    select (e ->> 'take_id')::uuid as take_id, round(greatest((e ->> 'ret_pct')::numeric, -100), 4) as ret_pct
    from jsonb_array_elements(coalesce(p -> 'takes', '[]')) e
    where e ->> 'ret_pct' is not null
  )
  update public.take_stats s
  set ret_pct = x.ret_pct,
      history = case
        -- Within the hour: move the latest point. Otherwise add one, keeping the last `keep`.
        when s.history_at is not null and now() - s.history_at < make_interval(secs => every_secs) and cardinality(s.history) >= 2
          then s.history[1:cardinality(s.history) - 1] || x.ret_pct
        else (case when s.history_at is null then array[0::numeric(9, 4)] else s.history end || x.ret_pct)
             [greatest(1, cardinality(case when s.history_at is null then array[0::numeric(9, 4)] else s.history end) + 2 - keep):]
      end,
      history_at = case
        when s.history_at is not null and now() - s.history_at < make_interval(secs => every_secs) and cardinality(s.history) >= 2
          then s.history_at
        else now()
      end
  from x
  join public.takes t on t.id = x.take_id
  where s.take_id = x.take_id
    and t.settles_at > now()
    and not exists (select 1 from public.chain_takes c where c.take_id = t.id and c.settled);
  get diagnostics n_takes = row_count;

  with x as (
    select e ->> 'network' as network, e ->> 'address' as address, (e ->> 'live_return_bps')::bigint as bps
    from jsonb_array_elements(coalesce(p -> 'positions', '[]')) e
    where e ->> 'live_return_bps' is not null
  )
  update public.chain_positions cp
  set live_return_bps = greatest(x.bps, -10000),
      live_marked_at  = now()
  from x
  where cp.network = x.network and cp.address = x.address and cp.settled_at is null;
  get diagnostics n_positions = row_count;

  return jsonb_build_object('legs', n_legs, 'takes', n_takes, 'positions', n_positions);
end;
$$;

revoke execute on function public.apply_marks(jsonb) from public, anon, authenticated;
grant execute on function public.apply_marks(jsonb) to service_role;
