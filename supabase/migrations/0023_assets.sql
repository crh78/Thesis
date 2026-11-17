-- Assets: search, asset pages, and which takes hold what.
--
--   take_legs.asset_id   the catalog row (public.securities) a pick came from, so an asset page
--                        can list the takes that hold it. New takes send it; older ones are
--                        matched by name below where that's unambiguous.
--   search_securities    ticker / name / theme search over what you can actually buy
--   asset_takes          takes holding an asset (any issuer of the same stock counts)
--   search_people        people by handle or name (public profile data only)
--   asset_charts         cached price history per asset and range (GeckoTerminal), so a page
--                        view doesn't hit the provider every time
--   asset_pools          the pool each token's history is read from

-- Picks point at the catalog -------------------------------------------------------------------

alter table public.take_legs
  add column asset_id text references public.securities (id) on delete set null;

create index take_legs_asset_idx on public.take_legs (asset_id) where asset_id is not null;

-- "NVIDIA xStock" → "nvidia", "Bloom Energy - Backpack Securities" → "bloom energy": the name the
-- app shows for a pick (BuiltLegDTO.displayName in the iOS app), lowercased.
create function public.asset_display_name(p_name text) returns text
language sql immutable
set search_path = ''
as $$
  select lower(trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(p_name, '\s+-\s+Backpack Securities$', ''),
            ',?\s+(Inc\.|Corporation|Corp\.|N\.V\.|Limited|Ltd\.)(\s+Common Stock)?$', ''),
          '\s+(PreStocks|Common Stock)$', ''),
        '\s+(xStock|Tokenized Stock|Tokenized|rStock)\y.*$', ''),
      '\s*\((Ondo|Backpack|Tokenized)[^)]*\)$', '')
  ))
$$;

-- Older picks: match by the shown name, preferring a tradeable issuer with the most volume.
-- Yield picks show as "Cash" and stay unmatched (there's no one vault behind the word).
update public.take_legs l
set asset_id = m.id
from (
  select distinct on (public.asset_display_name(s.name)) public.asset_display_name(s.name) as shown, s.id
  from public.securities s
  where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'prediction')
  order by public.asset_display_name(s.name),
           (s.liquidity = 'tradeable') desc,
           coalesce((s.data ->> 'volume24hUsd')::double precision, 0) desc
) m
where l.asset_id is null and lower(trim(l.name)) = m.shown;

-- Then by ticker ("AMD"), the same way.
update public.take_legs l
set asset_id = m.id
from (
  select distinct on (s.underlying) s.underlying, s.id
  from public.securities s
  where s.kind in ('stock', 'etf', 'commodity', 'pre-ipo') and s.underlying is not null
  order by s.underlying, (s.liquidity = 'tradeable') desc,
           coalesce((s.data ->> 'volume24hUsd')::double precision, 0) desc
) m
where l.asset_id is null and upper(trim(l.name)) = m.underlying;

-- Posting saves each pick's asset_id when it's a real catalog row (anything else is dropped,
-- never an error: the pick itself is what counts).
create or replace function public.create_take(
  p_author  uuid,
  p_claim   text,
  p_topic   text,
  p_risk    text,
  p_horizon text,
  p_tags    text[],
  p_legs    jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  tid uuid;
  months int;
  weeks int;
  total numeric;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) not between 1 and 10 then
    raise exception 'legs must be 1 to 10 items' using errcode = '22023';
  end if;

  select sum((leg ->> 'weight')::numeric) into total from jsonb_array_elements(p_legs) leg;
  if total is null or abs(total - 100) > 1 then
    raise exception 'leg weights must add up to 100' using errcode = '22023';
  end if;

  months := nullif(substring(p_horizon from '^([0-9]+)mo$'), '')::int;
  weeks := nullif(substring(p_horizon from '^([0-9]+)wk$'), '')::int;

  insert into public.takes (author_id, claim, topic, risk, horizon, tags, settles_at)
  values (
    p_author, p_claim, p_topic, p_risk, p_horizon, coalesce(p_tags, '{}'),
    now() + coalesce(make_interval(months => months), make_interval(weeks => weeks), interval '1 month')
  )
  returning id into tid;

  insert into public.take_legs (take_id, idx, name, kind, weight, why, slot, fade_how, asset_id)
  select
    tid,
    (ord - 1)::smallint,
    leg ->> 'name',
    leg ->> 'kind',
    (leg ->> 'weight')::numeric,
    coalesce(leg ->> 'why', ''),
    coalesce((leg ->> 'slot')::smallint, (ord - 1)::smallint),
    nullif(leg ->> 'fade_how', ''),
    (select s.id from public.securities s where s.id = leg ->> 'asset_id')
  from jsonb_array_elements(p_legs) with ordinality as l(leg, ord);

  return tid;
end;
$$;

