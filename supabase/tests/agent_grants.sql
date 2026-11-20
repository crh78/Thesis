-- Checks the agent's limits (migrations/*_agent_grants.sql): agent_reserve holds backs, fades and
-- posts to the per-trade and daily limits, never sales; the same surface + ref is the same trade;
-- a revoked grant reserves nothing; the tables stay private.
-- Run against a scratch database with the migrations applied (it rolls back):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_grants.sql
-- Each check raises if it fails.
begin;
insert into public.profiles (id) values ('00000000-0000-4000-8000-0000000a9e01');
insert into public.agent_grants (profile_id, wallet, privy_wallet_id, per_trade_usd, daily_usd, x_user_id, x_username, imessage)
values ('00000000-0000-4000-8000-0000000a9e01', '4Nd1mYw9Hn3sJkF5nX3z5Qk1yJ7mJ9dLqA3r7vN2hTxz', 'wallet-1', 50, 100, '12345', 'jake', '+15555550100');

do $$
declare
  p constant uuid := '00000000-0000-4000-8000-0000000a9e01';
  j jsonb;
  first_id text;
begin
  j := public.agent_reserve(p, 'x', 'post-1', 'back', null, 40, null);
  if j ->> 'existing' <> 'false' or j ->> 'id' is null then raise exception 'a back within limits is reserved: %', j; end if;
  first_id := j ->> 'id';
  j := public.agent_reserve(p, 'x', 'post-1', 'back', null, 40, null);
  if j ->> 'existing' <> 'true' or j ->> 'id' <> first_id or j ->> 'status' <> 'pending' then raise exception 'the same ref is the same trade: %', j; end if;
  j := public.agent_reserve(p, 'x', 'post-2', 'back', null, 60, null);
  if j ->> 'error' <> 'over_trade_limit' or (j ->> 'left_usd')::numeric <> 60 then raise exception 'over the per-trade limit: %', j; end if;
  j := public.agent_reserve(p, 'imessage', 'msg-1', 'fade', null, 50, null);
  if j ->> 'existing' <> 'false' then raise exception 'a fade within limits: %', j; end if;
  j := public.agent_reserve(p, 'imessage', 'msg-2', 'post', null, 20, null);
  if j ->> 'error' <> 'over_daily_limit' or (j ->> 'left_usd')::numeric <> 10 then raise exception 'over the daily limit: %', j; end if;
  -- A failed trade frees its share of the day.
  update public.agent_trades set status = 'failed' where id = first_id::uuid;
  if public.agent_spent(p) <> 50 then raise exception 'failed trades are not spent: %', public.agent_spent(p); end if;
  j := public.agent_reserve(p, 'imessage', 'msg-3', 'sell', null, null, 5000);
  if j ->> 'existing' <> 'false' then raise exception 'sales are not held to the limits: %', j; end if;
  if public.agent_spent(p) <> 50 then raise exception 'sales do not count as spent'; end if;
  update public.agent_grants set revoked_at = now() where profile_id = p;
  j := public.agent_reserve(p, 'x', 'post-9', 'back', null, 10, null);
  if j ->> 'error' <> 'no_grant' then raise exception 'a revoked grant reserves nothing: %', j; end if;
  begin
    set local role anon;
    perform 1 from public.agent_grants;
    raise exception 'anon can read agent_grants';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
