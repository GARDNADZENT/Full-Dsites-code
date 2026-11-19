-- Repair sites whose Deriv app is bound but whose tenant login row says nothing.
--
-- Symptom: tenant login returns 409 deriv_app_missing even though the site owns a
-- platform pool app. `deriv-gateway`'s oauth-start reads `deriv_applications`, but
-- the one-app-per-tenant rework writes `site_deriv_apps` (and `sites`). When those
-- two drift apart the admin UI shows "app linked" while the login path finds no
-- application at all and reports that the platform is still being configured.
--
-- Confirmed on 2026-11-19: clinchy and dtrader both had site_deriv_apps rows and
-- sites.platform_deriv_app_id set to NULL, with zero deriv_applications rows, so
-- public-site-config emitted deriv.appId absent and login had nothing to use.
--
-- This migration repairs the drift from the *binding* side only: it never picks a
-- pool app on its own, so it cannot begin pooling two tenants' markup. It rebuilds
-- `deriv_applications` and the denormalised `sites.platform_deriv_app_id` from the
-- app each site is already bound to.
--
-- `bind_platform_deriv_app_to_site` already keeps all three tables in step. This
-- migration exists for sites that were bound before it, and adds a resync RPC so
-- the same repair can be re-run from the admin page without a deploy.

-- ---------------------------------------------------------------------------
-- Resync one site from its current binding.
-- ---------------------------------------------------------------------------
create or replace function public.resync_bound_deriv_application(_site_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  target_site public.sites%rowtype;
  binding public.site_deriv_apps%rowtype;
  pool_app public.platform_deriv_apps%rowtype;
  merged_scopes text[];
begin
  if _site_id is null then
    raise exception 'Site ID is required';
  end if;

  if auth.uid() is not null and not public.is_platform_admin(auth.uid()) then
    raise exception 'Platform admin permission required';
  end if;

  select * into target_site from public.sites where id = _site_id;
  if not found then
    raise exception 'Site not found';
  end if;

  -- The binding is the source of truth. Without one there is nothing to resync,
  -- and inventing an app here would be exactly the shared-pool behaviour this
  -- whole design rules out.
  select * into binding from public.site_deriv_apps where site_id = _site_id;
  if not found or binding.platform_deriv_app_id is null then
    return jsonb_build_object('status', 'unbound', 'siteId', _site_id);
  end if;

  select * into pool_app from public.platform_deriv_apps
   where id = binding.platform_deriv_app_id;
  if not found then
    raise exception 'Bound Deriv pool app no longer exists';
  end if;

  -- Never let one app attribute two tenants.
  if exists (
    select 1 from public.sites
     where id <> _site_id
       and status <> 'deleted'
       and platform_deriv_app_id = pool_app.id
  ) then
    raise exception 'This Deriv app is already assigned to another site';
  end if;

  -- site_deriv_apps carries no scope list; the pool app's configured_scopes are
  -- the authority, and 'trade' is the floor every tenant needs.
  select array(
    select distinct s
      from unnest(
        coalesce(pool_app.configured_scopes, array['trade']::text[])
        || array['trade']::text[]
      ) as s
     where s is not null and s <> ''
  ) into merged_scopes;
  if merged_scopes is null or cardinality(merged_scopes) = 0 then
    merged_scopes := array['trade']::text[];
  end if;

  -- sites: restore the denormalised pointer the login path checks.
  update public.sites
     set platform_deriv_app_id = pool_app.id,
         deriv_mode = 'platform_managed',
         requested_markup_rate = coalesce(binding.markup_percentage, requested_markup_rate, 2.50),
         updated_at = now()
   where id = _site_id;

  -- deriv_applications: the table the gateway actually reads. UNIQUE (site_id)
  -- makes this idempotent.
  insert into public.deriv_applications (
    organisation_id, site_id, app_id, oauth_client_id, environment,
    callback_uri, configured_scopes, markup_rate, verification_status,
    source_type, platform_deriv_app_id, updated_at
  ) values (
    target_site.organisation_id, _site_id, pool_app.app_id, pool_app.oauth_client_id,
    pool_app.environment, pool_app.callback_uri, merged_scopes,
    coalesce(pool_app.markup_percentage, binding.markup_percentage, 2.50),
    'verified', 'platform_managed', pool_app.id, now()
  )
  on conflict (site_id) do update set
    app_id = excluded.app_id,
    oauth_client_id = excluded.oauth_client_id,
    environment = excluded.environment,
    callback_uri = excluded.callback_uri,
    configured_scopes = excluded.configured_scopes,
    markup_rate = excluded.markup_rate,
    verification_status = 'verified',
    source_type = 'platform_managed',
    platform_deriv_app_id = excluded.platform_deriv_app_id,
    updated_at = now();

  return jsonb_build_object(
    'status', 'resynced',
    'siteId', _site_id,
    'appId', pool_app.app_id,
    'oauthClientId', pool_app.oauth_client_id,
    'configuredScopes', merged_scopes
  );
end;
$$;

revoke all on function public.resync_bound_deriv_application(uuid) from public;
grant execute on function public.resync_bound_deriv_application(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Resync every drifter, so the fix does not depend on someone clicking a button.
-- ---------------------------------------------------------------------------
create or replace function public.resync_all_bound_deriv_applications()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  drift record;
  fixed integer := 0;
begin
  if auth.uid() is not null and not public.is_platform_admin(auth.uid()) then
    raise exception 'Platform admin permission required';
  end if;

  for drift in
    select s.id
      from public.sites s
      join public.site_deriv_apps sda on sda.site_id = s.id
      left join public.deriv_applications da on da.site_id = s.id
     where s.status <> 'deleted'
       and sda.platform_deriv_app_id is not null
       -- Missing, or pointing at a different app than the binding records.
       and (
         da.site_id is null
         or da.platform_deriv_app_id is distinct from sda.platform_deriv_app_id
         or s.platform_deriv_app_id is distinct from sda.platform_deriv_app_id
       )
  loop
    begin
      perform public.resync_bound_deriv_application(drift.id);
      fixed := fixed + 1;
    exception when others then
      -- One tenant must not abort the sweep; the next admin action reports it.
      raise warning 'resync skipped for site %: %', drift.id, sqlerrm;
    end;
  end loop;

  return fixed;
end;
$$;

revoke all on function public.resync_all_bound_deriv_applications() from public;
grant execute on function public.resync_all_bound_deriv_applications() to authenticated, service_role;

comment on function public.resync_bound_deriv_application(uuid) is
  'Rebuild deriv_applications (and sites.platform_deriv_app_id) for one site from its existing site_deriv_apps binding. Never selects an app, so it cannot pool two tenants.';

comment on function public.resync_all_bound_deriv_applications() is
  'Sweep every platform-managed site whose deriv_applications row is missing or points at a different app than its binding.';
