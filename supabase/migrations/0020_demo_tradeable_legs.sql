-- Demo takes: only assets that can actually be bought on Solana.
--
-- The seeded demo baskets held stocks with no liquid tokenized version (Vistra, Constellation,
-- TSMC, a T-bill fund, "Homebuilders", "Utilities"). Trades left them out, and a token too thin to
-- price left positions waiting on the stock market. Each is replaced with a liquid one on the same
-- theme (a Jupiter pool of $100k or more, under 1% price impact at $10 and $100).
-- Prediction, 2x and cash legs stay: their venues (Gemini, Phoenix, Jupiter Lend) are real.
--
-- Demo takes only (seeded fixtures, not posts): a posted take is still never edited. On a fresh
-- database the takes don't exist yet when this runs, so nothing is inserted; seed/demo.sql has the
-- same legs.

delete from public.take_legs
where take_id in (
  '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000106'
);

insert into public.take_legs (take_id, idx, name, kind, weight, why, slot, fade_how, ret_pct)
select v.take_id::uuid, v.idx, v.name, v.kind, v.weight, v.why, v.slot, v.fade_how, v.ret_pct
from (values
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
) as v(take_id, idx, name, kind, weight, why, slot, fade_how, ret_pct)
join public.takes t on t.id = v.take_id::uuid;
