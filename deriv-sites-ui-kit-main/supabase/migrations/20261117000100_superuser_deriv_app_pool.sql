-- DForge-style Superuser Deriv App Pool, Central OAuth Session Handoff,
-- Per-Site Trader Attribution, and Markup Commission Split Ledger.
-- Additive and backwards-compatible with custom BYO Deriv applications.

-- 1. Superuser Deriv API/OAuth credentials (service-role only; zero browser policies).
CREATE TABLE IF NOT EXISTS public.superuser_deriv_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key TEXT NOT NULL DEFAULT 'primary' UNIQUE CHECK (singleton_key = 'primary'),
  label TEXT NOT NULL DEFAULT 'Primary Superuser Deriv Account',
  deriv_loginid TEXT,
  deriv_email TEXT,
  deriv_user_id TEXT,
  api_token_encrypted TEXT,
  api_token_scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
  oauth_access_token_encrypted TEXT,
  oauth_refresh_token_encrypted TEXT,
  oauth_expires_at TIMESTAMPTZ,
  oauth_scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
  ws_app_id TEXT NOT NULL DEFAULT '1089',
  default_callback_uri TEXT NOT NULL DEFAULT 'https://dsites-admin.vercel.app/api/deriv-oauth-callback',
  default_homepage_uri TEXT NOT NULL DEFAULT 'https://dsites-admin.vercel.app',
  default_verification_uri TEXT NOT NULL DEFAULT 'https://dsites-admin.vercel.app/auth',
  default_platform_fee_rate NUMERIC(5,2) NOT NULL DEFAULT 17.00 CHECK (default_platform_fee_rate >= 0 AND default_platform_fee_rate <= 100.00),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_verified_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Superuser-owned Tiered v2 DevHub App Pool (0% - 3% markup tiers).
CREATE TABLE IF NOT EXISTS public.platform_deriv_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  app_id TEXT NOT NULL CHECK (char_length(trim(app_id)) >= 1),
  oauth_client_id TEXT NOT NULL CHECK (char_length(trim(oauth_client_id)) >= 1),
  client_secret_encrypted TEXT,
  legacy_app_id TEXT,
  callback_uri TEXT NOT NULL DEFAULT 'https://dsites-admin.vercel.app/api/deriv-oauth-callback',
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('staging', 'production')),
  markup_percentage NUMERIC(5,2) NOT NULL DEFAULT 2.50 CHECK (markup_percentage >= 0 AND markup_percentage <= 3.00),
  configured_scopes TEXT[] NOT NULL DEFAULT ARRAY['trade', 'account_manage', 'application_read']::text[],
  registration_source TEXT NOT NULL DEFAULT 'manual' CHECK (registration_source IN ('manual', 'auto_registered', 'imported')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_platform_deriv_apps_active_markup
  ON public.platform_deriv_apps(environment, is_active, markup_percentage, is_default DESC);

-- 3. Single-use cross-domain session handoffs for central OAuth callback -> tenant first-party cookie.
CREATE TABLE IF NOT EXISTS public.oauth_session_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_hash TEXT NOT NULL UNIQUE,
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  return_path TEXT NOT NULL DEFAULT '/',
  session_token_encrypted TEXT NOT NULL,
  session_max_age INTEGER NOT NULL CHECK (session_max_age > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_session_handoffs_expiry
  ON public.oauth_session_handoffs(expires_at) WHERE consumed_at IS NULL;

-- 4. Per-site trader account attribution (maps trader CR/MF/VRTC accounts to the site they trade on).
CREATE TABLE IF NOT EXISTS public.site_trader_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  platform_deriv_app_id UUID REFERENCES public.platform_deriv_apps(id) ON DELETE SET NULL,
  deriv_app_id TEXT NOT NULL,
  deriv_loginid TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'real' CHECK (account_type IN ('real', 'demo')),
  currency TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, deriv_loginid)
);

