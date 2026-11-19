-- Moves a database seeded with the earlier demo cast (Jake, Priya, Dev, Lena, Mo, Kai) to the
-- current one (Johnny, Priya, Dev, Nina, Danny), as demo.sql now seeds it. Same ids, so their
-- follows, comments and takes carry over; Kai's take moves to Danny and Kai is removed (his
-- follows, likes and trades go with him). Demo rows only. Safe to re-run.
--
-- Apply: supabase db query --linked -f supabase/seed/demo_cast.sql

update public.profiles p set handle = v.handle, display_name = v.name, avatar_url = v.avatar
from (values
  ('00000000-0000-4000-8000-000000000001'::uuid, 'johnny', 'Johnny', 'asset:avatar-johnny'),
  ('00000000-0000-4000-8000-000000000004'::uuid, 'nina',   'Nina',   'asset:avatar-nina'),
  ('00000000-0000-4000-8000-000000000005'::uuid, 'danny',  'Danny',  'asset:avatar-danny')
) as v(id, handle, name, avatar)
where p.id = v.id and p.is_demo;

update public.takes set author_id = '00000000-0000-4000-8000-000000000005'
where id = '00000000-0000-4000-8000-000000000106'
  and author_id = '00000000-0000-4000-8000-000000000006';

delete from public.profiles where id = '00000000-0000-4000-8000-000000000006' and is_demo;
