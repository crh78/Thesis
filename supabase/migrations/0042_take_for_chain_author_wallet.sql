-- take_for_chain also returns the author's wallet (`author_wallet`, their profiles.solana_address,
-- already public; null for seeded demo authors, who have none).
--
-- The fork API mirrors a take it doesn't find on the fork under a stand-in author key, which is
-- right for seeded demo takes. After a fork reset it did the same to takes real users had posted,
-- so their creator fees and score went to the stand-in. With the wallet it can tell them apart and
-- refuse instead: only the author can put their take back on-chain.
--
-- Additive: same signature and grants, one more key in the JSON.
create or replace function public.take_for_chain(p_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select public.take_json(t) || jsonb_build_object('author_wallet', p.solana_address)
  from public.takes t
  left join public.profiles p on p.id = t.author_id
  where t.id = p_id
$$;
