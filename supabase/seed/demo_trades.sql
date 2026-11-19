-- Demo trades: real ledger rows behind the demo takes, so the take page can
-- name who traded / faded ("You, Priya and 22 others traded"). Run after
-- demo.sql. Idempotent.
--
-- Each demo person gets a $200 simulated deposit, then $20 trades / fades,
-- written like place_trade does (user −20, platform +20, same transfer_id, at
-- the take's price) plus the position they open. take_stats isn't touched:
-- demo.sql already set the counts.

with people as (
  select id, handle from public.profiles
  where handle in ('johnny', 'priya', 'nina', 'danny', 'dev_chips')
),
deposits as (
  select p.id, gen_random_uuid() as tid from people p
  where not exists (select 1 from public.ledger l where l.profile_id = p.id and l.kind = 'deposit')
)
insert into public.ledger (transfer_id, profile_id, kind, amount, method, created_at)
select tid, id, 'deposit', 200, 'transfer', now() - interval '3 days' from deposits
union all
select tid, null, 'deposit', -200, 'transfer', now() - interval '3 days' from deposits;

with picks (handle, claim, side, hours_ago) as (values
  ('priya',     'AI power demand is underrated.',          'trade', 30),
  ('nina',      'AI power demand is underrated.',          'trade', 26),
  ('danny',     'AI power demand is underrated.',          'trade', 20),
  ('dev_chips', 'AI power demand is underrated.',          'fade',  14),
  ('johnny',    'The Fed cuts in December.',               'trade', 40),
  ('nina',      'The Fed cuts in December.',               'trade', 33),
  ('danny',     'The Fed cuts in December.',               'fade',  18),
  ('johnny',    'Nuclear restarts get fast-tracked.',      'trade', 22),
  ('priya',     'Nuclear restarts get fast-tracked.',      'trade', 16),
  ('nina',      'Nuclear restarts get fast-tracked.',      'trade', 7),
  ('dev_chips', 'Nuclear restarts get fast-tracked.',      'fade',  11),
  ('johnny',    'Chip stocks lead the next leg up.',       'fade',  25),
  ('priya',     'Chip stocks lead the next leg up.',       'fade',  19),
  ('danny',     'Chip stocks lead the next leg up.',       'fade',  6),
  ('priya',     'Mortgage rates dip under 6% by spring.',  'trade', 21),
  ('johnny',    'Mortgage rates dip under 6% by spring.',  'trade', 15),
  ('dev_chips', 'Data-center spending slows in 2027.',     'trade', 17),
  ('johnny',    'Data-center spending slows in 2027.',     'fade',  10),
  ('priya',     'Data-center spending slows in 2027.',     'fade',  4)
),
rows as (
  select gen_random_uuid() as tid, p.id as profile_id, t.id as take_id, k.side,
         now() - make_interval(hours => k.hours_ago) as at
  from picks k
  join public.profiles p on p.handle = k.handle
  join public.takes t on t.claim = k.claim
  where t.author_id <> p.id
    and not exists (select 1 from public.ledger l
                    where l.profile_id = p.id and l.take_id = t.id and l.kind = k.side)
),
legs as (
  insert into public.ledger (transfer_id, profile_id, kind, amount, take_id, price, created_at)
  select tid, profile_id, side, -20, take_id, public.take_price(take_id), at from rows
  union all
  select tid, null, side, 20, take_id, public.take_price(take_id), at from rows
  returning 1
)
insert into public.positions (profile_id, take_id, side, shares, cost, opened_at, updated_at)
select profile_id, take_id, side, 20 / public.take_price(take_id), 20, at, at from rows
on conflict do nothing;
