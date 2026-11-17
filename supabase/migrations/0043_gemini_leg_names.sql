-- Gemini leg names without the event title's "?" before the contract's label:
-- "Gold price on December 20?: $3,975 or above" → "Gold price on December 20: $3,975 or above".
-- packages/take-builder/src/gemini.ts builds new names this way; this rewrites the
-- names already stored, in the catalog and in takes' legs.
--
-- Safe for takes already on-chain: a prediction leg's on-chain asset comes from its contract's
-- symbol (asset_id gemini:<instrumentSymbol>), not its name. Only "?: " is touched, so a name
-- ending ": No" (how the fork API reads a No side) keeps it.

update public.securities
set name = regexp_replace(name, '\?:\s', ': '),
    description = regexp_replace(description, '\?:\s', ': '),
    data = case
      when data ? 'description' then jsonb_set(data, '{description}', to_jsonb(regexp_replace(data ->> 'description', '\?:\s', ': ')))
      else data
    end
where id like 'gemini:%'
  and (name ~ '\?:\s' or description ~ '\?:\s' or data ->> 'description' ~ '\?:\s');

update public.take_legs
set name = regexp_replace(name, '\?:\s', ': ')
where name ~ '\?:\s'
  and kind ilike 'prediction%';