CREATE INDEX IF NOT EXISTS idx_site_trader_attributions_lookup
  ON public.site_trader_attributions(deriv_app_id, deriv_loginid, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_trader_attributions_site
  ON public.site_trader_attributions(site_id, account_type, last_seen_at DESC);

-- 5. Per-site commission ledger splitting gross Deriv markup between superuser and site owner.
CREATE TABLE IF NOT EXISTS public.site_commission_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_transaction_id TEXT NOT NULL,
  deriv_app_id TEXT NOT NULL,
  platform_deriv_app_id UUID REFERENCES public.platform_deriv_apps(id) ON DELETE SET NULL,
  site_id UUID REFERENCES public.sites(id) ON DELETE SET NULL,
  organisation_id UUID REFERENCES public.organisations(id) ON DELETE SET NULL,
  client_loginid TEXT,
  contract_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  gross_markup_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  applied_markup_rate NUMERIC(5,2),
  platform_fee_rate NUMERIC(5,2) NOT NULL DEFAULT 17.00,
  superuser_fee_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  owner_net_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  attribution_status TEXT NOT NULL DEFAULT 'attributed' CHECK (attribution_status IN ('attributed', 'unattributed')),
  payout_status TEXT NOT NULL DEFAULT 'accrued' CHECK (payout_status IN ('accrued', 'approved', 'paid')),
  payout_reference TEXT,
  paid_at TIMESTAMPTZ,
  traded_at TIMESTAMPTZ NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  synchronized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deriv_app_id, external_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_site_commission_ledger_site_date
  ON public.site_commission_ledger(site_id, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_commission_ledger_org_date
  ON public.site_commission_ledger(organisation_id, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_commission_ledger_payout
  ON public.site_commission_ledger(payout_status, site_id);

-- 6. Additive columns on sites, deriv_applications, and site_deriv_apps.
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS deriv_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (deriv_mode IN ('platform_managed', 'custom')),
  ADD COLUMN IF NOT EXISTS platform_deriv_app_id UUID REFERENCES public.platform_deriv_apps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_markup_rate NUMERIC(5,2) NOT NULL DEFAULT 2.50
    CHECK (requested_markup_rate >= 0 AND requested_markup_rate <= 3.00),
  ADD COLUMN IF NOT EXISTS platform_fee_rate NUMERIC(5,2) NOT NULL DEFAULT 17.00
    CHECK (platform_fee_rate >= 0 AND platform_fee_rate <= 100.00),
  ADD COLUMN IF NOT EXISTS owner_deriv_loginid TEXT,
  ADD COLUMN IF NOT EXISTS created_by_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.deriv_applications
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (source_type IN ('platform_managed', 'custom')),
  ADD COLUMN IF NOT EXISTS platform_deriv_app_id UUID REFERENCES public.platform_deriv_apps(id) ON DELETE SET NULL;

ALTER TABLE public.site_deriv_apps
  ADD COLUMN IF NOT EXISTS deriv_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (deriv_mode IN ('platform_managed', 'custom')),
  ADD COLUMN IF NOT EXISTS markup_percentage NUMERIC(5,2) NOT NULL DEFAULT 2.50
    CHECK (markup_percentage >= 0 AND markup_percentage <= 3.00),
  ADD COLUMN IF NOT EXISTS platform_deriv_app_id UUID REFERENCES public.platform_deriv_apps(id) ON DELETE SET NULL;

-- Preserve any pre-existing custom site apps as custom mode.
UPDATE public.deriv_applications
SET source_type = 'custom'
WHERE platform_deriv_app_id IS NULL AND char_length(trim(app_id)) > 0;

UPDATE public.sites s
SET deriv_mode = 'custom'
FROM public.deriv_applications da
WHERE da.site_id = s.id AND da.source_type = 'custom';

-- 7. Enable strict RLS on all new tables.
ALTER TABLE public.superuser_deriv_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_deriv_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_session_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_trader_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_commission_ledger ENABLE ROW LEVEL SECURITY;

-- Site owners & admins can view trader attributions for their own organisation.
DROP POLICY IF EXISTS "Members view site trader attributions" ON public.site_trader_attributions;
CREATE POLICY "Members view site trader attributions"
  ON public.site_trader_attributions FOR SELECT TO authenticated
  USING (
    public.is_organisation_member(organisation_id, auth.uid())
    OR public.has_platform_permission(auth.uid(), 'finance.read')
  );

-- Site owners view their own site's attributed commission ledger; finance/super admins view all.
DROP POLICY IF EXISTS "Members view site commission ledger" ON public.site_commission_ledger;
CREATE POLICY "Members view site commission ledger"
  ON public.site_commission_ledger FOR SELECT TO authenticated
  USING (
    (organisation_id IS NOT NULL AND public.is_organisation_member(organisation_id, auth.uid()))
    OR public.has_platform_permission(auth.uid(), 'finance.read')
  );

-- Allow tenant editors to save custom BYO deriv_applications rows safely when deriv_mode = 'custom'.
DROP POLICY IF EXISTS "Editors manage custom Deriv applications" ON public.deriv_applications;
CREATE POLICY "Editors manage custom Deriv applications"
  ON public.deriv_applications FOR ALL TO authenticated
  USING (
    public.has_organisation_role(
      organisation_id,
      auth.uid(),
      ARRAY['tenant_owner', 'tenant_developer']::public.platform_role[]
    )
    OR public.is_platform_admin(auth.uid())
  )
  WITH CHECK (
    public.has_organisation_role(
      organisation_id,
      auth.uid(),
      ARRAY['tenant_owner', 'tenant_developer']::public.platform_role[]
    )
    OR public.is_platform_admin(auth.uid())
  );

-- 8. Safe public-to-authenticated pool status RPC (exposes zero secrets).
CREATE OR REPLACE FUNCTION public.get_platform_deriv_pool_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pool_count INTEGER;
  default_app RECORD;
  tiers NUMERIC[];
  cred RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT count(*)::integer,
         COALESCE(array_agg(DISTINCT markup_percentage ORDER BY markup_percentage), '{}'::numeric[])
    INTO pool_count, tiers
    FROM public.platform_deriv_apps
   WHERE is_active = true;

  SELECT app_id, name, markup_percentage, callback_uri, environment
    INTO default_app
    FROM public.platform_deriv_apps
   WHERE is_active = true
   ORDER BY is_default DESC, ABS(markup_percentage - 2.50) ASC, created_at ASC
   LIMIT 1;

  SELECT deriv_loginid,
         default_callback_uri,
         default_platform_fee_rate,
         (api_token_encrypted IS NOT NULL OR oauth_access_token_encrypted IS NOT NULL) AS is_connected
    INTO cred
    FROM public.superuser_deriv_credentials
   WHERE singleton_key = 'primary'
   LIMIT 1;

  RETURN jsonb_build_object(
    'poolReady', pool_count > 0,
    'activeAppCount', pool_count,
    'defaultMarkup', COALESCE(default_app.markup_percentage, 2.50),
    'defaultAppId', default_app.app_id,
    'defaultAppName', default_app.name,
    'minMarkup', 0,
    'maxMarkup', 3,
    'recommendedMin', 2,
    'recommendedMax', 3,
    'availableTiers', to_jsonb(tiers),
    'centralCallbackUri', COALESCE(default_app.callback_uri, cred.default_callback_uri, 'https://dsites-admin.vercel.app/api/deriv-oauth-callback'),
    'defaultPlatformFeeRate', COALESCE(cred.default_platform_fee_rate, 17.00),
    'superuserConnected', COALESCE(cred.is_connected, false) OR pool_count > 0,
    'superuserLoginId', cred.deriv_loginid
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_deriv_pool_status() TO authenticated;

-- 9. Assign closest active superuser Deriv pool app to a site (used by SiteWizard & Site Editor).
CREATE OR REPLACE FUNCTION public.assign_platform_deriv_app_to_site(
  _site_id UUID,
  _markup_percentage NUMERIC DEFAULT 2.50,
  _environment TEXT DEFAULT 'production',
  _scopes TEXT[] DEFAULT ARRAY['trade']::text[],
  _plan TEXT DEFAULT NULL,
  _owner_deriv_loginid TEXT DEFAULT NULL,
  _deriv_affiliate_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_site public.sites%ROWTYPE;
  chosen_app public.platform_deriv_apps%ROWTYPE;
  clamped_markup NUMERIC(5,2);
  safe_env TEXT;
  fee_rate NUMERIC(5,2);
  default_fee NUMERIC(5,2);
  merged_scopes TEXT[];
  clean_loginid TEXT;
  clean_affiliate TEXT;
BEGIN
  IF _site_id IS NULL THEN
    RAISE EXCEPTION 'Site ID is required';
  END IF;

  SELECT * INTO target_site FROM public.sites WHERE id = _site_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Site not found';
  END IF;

  -- Enforce caller permissions when invoked by an authenticated user (service_role has auth.uid() IS NULL).
  IF auth.uid() IS NOT NULL THEN
    IF target_site.user_id <> auth.uid()
       AND NOT public.has_organisation_role(
         target_site.organisation_id,
         auth.uid(),
         ARRAY['tenant_owner', 'tenant_developer']::public.platform_role[]
       )
       AND NOT public.is_platform_admin(auth.uid()) THEN
      RAISE EXCEPTION 'You do not have permission to update this site';
    END IF;
  END IF;

  clamped_markup := ROUND(LEAST(3.00, GREATEST(0.00, COALESCE(_markup_percentage, 2.50))), 2);
  safe_env := CASE WHEN _environment = 'staging' THEN 'staging' ELSE 'production' END;

  SELECT COALESCE(default_platform_fee_rate, 17.00)
    INTO default_fee
    FROM public.superuser_deriv_credentials
   WHERE singleton_key = 'primary'
   LIMIT 1;
  default_fee := COALESCE(default_fee, 17.00);

  fee_rate := CASE
    WHEN _plan = 'one_time' THEN 0.00
    WHEN _plan = 'partnership_monthly' THEN default_fee
    ELSE COALESCE(target_site.platform_fee_rate, default_fee)
  END;

  clean_loginid := CASE
    WHEN _owner_deriv_loginid IS NULL THEN target_site.owner_deriv_loginid
    ELSE NULLIF(UPPER(TRIM(_owner_deriv_loginid)), '')
  END;
  clean_affiliate := CASE
    WHEN _deriv_affiliate_id IS NULL THEN target_site.deriv_affiliate_id
    ELSE NULLIF(TRIM(_deriv_affiliate_id), '')
  END;

  -- Pick closest active pool app matching environment (fall back to any active app if staging has none).
  SELECT *
    INTO chosen_app
    FROM public.platform_deriv_apps
   WHERE is_active = true
   ORDER BY
     (CASE WHEN environment = safe_env THEN 0 ELSE 1 END) ASC,
     ABS(markup_percentage - clamped_markup) ASC,
     is_default DESC,
     created_at ASC
   LIMIT 1;

  IF FOUND THEN
    SELECT ARRAY(
      SELECT DISTINCT s
      FROM unnest(
        COALESCE(chosen_app.configured_scopes, ARRAY['trade']::text[]) ||
        COALESCE(_scopes, ARRAY['trade']::text[])
      ) AS s
      WHERE s IS NOT NULL AND s <> ''
    ) INTO merged_scopes;

    UPDATE public.sites
       SET deriv_mode = 'platform_managed',
           platform_deriv_app_id = chosen_app.id,
           requested_markup_rate = clamped_markup,
           platform_fee_rate = fee_rate,
           owner_deriv_loginid = clean_loginid,
           deriv_affiliate_id = clean_affiliate,
           updated_at = now()
     WHERE id = _site_id;

    INSERT INTO public.deriv_applications (
      organisation_id,
      site_id,
      app_id,
      oauth_client_id,
      environment,
      callback_uri,
      configured_scopes,
      markup_rate,
      verification_status,
      source_type,
      platform_deriv_app_id,
      updated_at
    ) VALUES (
      target_site.organisation_id,
      _site_id,
      chosen_app.app_id,
      chosen_app.oauth_client_id,
      chosen_app.environment,
      chosen_app.callback_uri,
      merged_scopes,
      chosen_app.markup_percentage,
      'verified',
      'platform_managed',
      chosen_app.id,
      now()
    )
    ON CONFLICT (site_id) DO UPDATE SET
      app_id = EXCLUDED.app_id,
      oauth_client_id = EXCLUDED.oauth_client_id,
      environment = EXCLUDED.environment,
      callback_uri = EXCLUDED.callback_uri,
      configured_scopes = EXCLUDED.configured_scopes,
      markup_rate = EXCLUDED.markup_rate,
      verification_status = 'verified',
      source_type = 'platform_managed',
      platform_deriv_app_id = EXCLUDED.platform_deriv_app_id,
      updated_at = now();

    INSERT INTO public.site_deriv_apps (
      site_id,
      deriv_app_id,
      oauth_client_id,
      redirect_uri,
      use_legacy_oauth_login,
      include_legacy_app_id_in_oauth,
      deriv_mode,
      markup_percentage,
      platform_deriv_app_id,
      updated_at
    ) VALUES (
      _site_id,
      chosen_app.app_id,
      chosen_app.oauth_client_id,
      chosen_app.callback_uri,
      false,
      chosen_app.legacy_app_id IS NOT NULL,
      'platform_managed',
      clamped_markup,
      chosen_app.id,
      now()
    )
    ON CONFLICT (site_id) DO UPDATE SET
      deriv_app_id = EXCLUDED.deriv_app_id,
      oauth_client_id = EXCLUDED.oauth_client_id,
      redirect_uri = EXCLUDED.redirect_uri,
      use_legacy_oauth_login = false,
      include_legacy_app_id_in_oauth = EXCLUDED.include_legacy_app_id_in_oauth,
      deriv_mode = 'platform_managed',
      markup_percentage = EXCLUDED.markup_percentage,
      platform_deriv_app_id = EXCLUDED.platform_deriv_app_id,
      updated_at = now();

    RETURN jsonb_build_object(
      'status', 'assigned',
      'platformDerivAppId', chosen_app.id,
      'appId', chosen_app.app_id,
      'oauthClientId', chosen_app.oauth_client_id,
      'callbackUri', chosen_app.callback_uri,
      'poolAppName', chosen_app.name,
      'requestedMarkupRate', clamped_markup,
      'appliedMarkupRate', chosen_app.markup_percentage,
      'platformFeeRate', fee_rate,
      'ownerShareRate', ROUND(100.00 - fee_rate, 2)
    );
  ELSE
    -- Superuser pool has no active app yet: save desired markup cleanly so the site
    -- validates immediately and auto-binds the moment the superuser adds/generates a pool app.
    UPDATE public.sites
       SET deriv_mode = 'platform_managed',
           platform_deriv_app_id = NULL,
           requested_markup_rate = clamped_markup,
           platform_fee_rate = fee_rate,
           owner_deriv_loginid = clean_loginid,
           deriv_affiliate_id = clean_affiliate,
           updated_at = now()
     WHERE id = _site_id;

    INSERT INTO public.site_deriv_apps (
      site_id,
      deriv_app_id,
      oauth_client_id,
      redirect_uri,
      use_legacy_oauth_login,
      include_legacy_app_id_in_oauth,
      deriv_mode,
      markup_percentage,
      platform_deriv_app_id,
      updated_at
    ) VALUES (
      _site_id,
      NULL,
      NULL,
      'https://dsites-admin.vercel.app/api/deriv-oauth-callback',
      false,
      false,
      'platform_managed',
      clamped_markup,
      NULL,
      now()
    )
    ON CONFLICT (site_id) DO UPDATE SET
      deriv_mode = 'platform_managed',
      markup_percentage = EXCLUDED.markup_percentage,
      platform_deriv_app_id = NULL,
      redirect_uri = 'https://dsites-admin.vercel.app/api/deriv-oauth-callback',
      updated_at = now();

    DELETE FROM public.deriv_applications
     WHERE site_id = _site_id AND source_type = 'platform_managed';

    RETURN jsonb_build_object(
      'status', 'queued_for_pool',
      'platformDerivAppId', NULL,
      'appId', NULL,
      'oauthClientId', NULL,
      'callbackUri', 'https://dsites-admin.vercel.app/api/deriv-oauth-callback',
      'requestedMarkupRate', clamped_markup,
      'appliedMarkupRate', clamped_markup,
      'platformFeeRate', fee_rate,
      'ownerShareRate', ROUND(100.00 - fee_rate, 2)
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_platform_deriv_app_to_site(UUID, NUMERIC, TEXT, TEXT[], TEXT, TEXT, TEXT) TO authenticated;

-- 10. Rebalance all platform_managed sites whenever superuser updates the Deriv App pool.
CREATE OR REPLACE FUNCTION public.rebalance_platform_deriv_assignments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  site_row RECORD;
  updated_count INTEGER := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Platform admin permission required';
  END IF;

  FOR site_row IN
    SELECT id, requested_markup_rate
      FROM public.sites
     WHERE deriv_mode = 'platform_managed'
  LOOP
    PERFORM public.assign_platform_deriv_app_to_site(
      site_row.id,
      COALESCE(site_row.requested_markup_rate, 2.50),
      'production',
      ARRAY['trade', 'account_manage']::text[]
    );
    updated_count := updated_count + 1;
  END LOOP;

  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebalance_platform_deriv_assignments() TO authenticated;
