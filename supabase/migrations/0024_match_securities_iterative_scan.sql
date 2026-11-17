-- match_securities with pgvector's iterative index scan.
--
-- The HNSW index returns the nearest `hnsw.ef_search` rows (40 by default) and only then applies
-- the WHERE clause. With thousands of Gemini prediction contracts in the catalog,
-- those 40 were nearly always contracts, so a search filtered to other kinds (or to US-available
-- rows) came back empty, and the take builder answered "no clean exposure" for every take.
-- An iterative scan keeps reading the index until enough rows pass the filter (pgvector 0.8+).
-- relaxed_order can return rows slightly out of order, so the outer query sorts them again.

-- Load pgvector's library in this session first, so its hnsw.* settings exist and can be attached
-- to the function (otherwise: "permission denied to set parameter").
select '[1]'::extensions.vector;

create or replace function public.match_securities(
  p_embedding extensions.vector(384),
  p_count int default 12,
  p_kinds text[] default null,
  p_us_person boolean default false,
  p_min_liquidity text default 'thin'
) returns table (
  id text, kind text, symbol text, name text, underlying text, issuer text, venue text,
  themes text[], description text, liquidity text, us_persons text, can_short boolean,
  expires_at timestamptz, data jsonb, similarity double precision
)
language sql stable
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
set hnsw.ef_search = 100
as $$
  with hits as materialized (
    select s.id, s.kind, s.symbol, s.name, s.underlying, s.issuer, s.venue,
           s.themes, s.description, s.liquidity, s.us_persons, s.can_short,
           s.expires_at, s.data,
           s.embedding operator(extensions.<=>) p_embedding as distance
    from public.securities s
    where s.embedding is not null
      and (p_kinds is null or s.kind = any (p_kinds))
      and (not p_us_person or s.us_persons <> 'no')
      and (p_min_liquidity = 'thin' or s.liquidity in ('tradeable', 'n/a'))
      and (s.expires_at is null or s.expires_at > now())
    order by s.embedding operator(extensions.<=>) p_embedding
    limit least(greatest(p_count, 1), 80)
  )
  select id, kind, symbol, name, underlying, issuer, venue, themes, description, liquidity,
         us_persons, can_short, expires_at, data, 1 - distance as similarity
  from hits
  order by distance
$$;
