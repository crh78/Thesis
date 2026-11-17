-- Called-it card pictures the app shares as links (functions/v1/cards).
-- The web page /c/<take>?card=<id> uses one as its link preview, so iMessage shows
-- the same picture the person made in the app.
--
-- Public read; writes only via the service role in the `cards` function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cards', 'cards', true, 2097152, array['image/jpeg'])
on conflict (id) do nothing;
