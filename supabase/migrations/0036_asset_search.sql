-- Asset search that's fast and answers general searches.
--
-- Search ("Add a pick", the Search tab) took 1-3 s: a LIKE scan of all ~86,000 securities, then
-- for anything that wasn't a ticker an embedding and a vector search, then prices. And general
-- words matched names by accident ("ai" → "Air Force vs Pacific", "gold" → Golden State games).
--
--   securities.search_doc   full-text document, weighted: ticker and name (A), themes (B, the
--                           catalog's "ai chips", "us housing market"…), description (C). GIN index.
--   search_assets(q, …)     one query: exact tickers and names first, then full-text rank. Words
--                           of three letters or more match as prefixes, so results come while you
--                           type ("nvi" → NVIDIA). Prediction markets need most of the words to
--                           match, so a word like "gold" lists gold, not every Golden State game.
--                           No embeddings, in line with the take builder dropping them.

create function public.securities_search_doc(
  p_symbol text, p_underlying text, p_name text, p_themes text[], p_description text
) returns tsvector
language sql immutable parallel safe
set search_path = ''
as $$
  select setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(p_symbol, '') || ' ' || coalesce(p_underlying, '')), 'A')
      || setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(p_name, '')), 'A')
      || setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(pg_catalog.array_to_string(p_themes, ' '), '')), 'B')
      || setweight(to_tsvector('pg_catalog.english'::regconfig, left(coalesce(p_description, ''), 600)), 'C')
$$;

alter table public.securities
  add column search_doc tsvector generated always as
    (public.securities_search_doc(symbol, underlying, name, themes, description)) stored;

create index securities_search_doc on public.securities using gin (search_doc);

-- What people type → what the catalog says. Gemini titles the Super Bowl "Pro Football Champion"
-- and Bitcoin markets "BTC price…" (the take builder's bm25.ts has the same idea).
create function public.search_rewrite(p_query text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(p_query, '')),
    '\m(super ?bowl|nfl)\M', 'pro football champion', 'g'),
    '\m(nba finals|nba)\M', 'pro basketball champion', 'g'),
    '\m(world series|mlb)\M', 'pro baseball champion', 'g'),
    '\m(stanley cup|nhl)\M', 'pro hockey champion', 'g'),
    '\m(rate cuts?|rate hikes?|cuts? rates|raises? rates|fomc|interest rates?)\M', 'fed decision', 'g'),
    '\m(s ?& ?p|s and p)( ?500)?\M', 'sp 500', 'g')
$$;

/** Other names for the same coin, matched alongside what was typed. */
create function public.search_aliases(p_word text) returns text[]
language sql immutable parallel safe
set search_path = ''
as $$
  select case p_word
    when 'bitcoin' then '{btc}'::text[] when 'btc' then '{bitcoin}'
    when 'ethereum' then '{eth}' when 'ether' then '{eth}' when 'eth' then '{ethereum}'
    when 'solana' then '{sol}' when 'sol' then '{solana}'
    when 'ripple' then '{xrp}' when 'dogecoin' then '{doge}'
    else '{}' end
$$;

create function public.search_assets(p_query text, p_us_person boolean default true, p_limit integer default 20)
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

revoke execute on function public.search_assets(text, boolean, integer) from anon, authenticated;
grant execute on function public.search_assets(text, boolean, integer) to service_role;
