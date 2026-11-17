-- Every yield pick is traded as a Jupiter Lend jlUSDC deposit (scripts/fork/api/legs.ts YIELD_KEY),
-- so search and the take builder offer only that row: a Kamino vault at ~7.5% APY promised a rate
-- the deposit never earns. Same functions as 0036_asset_search (search_assets) and
-- 0037_basket_catalog_cache (basket_catalog_live), plus that one condition.
-- (0040_catalog_fixes adds the same rule to search_securities.)

create or replace function public.search_assets(p_query text, p_us_person boolean default true, p_limit integer default 20)
returns table(id text, kind text, symbol text, name text, underlying text, issuer text, venue text, mint text, themes text[], description text,
              liquidity text, us_persons text, can_short boolean, expires_at timestamptz, data jsonb, score real)
language sql stable
set search_path = ''
as $$
  with q as (select lower(trim(coalesce(p_query, ''))) as raw, trim(public.search_rewrite(p_query)) as q),
  w as (
    select q.raw, q.q, coalesce(array(select distinct t from regexp_split_to_table(regexp_replace(q.q, '[^a-z0-9 ]+', ' ', 'g'), '\s+') t
                                      where t <> ''), '{}') as words
    from q
  ),
  x as (
    select w.*, cardinality(w.words) as n,
      w.words || coalesce(array(select a from unnest(w.words) y, unnest(public.search_aliases(y)) a), '{}') as terms,
      w.words[cardinality(w.words)] as last
    from w
  ),
  tq as (
    select x.*,
      -- Whole words (and their aliases), any of them.
      case when x.n = 0 then null else to_tsquery('pg_catalog.english', array_to_string(x.terms, ' | ')) end as exact_q,
      -- The word being typed (the last, 3+ letters) also as a prefix: "nvi" → NVIDIA.
      case when x.n = 0 then null else to_tsquery('pg_catalog.english', array_to_string(x.terms
        || case when length(x.last) >= 3 then array[x.last || ':*'] else '{}'::text[] end, ' | ')) end as any_q
    from x
  ),
  -- Candidates through indexes: full-text matches (GIN), plus tickers and names among the
  -- ~1,300 rows that aren't prediction markets (by kind), so nothing scans all 86,000.
  cand as (
    select s.id from public.securities s, tq where tq.raw <> '' and s.search_doc @@ tq.any_q
    union
    select s.id from public.securities s, tq
    where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp')
      and (tq.raw = '' or lower(s.symbol) = tq.raw or lower(s.underlying) = tq.raw or lower(s.symbol) = tq.raw || 'x'
           or public.asset_display_name(s.name) like tq.raw || '%')
  ),
  scored as (
    select s.*,
      case
        when tq.raw = '' then 1
        when lower(s.symbol) = tq.raw or lower(s.underlying) = tq.raw or lower(s.symbol) = tq.raw || 'x' then 1000
        when public.asset_display_name(s.name) = tq.raw then 900
        when s.kind <> 'prediction' and public.asset_display_name(s.name) like tq.raw || '%' then 800
        when s.kind = 'prediction' then
          -- A prediction's title has to carry the search, word for word (stems would let
          -- "housing" find "House winner"): every word or an alias of it, or all but one of three
          -- or more you typed yourself ("super bowl" → "pro football champion" needs all three).
          case when (select count(*) from unnest(tq.words) y
                     where lower(s.name) ~ ('\m(' || array_to_string(array[y] || public.search_aliases(y), '|') || ')\M'))
                    >= greatest(1, tq.n - case when tq.n >= 3 and tq.q = tq.raw then 1 else 0 end)
               then 40 * ts_rank('{0.1, 0.2, 0.4, 1.0}', s.search_doc, tq.any_q) else 0 end
        -- Perps (leveraged) a step behind spot for a general search: "chip makers" leads with the
        -- chip stocks, and the perps follow.
        else 100 * (ts_rank('{0.1, 0.2, 0.4, 1.0}', s.search_doc, tq.exact_q)
                    + 0.3 * ts_rank('{0.1, 0.2, 0.4, 1.0}', s.search_doc, tq.any_q))
             * case when s.kind = 'perp' then 0.6 else 1 end
      end::real as score,
      coalesce((s.data ->> 'volume24hUsd')::double precision, (s.data ->> 'volumeUsd')::double precision, 0) as volume
    from cand c join public.securities s on s.id = c.id, tq
    where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp', 'prediction')
      and s.liquidity = 'tradeable'
      and (s.kind <> 'yield' or s.venue = 'Jupiter Lend Earn')
      and (s.expires_at is null or s.expires_at > now())
  ),
  best as (
    -- One per company or market, and one contract per prediction event.
    select distinct on (coalesce(sc.underlying, sc.data ->> 'eventTicker', sc.id)) sc.*
    from scored sc
    where sc.score > 0
    order by coalesce(sc.underlying, sc.data ->> 'eventTicker', sc.id), (p_us_person and sc.us_persons = 'no') asc,
             (sc.kind = 'perp') asc, sc.score desc, sc.volume desc
  )
  select b.id, b.kind, b.symbol, b.name, b.underlying, b.issuer, b.venue, b.mint, b.themes, b.description,
         b.liquidity, b.us_persons, b.can_short, b.expires_at, b.data, b.score
  from best b
  order by (b.score >= 900) desc,
           (p_us_person and b.us_persons = 'no') asc,
           b.score desc,
           (b.kind = 'perp') asc,
           (b.kind in ('stock', 'etf', 'commodity')) desc,
           b.volume desc
  limit least(greatest(p_limit, 1), 50)
$$;

create or replace function public.basket_catalog_live() returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
    s.id, s.kind, s.symbol, s.name, s.underlying, s.themes,
    s.data ->> 'eventTitle', s.data ->> 'label', s.expires_at, s.us_persons,
    (s.data ->> 'maxLeverage')::double precision, (s.data ->> 'apyPct')::double precision,
    coalesce((s.data ->> 'tvlUsd')::double precision, (s.data ->> 'volume24hUsd')::double precision,
             (s.data ->> 'volumeUsd')::double precision, 0),
    s.data ->> 'category'
  )), '[]'::jsonb)
  from public.securities s
  where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp', 'prediction')
    and s.liquidity = 'tradeable'
    and (s.kind <> 'yield' or s.venue = 'Jupiter Lend Earn')
    and (s.expires_at is null or s.expires_at > now() + interval '1 hour')
$$;

revoke execute on function public.search_assets(text, boolean, integer) from anon, authenticated;
grant execute on function public.search_assets(text, boolean, integer) to service_role;

select public.refresh_basket_catalog();
