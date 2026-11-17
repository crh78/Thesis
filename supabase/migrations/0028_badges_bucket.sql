-- Badge metadata (docs/hardening-plan.md §5): each "called it" badge's
-- Token-2022 metadata JSON and its 512×512 image, at
--   <SUPABASE_URL>/storage/v1/object/public/badges/<slug>.json and <slug>.png
-- The program builds each badge's URI from the config account's badge_uri_base (set with
-- update_config), so this bucket can move without an upgrade. Files come from infra/badges
-- (`pnpm badges:upload`).
--
-- Public read (wallets and explorers fetch the metadata with no key); writes only with the
-- service role, so no storage policies are needed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('badges', 'badges', true, 1048576, array['image/png', 'application/json'])
on conflict (id) do nothing;