revoke execute on function public.create_take(uuid, text, text, text, text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.create_take(uuid, text, text, text, text, text[], jsonb) to service_role;

-- Same as 0021_chain_events, plus each leg's asset_id.
create or replace function public.take_json(t public.takes) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'claim', t.claim,
    'topic', t.topic,
    'risk', t.risk,
    'horizon', t.horizon,
    'tags', to_jsonb(t.tags),
    'created_at', t.created_at,
    'settles_at', t.settles_at,
    'author', (select public.person_json(p) from public.profiles p where p.id = t.author_id),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', l.name, 'kind', l.kind, 'weight', l.weight, 'why', l.why,
        'slot', l.slot, 'fade_how', l.fade_how, 'ret', l.ret_pct, 'asset_id', l.asset_id
      ) order by l.idx)
      from public.take_legs l where l.take_id = t.id
    ), '[]'::jsonb),
    'ret', case when c.settled then round(c.result_bps / 100.0, 4) else coalesce(s.ret_pct, 0) end,
    'history', coalesce(to_jsonb(s.history), '[0, 0]'::jsonb),
    'backs', coalesce(c.backers, s.backs, 0),
    'fades', coalesce(c.faders, s.fades, 0),
    'money_in', coalesce(c.backed_usd + c.faded_usd, s.money_in, 0),
    'comments', (select count(*) from public.comments cm where cm.take_id = t.id),
    'on_chain', c.address
  )
  from (select 1) as one
  left join public.take_stats s on s.take_id = t.id
  left join lateral (
    select * from public.chain_takes ct
    where ct.take_id = t.id and ct.network = public.request_network()
    order by ct.created_at desc nulls last
    limit 1
  ) c on true
$$;

-- Search --------------------------------------------------------------------------------------

-- What a search may show: things a basket can hold and that are liquid enough to buy and price.
-- Ticker or company first, then words in the name, then themes; one row per company (its most
-- traded tradeable issuer, one US persons can buy when p_us_person and there is one). An empty
-- query lists the most traded. Rows US persons can't buy stay in (us_persons = 'no') so the app
-- can say so instead of pretending the asset doesn't exist.
create function public.search_securities(p_query text, p_us_person boolean default true, p_limit int default 20)
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

-- Takes holding an asset: the same company through any issuer (NVDAx, NVDAon, the NVIDIA perp),
-- or the exact row for things with no underlying (prediction markets). Newest first.
create function public.asset_takes(p_asset text, p_limit int default 20) returns jsonb
language sql stable
set search_path = ''
as $$
  with a as (select s.id, s.underlying from public.securities s where s.id = p_asset)
  select coalesce(jsonb_agg(public.take_json(t) order by t.created_at desc), '[]'::jsonb)
  from (
    select tk.* from public.takes tk
    where exists (
      select 1 from public.take_legs l
      join public.securities s on s.id = l.asset_id
      join a on (a.underlying is not null and s.underlying = a.underlying and s.kind <> 'yield') or s.id = a.id
      where l.take_id = tk.id
    )
    order by tk.created_at desc
    limit least(greatest(p_limit, 1), 50)
  ) t
$$;

-- People by handle or name: handle prefix first, then name words, then anywhere.
create function public.search_people(p_query text, p_limit int default 20) returns jsonb
language sql stable
set search_path = ''
as $$
  with q as (
    select lower(trim(leading '@' from trim(coalesce(p_query, '')))) as q
  ),
  hits as (
    select p.id,
      case
        when lower(p.handle) = q.q then 100
        when lower(p.handle) like q.q || '%' then 80
        when ' ' || lower(p.display_name) like '% ' || q.q || '%' then 60
        else 40
      end as score
    from public.profiles p, q
    where p.handle is not null and q.q <> ''
      and (strpos(lower(p.handle), q.q) > 0 or strpos(lower(coalesce(p.display_name, '')), q.q) > 0)
    order by score desc, p.created_at
    limit least(greatest(p_limit, 1), 50)
  )
  select coalesce(jsonb_agg(public.person_json(p) order by h.score desc, p.created_at), '[]'::jsonb)
  from hits h join public.profiles p on p.id = h.id
$$;

-- Price history cache ----------------------------------------------------------------------------

create table public.asset_charts (
  asset_id   text not null references public.securities (id) on delete cascade,
  range      text not null check (range in ('1D', '1W', '1M', '1Y')),
  points     jsonb not null,          -- [[unix seconds, usd], ...] oldest first
  fetched_at timestamptz not null default now(),
  primary key (asset_id, range)
);

create table public.asset_pools (
  mint       text primary key,
  pool       text,                    -- null: no pool with history
  checked_at timestamptz not null default now()
);

alter table public.asset_charts enable row level security;
alter table public.asset_pools enable row level security;
revoke all on public.asset_charts, public.asset_pools from anon, authenticated;
grant select, insert, update, delete on public.asset_charts, public.asset_pools to service_role;

-- Access ------------------------------------------------------------------------------------------

revoke execute on function public.asset_display_name(text) from public;
grant execute on function public.asset_display_name(text) to anon, authenticated, service_role;
revoke execute on function public.search_securities(text, boolean, int) from public;
grant execute on function public.search_securities(text, boolean, int) to service_role;
revoke execute on function public.asset_takes(text, int) from public;
grant execute on function public.asset_takes(text, int) to anon, authenticated, service_role;
revoke execute on function public.search_people(text, int) from public;
grant execute on function public.search_people(text, int) to anon, authenticated, service_role;
