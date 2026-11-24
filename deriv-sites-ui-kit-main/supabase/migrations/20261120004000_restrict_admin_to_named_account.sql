-- Restrict the admin panel to one named account.
--
-- Requested: gadnadolo4@gmail.com must be refused at /admin, and
-- gadnadolo19@gmail.com is the only platform admin. Access is derived, not
-- hard-coded, so revoking the rows is enough:
--
--   is_platform_admin()      = has_role(admin) OR active super_admin membership
--   my_platform_access()     = the same logic, plus the capability flags
--
-- Deleting the `user_roles` admin row and the `super_admin` membership therefore
-- closes /admin, the admin-gated policies, and the finance tabs in one move. The
-- tenant_owner membership stays, so the account keeps its own sites and its
-- normal trader dashboard.
--
-- Keyed by email rather than a literal uuid so this reads as the rule it is, and
-- so re-running it is safe.

do $$
declare
  restricted_email constant text := 'gadnadolo4@gmail.com';
  restricted_id uuid;
begin
  select id into restricted_id from auth.users where lower(email) = restricted_email;

  if restricted_id is null then
    raise notice 'No user with email %, nothing to restrict.', restricted_email;
    return;
  end if;

  delete from public.user_roles
  where user_id = restricted_id
    and role = 'admin'::public.app_role;

  delete from public.organisation_members
  where user_id = restricted_id
    and role::text in ('super_admin', 'operations_admin', 'support_admin', 'finance_viewer');

  raise notice 'Restricted platform access for % (%).', restricted_email, restricted_id;
end;
$$;
