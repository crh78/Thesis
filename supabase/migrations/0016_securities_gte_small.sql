-- Embeddings come from Supabase's built-in gte-small model (runs inside the
-- edge function: no external call), which is 384-dimensional. The table was
-- empty when this ran.

drop function public.match_securities(extensions.vector, int, text[], boolean, text);
drop index public.securities_embedding;
alter table public.securities alter column embedding type extensions.vector(384) using null;
create index securities_embedding on public.securities
  using hnsw (embedding extensions.vector_cosine_ops);

create function public.match_securities(
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
  order by s.embedding operator(extensions.<=>) p_embedding
  limit least(greatest(p_count, 1), 80)
$$;

revoke execute on function public.match_securities(extensions.vector, int, text[], boolean, text) from public;
grant execute on function public.match_securities(extensions.vector, int, text[], boolean, text) to anon, authenticated, service_role;
