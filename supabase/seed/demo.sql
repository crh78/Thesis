-- Demo callers and takes (the ones from the mockups), so a fresh account has a
-- feed to look at. The cast: Dev, Johnny, Nina, Priya and Danny (demo_cast.sql
-- moves a database seeded with the earlier cast over). Safe to re-run: fixed ids, "on conflict do nothing".
-- Demo profiles have no account (nobody can sign in as them) and is_demo = true.
-- Their avatars ship in the app: avatar_url 'asset:<name>' means a bundled image.
--
-- Apply: psql "$DATABASE_URL" -f supabase/seed/demo.sql  (or paste into the SQL editor)
-- Remove: delete from public.profiles where is_demo;  (cascades to their takes)
--
-- Stats are illustrative until paper trading computes real ones.

insert into public.profiles (id, handle, display_name, bio, avatar_url, is_demo, created_at) values
  ('00000000-0000-4000-8000-000000000001', 'johnny',   'Johnny', 'Power, compute, the grid. Long the boring stuff.', 'asset:avatar-johnny', true, now() - interval '60 days'),
  ('00000000-0000-4000-8000-000000000002', 'priya',    'Priya', 'Rates and macro. I read the Fed minutes so you don''t have to.', 'asset:avatar-priya', true, now() - interval '90 days'),
  ('00000000-0000-4000-8000-000000000003', 'dev_chips', 'Dev',   'Semis maximalist. Occasionally right.', 'asset:avatar-dev', true, now() - interval '45 days'),
  ('00000000-0000-4000-8000-000000000004', 'nina',     'Nina',  'Housing, consumer, anything with a receipt.', 'asset:avatar-nina', true, now() - interval '120 days'),
  ('00000000-0000-4000-8000-000000000005', 'danny',    'Danny', 'Professional fader. Nothing personal.', 'asset:avatar-danny', true, now() - interval '75 days')
-- Only skip rows that already exist; a handle clash with a real user should fail loudly.
on conflict (id) do nothing;

insert into public.profile_stats (profile_id, period, cash, pct) values
  ('00000000-0000-4000-8000-000000000001', 'week', 2410, 31.4),
  ('00000000-0000-4000-8000-000000000001', 'month', 6915, 24.7),
  ('00000000-0000-4000-8000-000000000001', 'all', 19640, 27.5),
  ('00000000-0000-4000-8000-000000000002', 'week', 4120, 38.1),
  ('00000000-0000-4000-8000-000000000002', 'month', 11860, 29.4),
  ('00000000-0000-4000-8000-000000000002', 'all', 41375, 36.2),
  ('00000000-0000-4000-8000-000000000003', 'week', -310, -4.8),
  ('00000000-0000-4000-8000-000000000003', 'month', 5030, 12.1),
  ('00000000-0000-4000-8000-000000000003', 'all', 8120, 9.6),
  ('00000000-0000-4000-8000-000000000004', 'week', 1980, 27.9),
  ('00000000-0000-4000-8000-000000000004', 'month', 7420, 18.2),
  ('00000000-0000-4000-8000-000000000004', 'all', 48200, 41.0),
  ('00000000-0000-4000-8000-000000000005', 'week', 1455, 44.2),
  ('00000000-0000-4000-8000-000000000005', 'month', 3100, 33.0),
  ('00000000-0000-4000-8000-000000000005', 'all', 22810, 58.7)
on conflict do nothing;

insert into public.follows (follower_id, followee_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001')
on conflict do nothing;

-- Takes (stats rows are created by trigger; updated below).
insert into public.takes (id, author_id, claim, topic, risk, horizon, tags, created_at, settles_at) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   'AI power demand is underrated.', 'topic-energy', 'medium', '3mo', '{AI,Energy}',
   now() - interval '2 hours', now() - interval '2 hours' + interval '3 months'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002',
   'The Fed cuts in December.', 'topic-bank', 'low', '2mo', '{Rates}',
   now() - interval '5 hours', now() - interval '5 hours' + interval '2 months'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000003',
   'Chip stocks lead the next leg up.', 'topic-rocket', 'high', '1mo', '{Chips,AI}',
   now() - interval '1 day', now() - interval '1 day' + interval '1 month'),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000005',
   'Nuclear restarts get fast-tracked.', 'topic-nuclear', 'medium', '6mo', '{Energy}',
   now() - interval '8 hours', now() - interval '8 hours' + interval '6 months'),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000004',
   'Mortgage rates dip under 6% by spring.', 'topic-house', 'low', '6mo', '{Housing,Rates}',
   now() - interval '26 hours', now() - interval '26 hours' + interval '6 months'),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000005',
   'Data-center spending slows in 2027.', 'topic-computer', 'high', '3mo', '{AI}',
   now() - interval '2 days', now() - interval '2 days' + interval '3 months')
on conflict do nothing;

