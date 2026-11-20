-- Checks the draft page's read (migrations/*_take_drafts.sql, *_take_draft_for_x.sql): an X draft
-- says whom it was made for; an iMessage draft doesn't; the drafts table stays private. A draft
-- says whether it's inverted (migrations/*_inverted_takes.sql).
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/take_drafts.sql
-- Each check raises if it fails.
begin;
insert into public.take_drafts (id, claim, risk, horizon, legs, origin, for_x) values
  ('XdraftT1', 'Gold has more room to run', 'low', '3mo', '[{"name":"Gold","weight":100}]', 'x', 'jake_trades'),
  ('ImsgDrT1', 'Rates fall by June', 'medium', '1mo', '[{"name":"Bonds","weight":100}]', 'imessage', null);
insert into public.take_drafts (id, claim, risk, horizon, legs, origin, inverted) values
  ('InvDrfT1', 'Crypto sucks', 'high', '3mo', '[{"name":"Bitcoin","weight":100}]', 'imessage', true);

do $$
declare
  j jsonb;
begin
  set local role anon;
  j := public.take_draft('XdraftT1');
  if j ->> 'for_x' is distinct from 'jake_trades' then raise exception 'an X draft says whom it is for: %', j; end if;
  if j ->> 'claim' <> 'Gold has more room to run' or j -> 'take_id' <> 'null'::jsonb then raise exception 'draft page: %', j; end if;
  j := public.take_draft('ImsgDrT1');
  if not (j ? 'for_x') or j -> 'for_x' <> 'null'::jsonb then raise exception 'an iMessage draft has for_x null: %', j; end if;
  if (j ->> 'inverted')::boolean is not false then raise exception 'drafts aren''t inverted by default: %', j; end if;
  if (public.take_draft('InvDrfT1') ->> 'inverted')::boolean is not true then raise exception 'an inverted draft says so'; end if;
  if public.take_draft('NoSuchDr') is not null then raise exception 'a missing draft reads as null'; end if;
  begin
    perform 1 from public.take_drafts;
    raise exception 'anon can read take_drafts';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
