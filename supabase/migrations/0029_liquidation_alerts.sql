-- Liquidation warnings: the backend (the fork API today) watches each Phoenix
-- leg against its liquidation price and posts an alert when one is near (within 25%) or close
-- (within 10%). Additive: a new notification kind and the function that stores an alert once.

alter table public.notifications drop constraint notifications_kind;
alter table public.notifications add constraint notifications_kind check (kind in
  ('new_take', 'comment', 'take_traded', 'take_faded', 'take_settled', 'badge', 'daily_positions', 'liquidation_risk'));

-- Called by functions/notify (service role). `p_key` names the leg and level
-- ("<position>:<leg>:near"), so each alert is stored once per profile however often the watcher
-- sends it. Wallets with no profile are skipped. `p_take` is the app take, when the backend knows it.
create function public.post_liquidation_alert(
  p_wallet text, p_network text, p_key text, p_take uuid, p_title text, p_body text, p_data jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid;
  take_ok uuid;
begin
  select p.id into who from public.profiles p where p.solana_address = p_wallet;
  if who is null or p_key is null or p_key = '' then
    return false;
  end if;
  -- A take id the database doesn't know (a demo take mirrored on the fork) is dropped, not refused.
  select t.id into take_ok from public.takes t where t.id = p_take;
  insert into public.notifications (profile_id, kind, network, take_id, title, body, data, dedupe_key)
  values (who, 'liquidation_risk', p_network, take_ok, left(p_title, 140), left(coalesce(p_body, ''), 280),
          coalesce(p_data, '{}'::jsonb), p_network || ':' || left(p_key, 200))
  on conflict do nothing;
  return found;
end;
$$;

revoke all on function public.post_liquidation_alert(text, text, text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.post_liquidation_alert(text, text, text, uuid, text, text, jsonb) to service_role;
