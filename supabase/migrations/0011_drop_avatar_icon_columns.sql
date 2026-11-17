-- An earlier draft of profile_avatars added separate icon/color columns; the
-- face now lives in avatar_url instead. Drop them where they exist.
alter table public.profiles
  drop column if exists avatar_icon,
  drop column if exists avatar_color;
