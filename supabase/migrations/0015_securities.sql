-- Securities catalog for the take builder: everything that could go in a
-- basket (tradeable tokenized stocks/ETFs/commodities, perps, prediction
-- events, yield vaults, card categories), built from
-- packages/venues/registry/assets.json by packages/take-builder.
--
-- Each row has a short description + themes (written at index time so a take
-- like "AI power demand is underrated" can find Vistra) and an embedding of
-- that text. match_securities() is the search the take-builder agent calls.

create extension if not exists vector with schema extensions;

create table public.securities (
  id           text primary key,             -- registry id, e.g. jup:<mint>, phoenix:SOL, gemini:<ticker>
  kind         text not null check (kind in ('stock', 'etf', 'commodity', 'pre-ipo', 'leveraged', 'yield', 'perp', 'prediction', 'card', 'other')),
  symbol       text not null,
  name         text not null,
  underlying   text,                          -- e.g. NVDA, for tokenized stocks
  issuer       text,
  venue        text not null,                 -- Jupiter, Phoenix, Gemini, Kamino, Collector Crypt, ...
  mint         text,
  themes       text[] not null default '{}',
  description  text,                          -- 1–2 sentences, written at index time
  liquidity    text not null check (liquidity in ('tradeable', 'thin', 'n/a')),
  us_persons   text not null check (us_persons in ('yes', 'no', 'unknown')),
  can_short    boolean not null default false,
  expires_at   timestamptz,                   -- prediction events
  data         jsonb not null default '{}',   -- source fields (leverage, apy, quotes, ...)
  embedding    extensions.vector(1536),
  indexed_text text,                          -- what was embedded, to skip unchanged rows
  updated_at   timestamptz not null default now()
);

create index securities_embedding on public.securities
  using hnsw (embedding extensions.vector_cosine_ops);
create index securities_kind on public.securities (kind);

alter table public.securities enable row level security;
create policy "securities are public" on public.securities for select to anon, authenticated using (true);
revoke all on public.securities from anon, authenticated;
grant select on public.securities to anon, authenticated;
grant select, insert, update, delete on public.securities to service_role;

-- Nearest securities to a query embedding, with filters.
--   p_kinds        only these kinds (null = all)
--   p_us_person    true = hide what US persons can't buy ('no'); 'unknown' stays, flagged
--   p_min_liquidity 'tradeable' or 'thin'
create function public.match_securities(
  p_embedding extensions.vector(1536),
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
  order by s.embedding operator(extensions.<=>) p_embedding
  limit least(greatest(p_count, 1), 50)
$$;

revoke execute on function public.match_securities(extensions.vector, int, text[], boolean, text) from public;
grant execute on function public.match_securities(extensions.vector, int, text[], boolean, text) to anon, authenticated, service_role;
