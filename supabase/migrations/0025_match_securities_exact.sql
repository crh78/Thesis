-- match_securities with an exact scan instead of the HNSW index.
--
-- The iterative scan (0024) fixed searches filtered to other kinds, but the prediction
-- search still missed the contracts that fit. About 8,400 of the ~9,500 embedded rows are
-- near-identical sports contracts, and the HNSW graph search gets stuck among them: for "The Fed
-- cuts rates again before spring." it returned NFL quarter lines at 0.82 similarity while the
-- December Fed contracts score 0.88 (found only at ef_search 400). An exact scan over this many
-- 384-dim rows takes ~50 ms for the prediction kind and ~2 ms for the rest,
-- so the search is exact. Adding 0 to the distance keeps the planner off the HNSW index; it still
-- uses the kind index to narrow the rows. Revisit (bigger ef_search, or an index per kind) if the
-- catalog grows past where a scan is cheap.

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
as $$
  select s.id, s.kind, s.symbol, s.name, s.underlying, s.issuer, s.venue,
         s.themes, s.description, s.liquidity, s.us_persons, s.can_short,
         s.expires_at, s.data,
         1 - (s.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.securities s
  where s.embedding is not null
    and (p_kinds is null or s.kind = any (p_kinds))
    and (not p_us_person or s.us_persons <> 'no')
    and (p_min_liquidity = 'thin' or s.liquidity in ('tradeable', 'n/a'))
    and (s.expires_at is null or s.expires_at > now())
  order by (s.embedding operator(extensions.<=>) p_embedding) + 0
  limit least(greatest(p_count, 1), 80)
$$;
