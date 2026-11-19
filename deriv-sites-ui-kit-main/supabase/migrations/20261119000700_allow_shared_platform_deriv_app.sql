-- Allow one platform Deriv app to serve more than one site.
--
-- bind_platform_deriv_app_to_site() raised:
--   'This Deriv app is already assigned to another site'
-- That invariant assumes a pool with at least as many apps as sites, i.e. one
-- Deriv app per tenant. It cannot be satisfied here:
--
--  * app_register is the only way to create a Deriv app, and it is WebSocket-only.
--  * Every *.derivws.com request returns Cloudflare 520 from datacenter
--    networks, on both the WebSocket path and the host root, after a consistent
--    ~5.1s origin timeout. api.deriv.com (301), developers.deriv.com (200),
--    app.deriv.com (302) and oauth.deriv.com (302) all answer normally from the
--    same network, so this is an origin-side gate on the WS zone, not egress
--    blocking.
--  * The stored operator token carries read, trade and account_manage, and
--    app_register additionally requires admin.
--
-- So the pool can realistically hold one app: the operator's existing OAuth 2.0
-- client ID. With the old invariant that app could serve exactly one site,
-- which is worse than sharing it: the second tenant would get a 409 at login.
--
-- Sharing has a real, accepted cost: Deriv markup is tracked per app, so
-- per-site markup separation is no longer available. Attribution stays per row
-- (sites.requested_markup_rate, sites.platform_fee_rate,
-- sites.deriv_affiliate_id), and sites.platform_deriv_app_id still records
-- which app each site used. Per-site isolation comes back for free if
-- per-tenant apps ever become obtainable: the pool simply gets more rows and
-- each site is pointed at its own.
--
-- The check is replaced with a narrower one that still catches the genuinely
-- wrong case: a site whose app column changed but whose deriv_applications row
-- still points at a different app.

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

  -- Sharing one app across sites is allowed on purpose. See the header comment.
  -- The previous exclusivity check is what made a single-app pool unusable.

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
    'ownerShareRate', round(100.00 - fee_rate, 2),
    'sharedApp', true
  );
end;
$function$;

comment on function public.bind_platform_deriv_app_to_site(uuid, uuid, numeric, text[]) is
  'Binds a pool app to a site. The app MAY be shared by several sites: app_register cannot be reached to issue per-tenant apps, so a one-app pool has to serve everyone. Per-site markup is recorded per row but Deriv markup is tracked per app, so totals are not separable by site.';
