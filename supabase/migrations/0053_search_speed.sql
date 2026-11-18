-- Faster ticker/name search, and indexes for the score reads. Same results.
--
-- search_securities (the take builder's ticker and name search) averaged 2.7 s: it ran
-- asset_display_name (five regular expressions) twice on each of the ~22,000 tradeable rows, and
-- matched names with LIKE '%…%' on every row.
--
--   indexes             on asset_display_name(name) (btree and trigram), lower(name) and the themes
--                       (trigram), and the tickers, tradeable rows only, so equality and LIKE
--                       '%…%' are answered by an index. Expression indexes, not a stored column:
--                       adding a column would rewrite the whole table under an exclusive lock.
--                       Building them blocks writes to securities for a few seconds, not reads.
--   search_securities   same results and order as 0044_prediction_expiry: candidates come through
--                       the indexes first (every row that could score above 0), and only they are
--                       scored, exactly as before.
--   chain_events (network, name, block_time)   chain_wallet_stats reads takeSettled by network
--                                              on every leaderboard call (it scanned the table).
--   chain_positions (network, take), settled   "made for backers" joins settled positions by take;
--                                              the only such index covered open ones.

create extension if not exists pg_trgm with schema extensions;

-- The themes as one lowercased string, for a trigram index. Searched as a first filter only: the
-- score still checks each theme on its own.
create function public.securities_themes_text(p_themes text[]) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select lower(pg_catalog.array_to_string(p_themes, E'\n'))
$$;

-- search_securities runs as its caller, and callers include the publishable key (the executor's
-- dogfood script), so the helper is callable like asset_display_name (0023). It's pure.
revoke execute on function public.securities_themes_text(text[]) from public;
grant execute on function public.securities_themes_text(text[]) to anon, authenticated, service_role;

-- asset_display_name is immutable (0023_assets), as an expression index needs.
create index securities_tradeable on public.securities (kind) where liquidity = 'tradeable';
create index securities_tradeable_symbol on public.securities (lower(symbol)) where liquidity = 'tradeable';
create index securities_tradeable_underlying on public.securities (lower(underlying)) where liquidity = 'tradeable';
create index securities_tradeable_display on public.securities (public.asset_display_name(name)) where liquidity = 'tradeable';
create index securities_tradeable_display_trgm on public.securities
  using gin (public.asset_display_name(name) extensions.gin_trgm_ops) where liquidity = 'tradeable';
create index securities_tradeable_name_trgm on public.securities
  using gin (lower(name) extensions.gin_trgm_ops) where liquidity = 'tradeable';
create index securities_tradeable_themes_trgm on public.securities
  using gin (public.securities_themes_text(themes) extensions.gin_trgm_ops) where liquidity = 'tradeable';

-- Same signature, columns and scoring as 0044_prediction_expiry. Every way to score above 0 has
-- its own candidate query, each answered by one of the indexes above:
--   100  ticker or underlying, exactly       lower(symbol), lower(underlying)
--   95   display name, exactly               asset_display_name(name)
--   80   display name starts with it         asset_display_name(name) (trigram)
--   60   a word in the name starts with it   lower(name) (trigram): the name contains it
--   40   the name contains it                lower(name) (trigram)
--   30   a theme contains it                 themes (trigram), then each theme checked
-- An empty search lists every tradeable row, as before.
create or replace function public.search_securities(p_query text, p_us_person boolean default true, p_limit int default 20)
returns table (
  id text, kind text, symbol text, name text, underlying text, issuer text, venue text, mint text,
  themes text[], description text, liquidity text, us_persons text, can_short boolean,
  expires_at timestamptz, data jsonb, score int
)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  q text := lower(trim(coalesce(p_query, '')));
begin
  return query
  with cand as (
    select s.id from public.securities s where s.liquidity = 'tradeable' and q = ''
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and lower(s.symbol) = q
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and lower(s.symbol) = q || 'x'
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and lower(s.underlying) = q
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and public.asset_display_name(s.name) = q
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and public.asset_display_name(s.name) like q || '%'
    union
    select s.id from public.securities s where s.liquidity = 'tradeable' and q <> '' and lower(s.name) like '%' || q || '%'
    union
    select s.id from public.securities s
    where s.liquidity = 'tradeable' and length(q) >= 3 and public.securities_themes_text(s.themes) like '%' || q || '%'
  ),
  scored as (
    select s.*,
      case
        when q = '' then 1
        when lower(s.symbol) = q or lower(s.underlying) = q or lower(s.symbol) = q || 'x' then 100
        when public.asset_display_name(s.name) = q then 95
        when public.asset_display_name(s.name) like q || '%' then 80
        when ' ' || lower(s.name) like '% ' || q || '%' then 60
        when length(q) >= 3 and lower(s.name) like '%' || q || '%' then 40
        when length(q) >= 3 and exists (select 1 from unnest(s.themes) th where lower(th) like '%' || q || '%') then 30
        else 0
      end as score,
      coalesce((s.data ->> 'volume24hUsd')::double precision, (s.data ->> 'volumeUsd')::double precision, 0) as volume
    from cand c
    join public.securities s on s.id = c.id
    where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp', 'prediction')
      and s.liquidity = 'tradeable'
      and (s.kind <> 'yield' or s.venue = 'Jupiter Lend Earn')
      and (s.expires_at > now() or (s.expires_at is null and s.kind <> 'prediction'))
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
  limit least(greatest(p_limit, 1), 50);
end;
$$;

create index chain_events_name on public.chain_events (network, name, block_time);
create index chain_positions_settled_take on public.chain_positions (network, take) where settled_at is not null;
