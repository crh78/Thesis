-- Profile photos live in profiles.avatar_url: a built-in face
-- ("face:<name>:<color>"), an uploaded photo (https URL in the `avatars`
-- bucket below), or a bundled demo image ("asset:<name>").
--
-- Public read (avatars are shown to everyone); writes only via the service
-- role in the `session` function, so no storage policies are needed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 3145728, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;
