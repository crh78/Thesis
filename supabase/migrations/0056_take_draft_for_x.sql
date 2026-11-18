-- The draft page says who an X draft is for (decided 2026-11-18).
--
-- A draft the X bot made for someone (take_drafts.for_x, 0049_take_drafts_for_x) can be posted
-- only by the person whose Privy login links that X account (functions/source PUT /drafts/:id).
-- take_draft() now returns for_x, so the page can say "made for @handle" and not offer "Post it"
-- to anyone else. It isn't secret: it's the asker's public X username, lowercased, without the @;
-- null for iMessage drafts.
--
-- Same as 0048_take_drafts otherwise.

create or replace function public.take_draft(p_id text) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id, 'claim', d.claim, 'risk', d.risk, 'horizon', d.horizon, 'summary', d.summary,
    'legs', d.legs, 'origin', d.origin, 'context', d.context, 'created_at', d.created_at,
    'source', case when d.source_url is null then null
      else jsonb_build_object('url', d.source_url, 'label', d.source_label, 'kind', d.source_kind) end,
    'take_id', case when t.status = 'live' then t.id end,
    'for_x', d.for_x
  )
  from public.take_drafts d
  left join public.takes t on t.id = d.take_id
  where d.id = p_id
$$;
