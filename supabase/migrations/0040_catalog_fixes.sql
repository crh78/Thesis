-- Picks with no catalog row get one where the match is unambiguous (10 legs,
-- all on the demo takes 00000000-…). Without asset_id a pick has no asset page and the asset's
-- page doesn't list the take.
--
--   "Cash" / Earns interest  → the Jupiter Lend USDC row: every yield pick is traded as a jlUSDC
--                              deposit (scripts/fork/api/legs.ts), so there is now one vault behind
--                              the word (0023_assets left these unmatched before that).
--   a stock-like name        → the one underlying whose display name starts with it, letters and
--                              digits only ("S&P 500" → "SP500 xStock" → SPY; "Micron" → MU), its
--                              most traded tradeable issuer. More than one underlying: left alone.
--   "<name> 2x"              → that underlying's Phoenix perp, when Phoenix lists one.
--   prediction names         → left alone: the demo picks name no Gemini contract.
-- Previewed read-only: NVIDIA 2x → phoenix:NVDA, Micron → MU (Backpack),
-- S&P 500 → SPYx, two "Cash" picks → the Jupiter Lend row.

with lend as (
  select min(s.id) as id, count(*) as n
  from public.securities s
  where s.kind = 'yield' and s.venue = 'Jupiter Lend Earn' and s.liquidity = 'tradeable'
)
update public.take_legs l
set asset_id = lend.id
from lend
where l.asset_id is null and lend.n = 1 and l.kind ilike '%interest%';

with legs as (
  select l.take_id, l.idx,
         regexp_replace(lower(regexp_replace(l.name, '\s+\d+x$', '', 'i')), '[^a-z0-9]', '', 'g') as norm,
         l.kind ~* '\d+x' as lev
  from public.take_legs l
  where l.asset_id is null and l.kind !~* '^prediction' and l.kind not ilike '%interest%'
),
spot as (
  select s.id, s.underlying, s.liquidity, coalesce((s.data ->> 'volume24hUsd')::double precision, 0) as vol,
         regexp_replace(public.asset_display_name(s.name), '[^a-z0-9]', '', 'g') as norm
  from public.securities s
  where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo') and s.underlying is not null
),
hits as (
  select l.take_id, l.idx, l.lev, min(sp.underlying) as u
  from legs l
  join spot sp on length(l.norm) >= 3 and sp.norm like l.norm || '%'
  group by l.take_id, l.idx, l.lev
  having count(distinct sp.underlying) = 1
),
picked as (
  select h.take_id, h.idx,
         case when h.lev then (select p.id from public.securities p where p.id = 'phoenix:' || h.u and p.kind = 'perp')
              else (select sp.id from spot sp where sp.underlying = h.u order by (sp.liquidity = 'tradeable') desc, sp.vol desc limit 1)
         end as asset_id
  from hits h
)
update public.take_legs l
set asset_id = p.asset_id
from picked p
where l.take_id = p.take_id and l.idx = p.idx and l.asset_id is null and p.asset_id is not null;

-- Add-a-pick search offers only the yield row a pick is actually traded as: every yield pick is a
-- Jupiter Lend jlUSDC deposit (scripts/fork/api/legs.ts YIELD_KEY), so showing Kamino vaults at
-- their ~7.5% APY promised a rate the deposit doesn't earn. Same function as
-- 0023_assets (checked against production), plus that one condition.
create or replace function public.search_securities(p_query text, p_us_person boolean default true, p_limit int default 20)
returns table (
  id text, kind text, symbol text, name text, underlying text, issuer text, venue text, mint text,
  themes text[], description text, liquidity text, us_persons text, can_short boolean,
  expires_at timestamptz, data jsonb, score int
)
language sql stable
set search_path = ''
as $$
  with q as (select lower(trim(coalesce(p_query, ''))) as q),
  scored as (
    select s.*,
      case
        when q.q = '' then 1
        when lower(s.symbol) = q.q or lower(s.underlying) = q.q or lower(s.symbol) = q.q || 'x' then 100
        when public.asset_display_name(s.name) = q.q then 95
        when public.asset_display_name(s.name) like q.q || '%' then 80
        when ' ' || lower(s.name) like '% ' || q.q || '%' then 60
        when length(q.q) >= 3 and lower(s.name) like '%' || q.q || '%' then 40
        when length(q.q) >= 3 and exists (select 1 from unnest(s.themes) th where lower(th) like '%' || q.q || '%') then 30
        else 0
      end as score,
      coalesce((s.data ->> 'volume24hUsd')::double precision, (s.data ->> 'volumeUsd')::double precision, 0) as volume
    from public.securities s, q
    where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp', 'prediction')
      and s.liquidity = 'tradeable'
      and (s.kind <> 'yield' or s.venue = 'Jupiter Lend Earn')
      and (s.expires_at is null or s.expires_at > now())
  ),
  best as (
    select distinct on (coalesce(sc.underlying, sc.id)) sc.*
    from scored sc
    where sc.score > 0
    order by coalesce(sc.underlying, sc.id), (p_us_person and sc.us_persons = 'no') asc, (sc.kind = 'perp') asc, sc.score desc, sc.volume desc
  )
  select b.id, b.kind, b.symbol, b.name, b.underlying, b.issuer, b.venue, b.mint, b.themes, b.description,
         b.liquidity, b.us_persons, b.can_short, b.expires_at, b.data, b.score
  from best b
  order by (b.score >= 95) desc,
           (p_us_person and b.us_persons = 'no') asc,
           (b.kind = 'perp') asc,
           b.score desc,
           (b.kind in ('stock', 'etf', 'commodity')) desc,
           b.volume desc
  limit least(greatest(p_limit, 1), 50)
$$;
