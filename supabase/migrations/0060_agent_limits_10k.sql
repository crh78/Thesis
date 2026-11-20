-- Agent limits up to $10,000 (owner's decision 2026-11-19): the team's own accounts get more play
-- money (the fork API's FORK_DEPOSIT_CAP_OVERRIDES), so their trading-by-text limits may go past
-- $1,000. Everyone else is still held to $1,000 by functions/agent (AGENT_LIMIT_OVERRIDES lists the
-- wallets that may go higher); this only widens the table's own check.

alter table public.agent_grants drop constraint agent_grants_per_trade_usd_check;
alter table public.agent_grants drop constraint agent_grants_check;
alter table public.agent_grants add constraint agent_grants_per_trade_usd_check check (per_trade_usd >= 10 and per_trade_usd <= 10000);
alter table public.agent_grants add constraint agent_grants_daily_usd_check check (daily_usd >= per_trade_usd and daily_usd <= 10000);