-- Every stock leg has a liquid tokenized version on Solana (see migrations/0020_demo_tradeable_legs.sql).
insert into public.take_legs (take_id, idx, name, kind, weight, why, slot, fade_how, ret_pct) values
  ('00000000-0000-4000-8000-000000000101', 0, 'NVIDIA', 'Stock', 40, 'Its chips drive the data-center build-out behind the demand.', 0, 'Bets the stock falls', 9.6),
  ('00000000-0000-4000-8000-000000000101', 1, 'Microsoft', 'Stock', 20, 'Paying to restart a nuclear plant to power its data centers.', 1, 'Bets the stock falls', 12.4),
  ('00000000-0000-4000-8000-000000000101', 2, 'Amazon', 'Stock', 20, 'Buying nuclear power for its data centers.', 2, 'Bets the stock falls', 18.0),
  ('00000000-0000-4000-8000-000000000101', 3, 'Data-center spending', 'Prediction · Yes', 20, 'Pays out if big-tech data-center spending clears [threshold] by [date].', 3, 'Bets No', 15.5),

  ('00000000-0000-4000-8000-000000000102', 0, 'Rate cut: Yes', 'Prediction · Yes', 50, 'Pays out if the Fed cuts at the December meeting.', 0, 'Bets No', 5.2),
  ('00000000-0000-4000-8000-000000000102', 1, 'Gold', 'Gold fund', 30, 'Tends to rise when interest rates fall.', 1, null, 1.4),
  ('00000000-0000-4000-8000-000000000102', 2, 'Cash', 'Earns interest', 20, 'Idle cash earns interest while the take runs.', 2, null, 0.6),

  ('00000000-0000-4000-8000-000000000103', 0, 'NVIDIA 2x', 'Stock · 2x', 40, 'Leveraged exposure to the biggest AI chip maker.', 0, 'Bets the stock falls', -7.9),
  ('00000000-0000-4000-8000-000000000103', 1, 'AMD', 'Stock', 30, 'Second-source GPUs and server CPUs.', 1, 'Bets the stock falls', -3.1),
  ('00000000-0000-4000-8000-000000000103', 2, 'Micron', 'Stock', 30, 'Makes the memory chips AI servers need more of.', 2, 'Bets the stock falls', -2.4),

  ('00000000-0000-4000-8000-000000000104', 0, 'Microsoft', 'Stock', 40, 'Paying to restart Three Mile Island to power its data centers.', 0, 'Bets the stock falls', 11.2),
  ('00000000-0000-4000-8000-000000000104', 1, 'Alphabet', 'Stock', 30, 'Backing new small reactors to power its data centers.', 1, null, 9.0),
  ('00000000-0000-4000-8000-000000000104', 2, 'Restart approved: Yes', 'Prediction · Yes', 30, 'Pays out if a shut reactor gets a restart approval by [date].', 2, 'Bets No', 7.4),

  ('00000000-0000-4000-8000-000000000105', 0, 'Rates under 6%: Yes', 'Prediction · Yes', 50, 'Pays out if the 30-year average drops under 6%.', 0, 'Bets No', 3.4),
  ('00000000-0000-4000-8000-000000000105', 1, 'S&P 500', 'Index fund', 30, 'Stocks broadly tend to rise when rates fall.', 1, null, 1.8),
  ('00000000-0000-4000-8000-000000000105', 2, 'Cash', 'Earns interest', 20, 'Idle cash earns interest while the take runs.', 2, null, 0.6),

  ('00000000-0000-4000-8000-000000000106', 0, 'DC spending: No', 'Prediction · No', 60, 'Pays out if big-tech capex misses [threshold].', 0, 'Bets Yes', -3.0),
  ('00000000-0000-4000-8000-000000000106', 1, 'Gold', 'Gold fund', 40, 'A defensive place to sit if the build-out cools.', 1, null, -0.3)
on conflict do nothing;

update public.take_stats s set ret_pct = v.ret, history = v.history, backs = v.backs, fades = v.fades, money_in = v.money_in
from (values
  ('00000000-0000-4000-8000-000000000101'::uuid, 14.0, '{0,-1.2,0.8,2.1,1.4,3.9,5.2,4.4,7.0,8.8,8.1,10.2,11.5,11.0,12.6,13.3,14.0}'::numeric[], 24, 7, 1240),
  ('00000000-0000-4000-8000-000000000102'::uuid, 3.1, '{0,0.4,0.2,0.9,1.1,0.8,1.6,2.0,1.8,2.4,2.9,3.1}'::numeric[], 41, 12, 3880),
  ('00000000-0000-4000-8000-000000000103'::uuid, -4.8, '{0,1.2,2.5,1.8,0.4,-1.1,-0.6,-2.4,-3.1,-2.2,-4.0,-4.8}'::numeric[], 9, 15, 760),
  ('00000000-0000-4000-8000-000000000104'::uuid, 9.4, '{0,0.6,1.4,1.1,2.9,4.0,5.2,6.1,7.8,9.4}'::numeric[], 33, 6, 2210),
  ('00000000-0000-4000-8000-000000000105'::uuid, 2.2, '{0,0.3,0.1,0.8,1.2,1.0,1.7,2.2}'::numeric[], 18, 9, 980),
  ('00000000-0000-4000-8000-000000000106'::uuid, -1.9, '{0,0.5,-0.4,-0.2,-1.1,-0.8,-1.9}'::numeric[], 5, 11, 410)
) as v(take_id, ret, history, backs, fades, money_in)
where s.take_id = v.take_id and s.backs = 0 and s.fades = 0;

insert into public.comments (id, take_id, author_id, parent_id, body, created_at) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000005', null,
   'Power stocks already ran hard this year. Feels priced in to me.', now() - interval '60 minutes'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000201',
   'Priced for today''s demand, not 2027''s. Data-center plans keep getting bigger.', now() - interval '52 minutes'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', null,
   'Adding the data-center spending prediction is smart. Cleanest read on the whole idea.', now() - interval '2 hours' + interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000003', null,
   'If rate cuts stall, this whole basket deflates. Fading.', now() - interval '100 minutes'),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000004', null,
   'Labor data says yes. Backing.', now() - interval '3 hours')
on conflict do nothing;

insert into public.comment_likes (comment_id, profile_id) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000004'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000004'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000005'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000005')
on conflict do nothing;
