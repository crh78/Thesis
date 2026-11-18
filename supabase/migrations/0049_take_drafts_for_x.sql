-- Drafts the X bot saves for the person who asked (decided 2026-11-17).
--
-- A reply on X with a link costs $0.20 against $0.015 without, so the bot replies with no link:
-- "sign in with X at the link in our bio". The draft is saved under the asker's X username, and
-- once they sign in with that X account the web app lists it (source GET /drafts/mine, which
-- reads the username from their Privy account, never from the client).
--
--   for_x   the asker's X username, lowercased; null for iMessage drafts (those keep their link).

alter table public.take_drafts
  add column for_x text check (for_x is null or for_x ~ '^[a-z0-9_]{1,15}$');

create index take_drafts_for_x on public.take_drafts (for_x, created_at desc)
  where for_x is not null and take_id is null;
