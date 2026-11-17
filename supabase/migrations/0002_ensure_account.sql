-- Find-or-create the profile + account for a Privy user, safe under concurrent
-- first logins (the app may fire several requests right after sign-in).
-- Called only by the `session` edge function with the service role.

create function public.ensure_account(p_privy_did text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  pid uuid;
begin
  select profile_id into pid from public.accounts where privy_did = p_privy_did;
  if found then
    return pid;
  end if;

  insert into public.profiles default values returning id into pid;

  begin
    insert into public.accounts (profile_id, privy_did) values (pid, p_privy_did);
  exception when unique_violation then
    -- another request won the race; drop our orphan profile and use theirs
    delete from public.profiles where id = pid;
    select profile_id into pid from public.accounts where privy_did = p_privy_did;
  end;

  return pid;
end;
$$;

revoke execute on function public.ensure_account(text) from public, anon, authenticated;
grant execute on function public.ensure_account(text) to service_role;
