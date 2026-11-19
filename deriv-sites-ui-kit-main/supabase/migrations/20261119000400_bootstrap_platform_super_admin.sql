-- Bootstrap the platform organisation and promote existing admins to super_admin.
--
-- Why: `useAdminRole()` treats a user as a platform admin when they hold either
-- the legacy `app_role = 'admin'` (user_roles) or a platform role of
-- super_admin / operations_admin / support_admin / finance_viewer in
-- organisation_members. Production had the legacy admin flag on one account but
-- no platform organisation and no platform role at all, so `isAdmin` was true
-- while `canManageSites`, `canSupport`, `canViewFinance` and the Admin tabs
-- (including `deriv-pool`, where the Deriv token is saved) stayed hidden.
--
-- This migration is idempotent and data-driven: it derives the platform owner
-- from the legacy admin grant instead of hardcoding an email address.

do $$
declare
  platform_org uuid;
  legacy_admin uuid;
begin
  -- Oldest legacy admin owns the platform organisation.
  select ur.user_id
    into legacy_admin
    from public.user_roles ur
   where ur.role = 'admin'::public.app_role
   order by ur.created_at asc nulls last
   limit 1;

  if legacy_admin is null then
    raise notice 'No legacy admin found; skipping platform organisation bootstrap';
    return;
  end if;

  select id into platform_org from public.organisations where slug = 'derivsites-platform';

  if platform_org is null then
    insert into public.organisations (name, slug, owner_user_id, status)
    values ('DerivSites Platform', 'derivsites-platform', legacy_admin, 'active')
    returning id into platform_org;
  end if;

  -- Every legacy admin becomes a platform super_admin so the admin console and
  -- its RLS policies (`is_platform_admin`, `has_platform_permission`) agree.
  insert into public.organisation_members (organisation_id, user_id, role, status)
  select platform_org, ur.user_id, 'super_admin'::public.platform_role, 'active'
    from public.user_roles ur
   where ur.role = 'admin'::public.app_role
  on conflict (organisation_id, user_id)
  do update set role = 'super_admin', status = 'active';
end $$;
