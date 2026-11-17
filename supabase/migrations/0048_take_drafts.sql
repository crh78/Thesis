-- Draft takes from the chat bots (decided 2026-11-16).
--
-- The iMessage and X bots turn a message or a post into a take, but a bot can't post a take as
-- someone: takes go live through the author's own wallet. So a bot saves a draft here, with the
-- basket the take builder made, and replies with its web page (/d/<id>). Whoever taps "Post it"
-- signs in, and the draft opens in the composer on that basket; posting makes it their take.
-- Once it's live, the draft points at it, and the page sends later visitors to the take.
--
--   take_drafts        service role only; written by functions/source (bots: x-bot-secret;
--                      "posted": the take's author, with their Privy token).
--   take_draft(id)     the public read for the draft page and its link preview.
--   source_secret()    now also serves bot_secret (made here), the bots' key to POST /source/drafts.

create table public.take_drafts (
  -- Short, so a reply on X stays short: 8 letters and digits.
  id           text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  claim        text not null check (char_length(claim) between 3 and 140),
  risk         text not null check (risk in ('low', 'medium', 'high')),
  horizon      text not null check (horizon in ('2wk', '1mo', '3mo', '6mo')),
  summary      text check (summary is null or char_length(summary) <= 400),
  -- The take builder's legs as it returned them (lib/compose.ts fromBuilt reads them).
  legs         jsonb not null check (jsonb_typeof(legs) = 'array' and jsonb_array_length(legs) between 1 and 10),
  -- Where the take came from, shown as "via …": an X post, or null for a chat.
  source_url   text check (source_url is null or (source_url ~ '^https?://' and char_length(source_url) <= 500)),
  source_label text check (source_label is null or char_length(source_label) between 1 and 60),
  source_kind  text check (source_kind is null or source_kind in ('link', 'x')),
  -- Which bot made it, and a line for the page: "From a group chat", "@jake asked on X".
  origin       text not null check (origin in ('imessage', 'x')),
  context      text check (context is null or char_length(context) <= 80),
  -- The post or message it answered (an X post id), so a retried reply reuses the draft.
  origin_ref   text check (origin_ref is null or char_length(origin_ref) <= 64),
  take_id      uuid references public.takes (id) on delete set null,
  posted_at    timestamptz,
  created_at   timestamptz not null default now()
);
create unique index take_drafts_origin_ref on public.take_drafts (origin, origin_ref) where origin_ref is not null;

alter table public.take_drafts enable row level security;
revoke all on public.take_drafts from anon, authenticated;
grant select, insert, update, delete on public.take_drafts to service_role;

-- The draft page. A posted draft carries its take's id only once that take is live.
create function public.take_draft(p_id text) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id, 'claim', d.claim, 'risk', d.risk, 'horizon', d.horizon, 'summary', d.summary,
    'legs', d.legs, 'origin', d.origin, 'context', d.context, 'created_at', d.created_at,
    'source', case when d.source_url is null then null
      else jsonb_build_object('url', d.source_url, 'label', d.source_label, 'kind', d.source_kind) end,
    'take_id', case when t.status = 'live' then t.id end
  )
  from public.take_drafts d
  left join public.takes t on t.id = d.take_id
  where d.id = p_id
$$;
grant execute on function public.take_draft(text) to anon, authenticated, service_role;

create or replace function public.source_secret(p_name text) returns text
language sql stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  where s.name = p_name and p_name in ('apify_token', 'x_poll_secret', 'bot_secret')
$$;
revoke all on function public.source_secret(text) from public, anon, authenticated;
grant execute on function public.source_secret(text) to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bot_secret')
where not exists (select 1 from vault.secrets where name = 'bot_secret');
