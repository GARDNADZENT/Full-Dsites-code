-- One Deriv app per tenant site.
--
-- The platform owner is the payer and the DevHub account holder: every tenant's
-- markup accrues to one account, and the owner then pays each tenant their share
-- after deducting the platform fee (default 17%). That split is only auditable if
-- each tenant's traffic is attributable to that tenant's own Deriv app, so app
-- assignment must be per site and must never be silently re-pointed afterwards.
--
-- `assign_platform_deriv_app_to_site` picks the closest-markup app from the pool,
-- which is correct for filling an unassigned site but wrong for an assigned one:
-- it would move a tenant's traffic onto another tenant's app. This migration adds
-- a binding RPC (idempotent, per-site) and repairs sites whose binding was
-- overridden to something other than the app their `site_deriv_apps` row records.

-- Pin a specific pool app to a specific site. Used for both automatic
-- registration (from manage-platform-deriv) and manual assignment (admin UI).
create or replace function public.bind_platform_deriv_app_to_site(
  _site_id uuid,
  _platform_deriv_app_id uuid,
  _markup_percentage numeric default 2.50,
  _scopes text[] default array['trade']::text[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  target_site public.sites%rowtype;
  chosen_app public.platform_deriv_apps%rowtype;
  clamped_markup numeric(5,2);
  merged_scopes text[];
  fee_rate numeric(5,2);
begin
  if _site_id is null then
    raise exception 'Site ID is required';
  end if;
  if _platform_deriv_app_id is null then
    raise exception 'Platform Deriv app ID is required';
  end if;

  select * into target_site from public.sites where id = _site_id;
  if not found then
    raise exception 'Site not found';
  end if;

  if auth.uid() is not null and not public.is_platform_admin(auth.uid()) then
    raise exception 'Platform admin permission required';
  end if;

  select * into chosen_app from public.platform_deriv_apps where id = _platform_deriv_app_id;
  if not found then
    raise exception 'Deriv pool app not found';
  end if;

  -- Only one site may own a given app; a shared app would pool two tenants' markup.
  if exists (
    select 1 from public.sites
     where id <> _site_id
       and status <> 'deleted'
       and platform_deriv_app_id = _platform_deriv_app_id
  ) then
    raise exception 'This Deriv app is already assigned to another site';
  end if;

  clamped_markup := round(least(3.00, greatest(0.00, coalesce(_markup_percentage, 2.50))), 2);
  fee_rate := coalesce(target_site.platform_fee_rate, 17.00);

  select array(
    select distinct s
      from unnest(
        coalesce(chosen_app.configured_scopes, array['trade']::text[])
        || coalesce(_scopes, array['trade']::text[])
      ) as s
     where s is not null and s <> ''
  ) into merged_scopes;

  update public.sites
     set deriv_mode = 'platform_managed',
         platform_deriv_app_id = chosen_app.id,
         requested_markup_rate = clamped_markup,
         platform_fee_rate = fee_rate,
         updated_at = now()
   where id = _site_id;

  insert into public.deriv_applications (
    organisation_id, site_id, app_id, oauth_client_id, environment,
    callback_uri, configured_scopes, markup_rate, verification_status,
    source_type, platform_deriv_app_id, updated_at
  ) values (
    target_site.organisation_id, _site_id, chosen_app.app_id, chosen_app.oauth_client_id,
    chosen_app.environment, chosen_app.callback_uri, merged_scopes,
    coalesce(chosen_app.markup_percentage, clamped_markup), 'verified', 'platform_managed',
    chosen_app.id, now()
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

  insert into public.site_deriv_apps (
    site_id, deriv_app_id, oauth_client_id, redirect_uri,
    use_legacy_oauth_login, include_legacy_app_id_in_oauth,
    deriv_mode, markup_percentage, platform_deriv_app_id, updated_at
  ) values (
    _site_id, chosen_app.app_id, chosen_app.oauth_client_id, chosen_app.callback_uri,
    false, chosen_app.legacy_app_id is not null,
    'platform_managed', clamped_markup, chosen_app.id, now()
  )
  on conflict (site_id) do update set
    deriv_app_id = excluded.deriv_app_id,
    oauth_client_id = excluded.oauth_client_id,
    redirect_uri = excluded.redirect_uri,
    use_legacy_oauth_login = false,
    include_legacy_app_id_in_oauth = excluded.include_legacy_app_id_in_oauth,
    deriv_mode = 'platform_managed',
    markup_percentage = excluded.markup_percentage,
    platform_deriv_app_id = excluded.platform_deriv_app_id,
    updated_at = now();

  return jsonb_build_object(
    'status', 'bound',
    'siteId', _site_id,
    'platformDerivAppId', chosen_app.id,
    'appId', chosen_app.app_id,
    'oauthClientId', chosen_app.oauth_client_id,
    'callbackUri', chosen_app.callback_uri,
    'requestedMarkupRate', clamped_markup,
    'platformFeeRate', fee_rate,
    'ownerShareRate', round(100.00 - fee_rate, 2)
  );
end;
$$;

revoke all on function public.bind_platform_deriv_app_to_site(uuid, uuid, numeric, text[]) from public;
grant execute on function public.bind_platform_deriv_app_to_site(uuid, uuid, numeric, text[]) to authenticated, service_role;

-- Repoint sites whose current app is not the one their binding row records.
-- Operates only on platform-managed sites that already hold a specific pool app,
-- so it cannot invent an assignment; it only undoes an override.
create or replace function public.repair_platform_deriv_assignments()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  row_record record;
  fixed integer := 0;
begin
  if auth.uid() is not null and not public.is_platform_admin(auth.uid()) then
    raise exception 'Platform admin permission required';
  end if;

  for row_record in
    select s.id, s.platform_deriv_app_id as current_app, sda.platform_deriv_app_id as bound_app
      from public.sites s
      join public.site_deriv_apps sda on sda.site_id = s.id
     where s.deriv_mode = 'platform_managed'
       and s.status <> 'deleted'
       and sda.platform_deriv_app_id is not null
       and s.platform_deriv_app_id is distinct from sda.platform_deriv_app_id
       -- Never steal an app that another live site is legitimately using.
       and not exists (
         select 1 from public.sites other
          where other.id <> s.id
            and other.status <> 'deleted'
            and other.platform_deriv_app_id = sda.platform_deriv_app_id
       )
  loop
    perform public.bind_platform_deriv_app_to_site(
      row_record.id,
      row_record.bound_app,
      coalesce((select requested_markup_rate from public.sites where id = row_record.id), 2.50)
    );
    fixed := fixed + 1;
  end loop;

  return fixed;
end;
$$;

revoke all on function public.repair_platform_deriv_assignments() from public;
grant execute on function public.repair_platform_deriv_assignments() to authenticated, service_role;

-- A Deriv API token cannot outlive its validity window, and losing it silently
-- takes login down for every tenant at once. Track when it expires so the admin
-- console can warn before that happens.
alter table public.superuser_deriv_credentials
  add column if not exists api_token_valid_until timestamptz;

comment on column public.superuser_deriv_credentials.api_token_valid_until is
  'Expiry reported by Deriv when the superuser token was verified; app.deriv.com caps tokens at 90 days.';
