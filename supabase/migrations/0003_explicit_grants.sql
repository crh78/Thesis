-- Explicit grants, so behaviour doesn't depend on whether the project
-- auto-exposes new tables to the Data API roles.
-- Clients get read-only access to profiles; everything else is service role only.

revoke all on public.profiles from anon, authenticated;
revoke all on public.accounts from anon, authenticated;

grant select on public.profiles to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.accounts to service_role;
