-- Remove the remaining legacy Deriv surfaces from the platform.
--
-- The platform is now new-API only: OAuth 2.0 via auth.deriv.com, API via
-- api.derivws.com. Three legacy concepts are dropped:
--
-- 1. `legacy_app_id` on the pool. It identified an app on the old numeric app_id
--    system. The new platform issues alphanumeric OAuth 2.0 client IDs, and the
--    column was only consulted to decide `include_legacy_app_id_in_oauth`.
-- 2. `use_legacy_oauth_login` / `include_legacy_app_id_in_oauth` on
--    site_deriv_apps. Both selected the legacy JSON-RPC login path
--    (oauth.deriv.com + app_id), which the platform no longer uses anywhere:
--    login always goes through auth.deriv.com with PKCE.
--
-- All three were always written as false/null, so dropping them is behaviour
-- preserving for every site.
--
-- app_register / app_list / app_update / app_markup_details are NOT restored by
-- anything here. They are legacy-only WebSocket methods, unreachable from server
-- networks, and the new platform has no equivalent.

-- 1. Pool: drop the legacy app id.
alter table public.platform_deriv_apps
  drop column if exists legacy_app_id;

-- 2. Site app config: drop the legacy login toggles.
alter table public.site_deriv_apps
  drop column if exists use_legacy_oauth_login;

alter table public.site_deriv_apps
  drop column if exists include_legacy_app_id_in_oauth;

-- 3. The pool->site binder referenced legacy_app_id when deciding
--    include_legacy_app_id_in_oauth. Re-create it with that column gone and the
--    flag pinned to false, keeping everything else identical.
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
as $function$

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

  -- Sharing one app across sites is allowed on purpose: per-tenant app
  -- registration is not available, so a one-app pool has to serve everyone.

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
    deriv_mode, markup_percentage, platform_deriv_app_id, updated_at
  ) values (
    _site_id, chosen_app.app_id, chosen_app.oauth_client_id, chosen_app.callback_uri,
    'platform_managed', clamped_markup, chosen_app.id, now()
  )
  on conflict (site_id) do update set
    deriv_app_id = excluded.deriv_app_id,
    oauth_client_id = excluded.oauth_client_id,
    redirect_uri = excluded.redirect_uri,
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
    'ownerShareRate', round(100.00 - fee_rate, 2),
    'sharedApp', true
  );
end;
$function$;

comment on function public.bind_platform_deriv_app_to_site(uuid, uuid, numeric, text[]) is
  'Binds a new-platform OAuth 2.0 app to a site. The app MAY be shared by several sites: per-tenant app registration is unavailable, so a one-app pool serves every site. Per-site markup is recorded per row, but Deriv tracks markup per app, so totals are not separable by site.';
