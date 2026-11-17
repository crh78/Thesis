-- Checks liquidation alerts (migrations/*_liquidation_alerts.sql): stored once per key, for known
-- wallets only, with an unknown take dropped, and shown in the inbox. Rolls back:
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/liquidation_alerts.sql
begin;
insert into public.profiles (id, handle, display_name, solana_address) values
  ('00000000-0000-4000-8000-00000000d001', 'levered', 'Levered', 'WALLET_L');
insert into public.takes (id, author_id, claim, risk, horizon, settles_at) values
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000d001', 'Liquidation test take', 'high', '1mo', now() + interval '30 days');

do $$
declare
  me uuid := '00000000-0000-4000-8000-00000000d001';
  take uuid := '00000000-0000-4000-8000-00000000e001';
  inbox jsonb;
  n int;
begin
  if not public.post_liquidation_alert('WALLET_L', 'solana-mainnet-fork', 'POS:1:near', take, 'NVIDIA perp is getting near liquidation', 'NVDA is $150.00.', '{"level":"near"}') then
    raise exception 'near alert not stored';
  end if;
  if public.post_liquidation_alert('WALLET_L', 'solana-mainnet-fork', 'POS:1:near', take, 'again', '', '{}') then
    raise exception 'the same alert stored twice';
  end if;
  -- The next level is its own alert; an unknown take id is dropped, not refused.
  if not public.post_liquidation_alert('WALLET_L', 'solana-mainnet-fork', 'POS:1:close', '00000000-0000-4000-8000-0000000000ff', 'NVIDIA perp is close to liquidation', '', '{"level":"close"}') then
    raise exception 'close alert not stored';
  end if;
  if public.post_liquidation_alert('WALLET_NOBODY', 'solana-mainnet-fork', 'POS:1:near', take, 'x', '', '{}') then
    raise exception 'alert for a wallet with no profile';
  end if;
  if public.post_liquidation_alert('WALLET_L', 'solana-mainnet-fork', '', take, 'x', '', '{}') then
    raise exception 'alert with no key';
  end if;

  select count(*) into n from public.notifications where profile_id = me and kind = 'liquidation_risk';
  if n <> 2 then raise exception 'expected 2 alerts, got %', n; end if;
  select count(*) into n from public.notifications where profile_id = me and kind = 'liquidation_risk' and take_id is null;
  if n <> 1 then raise exception 'the unknown take should be dropped on exactly one alert, got %', n; end if;

  inbox := public.notification_inbox(me, 'solana-mainnet-fork', 50);
  if (inbox ->> 'unread')::int < 2 or inbox -> 'notifications' -> 0 ->> 'kind' <> 'liquidation_risk' then
    raise exception 'inbox: %', inbox;
  end if;
  raise notice 'liquidation alerts: all checks passed';
end $$;
rollback;
