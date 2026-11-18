-- Checks that search_securities (migrations/*_search_speed.sql) answers exactly as before: the
-- same rows in the same order as 0044_prediction_expiry's version, kept here as the reference.
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/search_securities.sql
-- Each check raises if it fails.
begin;

-- 0044_prediction_expiry's search_securities, unchanged.
create function pg_temp.search_securities_0044(p_query text, p_us_person boolean default true, p_limit int default 20)
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
  limit least(greatest(p_limit, 1), 50)
$$;

-- A small catalog covering every way to score, and every row the filters leave out. Volumes
-- differ, so no two rows tie and the order is fixed.
delete from public.securities;
insert into public.securities (id, kind, symbol, name, underlying, venue, themes, liquidity, us_persons, expires_at, data) values
  ('t:nvdax',  'stock',      'NVDAx',  'NVIDIA xStock',                       'NVDA', 'Jupiter', '{ai chips,semiconductors}', 'tradeable', 'no',      null, '{"volume24hUsd": 1000}'),
  ('t:nvdaon', 'stock',      'NVDAon', 'NVIDIA (Ondo Tokenized)',             'NVDA', 'Jupiter', '{ai chips}',                'tradeable', 'no',      null, '{"volume24hUsd": 900}'),
  ('t:nvdap',  'perp',       'NVDA',   'NVIDIA perp',                         'NVDA', 'Phoenix', '{}',                        'tradeable', 'yes',     null, '{"volumeUsd": 800}'),
  ('t:be',     'stock',      'BEx',    'Bloom Energy - Backpack Securities',  'BE',   'Jupiter', '{fuel cells,clean energy}', 'tradeable', 'no',      null, '{"volume24hUsd": 500}'),
  ('t:dnut',   'stock',      'DNUTx',  'Krispy Kreme, Inc. Common Stock',     'DNUT', 'Jupiter', '{consumer}',                'tradeable', 'unknown', null, '{"volume24hUsd": 300}'),
  ('t:gold',   'commodity',  'XAUt',   'Tether Gold',                         null,   'Jupiter', '{gold,precious metals}',    'tradeable', 'yes',     null, '{"volume24hUsd": 2000}'),
  ('t:amd',    'stock',      'AMDx',   'AMD xStock',                          'AMD',  'Jupiter', '{ai chips}',                'thin',      'no',      null, '{"volume24hUsd": 5000}'),
  ('t:fed',    'prediction', 'FEDDEC', 'Fed cuts rates in December',          null,   'Gemini',  '{rates,fed}',               'tradeable', 'yes',     now() + interval '30 days', '{"volumeUsd": 700}'),
  ('t:fedold', 'prediction', 'FEDOLD', 'Old Fed market',                      null,   'Gemini',  '{rates}',                   'tradeable', 'yes',     null, '{"volumeUsd": 650}'),
  ('t:fedgone','prediction', 'FEDNOV', 'Fed cuts rates in November',          null,   'Gemini',  '{rates}',                   'tradeable', 'yes',     now() - interval '1 day', '{"volumeUsd": 640}'),
  ('t:kamino', 'yield',      'USDC',   'USDC Vault',                          null,   'Kamino',  '{cash yield}',              'tradeable', 'yes',     null, '{"tvlUsd": 9000}'),
  ('t:jl',     'yield',      'jlUSDC', 'Jupiter Lend USDC',                   null,   'Jupiter Lend Earn', '{cash yield}',    'tradeable', 'yes',     null, '{"volume24hUsd": 600}'),
  ('t:weird',  'stock',      'W_1',    'a\b 100% _test Inc.',                 null,   'Jupiter', '{ai power,grid}',           'tradeable', 'unknown', null, '{"volume24hUsd": 50}'),
  ('t:other',  'other',      'SOL',    'Solana',                              null,   'Jupiter', '{ai}',                      'tradeable', 'yes',     null, '{"volume24hUsd": 99999}'),
  ('t:spy',    'etf',        'SPYx',   'SPDR S&P 500 ETF xStock',             'SPY',  'Jupiter', '{index}',                   'tradeable', 'no',      null, '{"volume24hUsd": 1500}'),
  ('t:tqqq',   'leveraged',  'TQQQx',  'ProShares UltraPro QQQ',              'TQQQ', 'Jupiter', '{nasdaq,ai}',               'tradeable', 'no',      null, '{"volume24hUsd": 100}'),
  ('t:pre',    'pre-ipo',    'OPENAI', 'OpenAI PreStocks',                    'OPENAI', 'Jupiter', '{ai labs}',               'tradeable', 'unknown', null, '{"volume24hUsd": 400}');

do $$
declare
  q text;
  us boolean;
  lim int;
  got jsonb;
  want jsonb;
  checked int := 0;
begin
  if exists (select 1 from public.securities where display_name is distinct from public.asset_display_name(name)) then
    raise exception 'display_name must be asset_display_name(name)';
  end if;

  foreach q in array array[
    '', '   ', 'nvda', 'NVDA', 'nvdax', 'nvidia', '  Nvidia  ', 'nv', 'n', 'ai', 'ai chips', 'chip', 'chips', 'energy',
    'bloom energy', 'bloom', 'gold', 'x', 'fed', 'rates', 'usdc', 'jlusdc', '%', '_', 'a\b', 'a\b 100% _test',
    '100%', 'kreme', 'krispy kreme', 'ai power', 'power', 's&p', 'spy', 'qqq', 'openai', 'zzz', 'dnut', 'solana'
  ] loop
    foreach us in array array[true, false] loop
      foreach lim in array array[1, 3, 20, 50] loop
        select coalesce(jsonb_agg(to_jsonb(r) - 'ordinality' order by r.ordinality), '[]')
          into got from public.search_securities(q, us, lim) with ordinality r;
        select coalesce(jsonb_agg(to_jsonb(r) - 'ordinality' order by r.ordinality), '[]')
          into want from pg_temp.search_securities_0044(q, us, lim) with ordinality r;
        if got is distinct from want then
          raise exception 'search_securities(%, %, %) differs: got % want %', quote_literal(q), us, lim, got, want;
        end if;
        checked := checked + 1;
      end loop;
    end loop;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into got from public.search_securities(null) r;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into want from pg_temp.search_securities_0044(null) r;
  if got is distinct from want then raise exception 'search_securities(null) differs'; end if;

  -- And it finds things: a ticker first, a theme, a name inside.
  if (select r.id from public.search_securities('nvda', true, 5) r limit 1) <> 't:nvdap' then
    raise exception 'nvda for a US person: the perp is the one row of NVDA they can buy';
  end if;
  if (select r.id from public.search_securities('nvda', false, 5) r limit 1) <> 't:nvdax' then
    raise exception 'nvda: the most traded token first';
  end if;
  if not exists (select 1 from public.search_securities('fuel cells') r where r.id = 't:be') then raise exception 'theme search'; end if;
  if not exists (select 1 from public.search_securities('kreme') r where r.id = 't:dnut') then raise exception 'name search'; end if;
  if exists (select 1 from public.search_securities('') r where r.id in ('t:amd', 't:fedold', 't:fedgone', 't:kamino', 't:other')) then
    raise exception 'rows the filters leave out showed up';
  end if;

  raise notice 'search_securities: % searches match the previous version', checked;
end $$;
rollback;
