-- The take builder no longer embeds takes. It keeps a BM25 index of the
-- catalog in its worker and lets the model search it with a tool call, so a row needs only its
-- name, tickers and themes (no description, no gte-small embedding).
--
--   basket_catalog()   everything a basket can hold right now, one compact array per row:
--                      [id, kind, symbol, name, underlying, themes, event title, outcome label,
--                       expires_at, us_persons, maxLeverage, apyPct, depth, category]
--                      depth: TVL for cash, else 24h (or total) volume; breaks search ties.

create function public.basket_catalog() returns jsonb
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
    and (s.expires_at is null or s.expires_at > now() + interval '1 hour')
$$;

revoke execute on function public.basket_catalog() from public, anon, authenticated;
grant execute on function public.basket_catalog() to service_role;
