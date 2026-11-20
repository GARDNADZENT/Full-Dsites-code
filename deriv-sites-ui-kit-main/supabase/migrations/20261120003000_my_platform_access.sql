-- Resolve the caller's platform access from the identity the database trusts.
--
-- The admin gate used to infer access from two PostgREST reads (`user_roles` and
-- `organisation_members`). Those reads are filtered by RLS and depend on the
-- client holding a hydrated user object, so "I have the admin role in the
-- database" and "the browser thinks I am not an admin" could disagree with no
-- way to tell which query failed. Both reads returned the right rows for
-- gadnadolo4@gmail.com when replayed with that user's own access token, which
-- left the client as the only place the answer could be lost.
--
-- This function asks the database to answer for `auth.uid()` instead. There is
-- one source of truth (the JWT the request arrived with), the role logic lives
-- next to the policies that use it, and the JSON it returns doubles as a
-- diagnostic the UI can show verbatim.

create or replace function public.my_platform_access()
returns jsonb
language sql
stable
security definer
set search_path to public
as $$
  with me as (
    select auth.uid() as uid
  ),
  role_rows as (
    select
      exists (
        select 1 from public.user_roles ur
        where ur.user_id = me.uid and ur.role = 'admin'::public.app_role
      ) as is_legacy_admin,
      coalesce(
        (
          select array_agg(om.role::text order by om.role::text)
          from public.organisation_members om
          where om.user_id = me.uid and om.status = 'active'
        ),
        array[]::text[]
      ) as organisation_roles
    from me
  ),
  resolved as (
    select
      me.uid,
      role_rows.is_legacy_admin,
      role_rows.organisation_roles,
      -- Same precedence as the old client-side `rank` array, highest first.
      coalesce(
        (
          select candidate
          from unnest(array['super_admin', 'operations_admin', 'support_admin', 'finance_viewer']::text[]) as candidate
          where candidate = any (role_rows.organisation_roles)
          limit 1
        ),
        null
      ) as platform_role
    from me
    cross join role_rows
  )
  select jsonb_build_object(
    'user_id', resolved.uid,
    'email', (select u.email from auth.users u where u.id = resolved.uid),
    -- legacy_admin (user_roles.admin) outranks any organisation membership,
    -- exactly as before, so nobody loses access by being granted one.
    'role', case
      when resolved.is_legacy_admin then 'legacy_admin'
      else resolved.platform_role
    end,
    'organisation_roles', to_jsonb(resolved.organisation_roles),
    -- coalesce: with no identity the comparison yields NULL, and a null flag
    -- reads as "maybe" to a UI. Denials must be an explicit false.
    'is_admin', coalesce(resolved.is_legacy_admin or resolved.platform_role is not null, false),
    'can_manage_sites', coalesce(
      resolved.is_legacy_admin
      or resolved.platform_role in ('super_admin', 'operations_admin'),
      false),
    'can_support', coalesce(
      resolved.is_legacy_admin
      or resolved.platform_role in ('super_admin', 'support_admin'),
      false),
    'can_view_finance', coalesce(
      resolved.is_legacy_admin
      or resolved.platform_role in ('super_admin', 'finance_viewer'),
      false),
    'is_platform_admin', public.is_platform_admin(resolved.uid),
    'can_read_finance', public.has_platform_permission(resolved.uid, 'finance.read')
  )
  from resolved;
$$;

comment on function public.my_platform_access() is
  'Platform access for the calling user (auth.uid()), resolved server-side so the admin gate cannot disagree with the policies.';

-- Only signed-in callers have an identity to resolve; anon would always be
-- denied, so it has no business calling this.
revoke all on function public.my_platform_access() from public;
revoke all on function public.my_platform_access() from anon;
grant execute on function public.my_platform_access() to authenticated;
grant execute on function public.my_platform_access() to service_role;
