-- basket_catalog() scans ~17,000 rows (~1.5 s on this database). Every new take-builder worker
-- called it, so a burst of builds started several workers that all scanned at once, hit the
-- statement timeout, and slowed every other query with them. Now the snapshot is built once
-- every five minutes by pg_cron into a one-row table, and basket_catalog() returns that row (a
-- single read), falling back to the live scan only when the snapshot is missing or old.
-- Rows that expire within the five minutes are fine: the builder drops anything resolving within
-- an hour when it searches.

create table if not exists public.basket_catalog_cache (
  id       int primary key default 1 check (id = 1),
  built_at timestamptz not null,
  body     jsonb not null
);
alter table public.basket_catalog_cache enable row level security;
revoke all on public.basket_catalog_cache from anon, authenticated;

-- The live scan, as basket_catalog() was.
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
    and (s.expires_at is null or s.expires_at > now() + interval '1 hour')
$$;

create or replace function public.refresh_basket_catalog() returns void
language sql
set search_path = ''
as $$
  insert into public.basket_catalog_cache (id, built_at, body)
  select 1, now(), public.basket_catalog_live()
  on conflict (id) do update set built_at = excluded.built_at, body = excluded.body
$$;

create or replace function public.basket_catalog() returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select c.body from public.basket_catalog_cache c where c.id = 1 and c.built_at > now() - interval '30 minutes'),
    public.basket_catalog_live()
  )
$$;

revoke execute on function public.basket_catalog_live() from public, anon, authenticated;
revoke execute on function public.refresh_basket_catalog() from public, anon, authenticated;
revoke execute on function public.basket_catalog() from public, anon, authenticated;
grant execute on function public.basket_catalog() to service_role;

select public.refresh_basket_catalog();
select cron.schedule('refresh-basket-catalog', '*/5 * * * *', 'select public.refresh_basket_catalog()');
