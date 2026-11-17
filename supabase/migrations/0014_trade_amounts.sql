-- Trades and fades take any amount (was a flat $20).
--
-- place_trade gets p_amount: at least min_trade ($1), whole cents, and no more
-- than your balance. Left out, it's still trade_amount ($20), so older app
-- builds keep working. The amount goes to the platform and into the take's
-- money in, as before.

create or replace function public.cash_rules() returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'min_deposit', 10,
    'daily_deposit_limit', 2500,
    'min_withdrawal', 1,
    'min_trade', 1,
    -- default amount when the app doesn't send one
    'trade_amount', 20
  )
$$;

drop function public.place_trade(uuid, uuid, text);

create function public.place_trade(p_profile uuid, p_take uuid, p_side text, p_amount numeric default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rules jsonb := public.cash_rules();
  amt numeric := coalesce(p_amount, (rules ->> 'trade_amount')::numeric);
  tid uuid := gen_random_uuid();
begin
  if p_side not in ('trade', 'fade') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;
  if amt < (rules ->> 'min_trade')::numeric or amt <> round(amt, 2) then
    raise exception 'below_minimum' using errcode = '22023';
  end if;
  if not exists (select 1 from public.takes where id = p_take) then
    raise exception 'no take' using errcode = 'P0002';
  end if;
  perform public.lock_account(p_profile);

  if public.cash_balance(p_profile) < amt then
    raise exception 'insufficient_funds' using errcode = '22023';
  end if;

  insert into public.ledger (transfer_id, profile_id, kind, amount, take_id) values
    (tid, p_profile, p_side, -amt, p_take),
    (tid, null, p_side, amt, p_take);

  update public.take_stats set
    backs = backs + (p_side = 'trade')::int,
    fades = fades + (p_side = 'fade')::int,
    money_in = money_in + amt
  where take_id = p_take;

  return jsonb_build_object(
    'cash', public.cash_summary(p_profile),
    'take', (select public.take_json(t) from public.takes t where t.id = p_take)
  );
end;
$$;

revoke execute on function public.place_trade(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.place_trade(uuid, uuid, text, numeric) to service_role;
