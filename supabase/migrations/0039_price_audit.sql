-- Price audit: the market data behind every price the settler signs, public, so anyone can check it.
--
-- Every record_entry/exit/sale_prices instruction carries `source_hash` = sha256 of a canonical
-- JSON document (apps/executor/src/settler/audit.ts canonicalJson) holding the exact Jupiter /
-- Alpaca / Gemini / Phoenix responses each leg was priced from. The program emits it in
-- EntryPricesRecorded / ExitPricesRecorded / SalePricesRecorded, which the QuickNode stream lands
-- in public.chain_events (data.sourceHash, a byte array). Until now the documents only lived in
-- the settler machine's .data/settler/audit.jsonl. Now the settler also sends each one to the
-- price-audit edge function, which recomputes the hash and stores it here.
--
--   price_audit     one row per document, keyed by its hash. `canonical` is the exact text that
--                   was hashed (sha256(canonical) = hash), so a check never depends on how jsonb
--                   re-prints numbers; `doc` is the same document as jsonb, for queries.
--   price_events()  a position's (or take's) on-chain price events with their hashes as hex,
--                   joined to the stored document: what verify-prices.ts reads.
--
-- Public read (the data is public market data and on-chain hashes); writes only through the
-- price-audit function (service role).

create table public.price_audit (
  hash       text primary key,
  network    text,
  program    text,
  take       text,
  position   text,
  moment     text check (moment in ('entry', 'exit', 'sale')),
  moment_at  bigint,
  canonical  text not null,
  doc        jsonb not null,
  logged_at  timestamptz not null default now(),

  constraint price_audit_hash check (hash ~ '^[0-9a-f]{64}$'),
  constraint price_audit_hash_matches check (encode(extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'), 'hex') = hash)
);

create index price_audit_position on public.price_audit (position, moment);
create index price_audit_take on public.price_audit (take);

alter table public.price_audit enable row level security;
create policy "price audit is public" on public.price_audit for select to anon, authenticated using (true);
revoke all on public.price_audit from anon, authenticated;
grant select on public.price_audit to anon, authenticated;
grant select, insert on public.price_audit to service_role;

-- A 32-byte array from an event's JSON (`[170, 187, ...]`) as lowercase hex.
create function public.bytes_hex(p jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select string_agg(lpad(to_hex((v #>> '{}')::int), 2, '0'), '' order by ord)
  from jsonb_array_elements(p) with ordinality as a(v, ord)
$$;

-- On-chain price events for a position (p_position) or every position of a take (p_take, its
-- on-chain address), oldest first, with the stored document when there is one. `verified` is
-- true when the stored document's hash is the on-chain hash (always, if a row exists: the table
-- checks it); null when no document was published for that hash.
create function public.price_events(p_position text default null, p_take text default null, p_network text default null)
returns table (
  network text, signature text, ordinal integer, slot bigint, block_time timestamptz, name text,
  take text, "position" text, legs integer, source_hash text, published boolean, canonical text
)
language sql stable
security definer
set search_path = ''
as $$
  select e.network, e.signature, e.ordinal, e.slot, e.block_time, e.name,
         e.data ->> 'take', e.data ->> 'position', (e.data ->> 'legs')::int,
         public.bytes_hex(e.data -> 'sourceHash') as source_hash,
         a.hash is not null as published,
         a.canonical
  from public.chain_events e
  left join public.price_audit a on a.hash = public.bytes_hex(e.data -> 'sourceHash')
  where e.name in ('entryPricesRecorded', 'exitPricesRecorded', 'salePricesRecorded')
    and (p_position is not null or p_take is not null)
    and (p_position is null or e.data ->> 'position' = p_position)
    and (p_take is null or e.data ->> 'take' = p_take)
    and (p_network is null or e.network = p_network)
  order by e.slot nulls last, e.signature, e.ordinal
  limit 500
$$;

revoke execute on function public.bytes_hex(jsonb) from public;
grant execute on function public.bytes_hex(jsonb) to anon, authenticated, service_role;
revoke execute on function public.price_events(text, text, text) from public;
grant execute on function public.price_events(text, text, text) to anon, authenticated, service_role;
