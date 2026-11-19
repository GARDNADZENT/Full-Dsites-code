import { createClient } from "npm:@supabase/supabase-js@2";

// --- _shared/crypto.ts ---
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const fromBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
};

const randomSecret = (length = 32) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
};

const encryptionKey = async () => {
  const configured = Deno.env.get('TOKEN_ENCRYPTION_KEY');
  if (!configured) throw new Error('TOKEN_ENCRYPTION_KEY is missing');
  const raw = fromBase64Url(configured);
  if (raw.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

async function encryptSecret(value: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), encoder.encode(value));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptSecret(value: string): Promise<string> {
  const [version, iv, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !encrypted) throw new Error('Encrypted value is invalid');
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv) },
    await encryptionKey(),
    fromBase64Url(encrypted),
  );
  return decoder.decode(clear);
}

// --- _shared/http.ts ---

const supabaseAdmin = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service configuration is missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

const correlationId = () => crypto.randomUUID();

const normalizeOrigin = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
};

const extractRequestOrigin = (req: Request): string | null => {
  const explicitOrigin = normalizeOrigin(req.headers.get('origin'));
  if (explicitOrigin) return explicitOrigin;

  // Browsers omit the Origin header on same-origin GET/HEAD requests proxied
  // through Vercel/Netlify `/api/*` rewrites. Derive it safely from Referer or
  // X-Forwarded-Host only when Sec-Fetch-Site isn't cross-site, then enforce
  // the exact same database allowlist below.
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;

  const fetchSite = req.headers.get('sec-fetch-site')?.toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return null;

  const refererOrigin = normalizeOrigin(req.headers.get('referer'));
  if (refererOrigin) return refererOrigin;

  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  if (!forwardedHost || !/^[a-z0-9.-]+(?::\d+)?$/.test(forwardedHost)) return null;

  const rawProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(forwardedHost);
  const proto = rawProto === 'http' && isLocalHost && Deno.env.get('ENVIRONMENT') !== 'production' ? 'http' : 'https';
  if (rawProto && rawProto !== 'https' && proto !== 'http') return null;

  return normalizeOrigin(`${proto}://${forwardedHost}`);
};

async function resolveAllowedOrigin(req: Request, requestedSiteId?: string | null): Promise<string | null> {
  const origin = extractRequestOrigin(req);
  if (!origin) return null;

  const parsed = new URL(origin);
  if (Deno.env.get('ENVIRONMENT') !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    return origin;
  }

  const admin = supabaseAdmin();
  const { data: domain } = await admin
    .from('site_domains')
    .select('site_id')
    .eq('hostname', parsed.hostname.toLowerCase())
    .in('status', ['verified', 'active'])
    .maybeSingle();

  if (domain && (!requestedSiteId || domain.site_id === requestedSiteId)) return origin;

  const { data: integration } = await admin
    .from('site_integrations')
    .select('site_id, netlify_site_url')
    .eq('site_id', requestedSiteId || domain?.site_id || '00000000-0000-0000-0000-000000000000')
    .maybeSingle();
  if (integration?.netlify_site_url && normalizeOrigin(integration.netlify_site_url) === origin) return origin;

  const configured = (Deno.env.get('TRADER_CORS_ORIGINS') || '')
    .split(',')
    .map(item => normalizeOrigin(item.trim()))
    .filter(Boolean);
  const platformOrigin = normalizeOrigin(Deno.env.get('PLATFORM_BASE_URL') || '');
  return configured.includes(origin) || platformOrigin === origin ? origin : null;
}

const corsHeaders = (origin: string | null) => ({
  ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-reef-site-id, x-csrf-token, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});

const json = (body: unknown, status: number, origin: string | null, extraHeaders: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });

const safeError = (code: string, message: string, id: string) => ({
  error: { code, message },
  correlationId: id,
});

async function audit(input: {
  organisationId?: string | null;
  siteId?: string | null;
  actorUserId?: string | null;
  actorType: 'platform_owner' | 'platform_admin' | 'trader' | 'system' | 'provider';
  action: string;
  targetType?: string;
  targetId?: string;
  provider?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin().from('audit_logs').insert({
      organisation_id: input.organisationId || null,
      site_id: input.siteId || null,
      actor_user_id: input.actorUserId || null,
      actor_type: input.actorType,
      action: input.action,
      target_type: input.targetType || null,
      target_id: input.targetId || null,
      provider: input.provider || null,
      correlation_id: input.correlationId,
      metadata: input.metadata || {},
    });
  } catch (error) {
    console.error('audit write failed', { correlationId: input.correlationId, error });
  }
}

// --- _shared/deriv.ts ---
const DERIV_AUTHORIZATION_URL = 'https://auth.deriv.com/oauth2/auth';
const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const DERIV_API_BASE_URL = 'https://api.derivws.com';
const KNOWN_SCOPES = ['trade', 'account_manage', 'payment', 'application_read'] as const;

type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

const parseError = async (response: Response) => {
  const body = await response.json().catch(() => ({}));
  const first = body?.errors?.[0];
  return {
    status: response.status,
    code: first?.code || body?.error || 'DerivRequestFailed',
    message: first?.message || body?.error_description || `Deriv request failed (${response.status})`,
  };
};

async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  clientSecret?: string | null;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) params.set('client_secret', input.clientSecret);
  const response = await fetch(DERIV_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
  });
  if (!response.ok) throw Object.assign(new Error('Deriv token exchange failed'), await parseError(response));
  return await response.json();
}

async function getValidAccessToken(record: {
  id: string;
  access_token_encrypted: string;
  refresh_token_encrypted?: string | null;
  expires_at: string;
  token_type: string;
  scopes: string[];
}, application: { oauth_client_id: string }, table: 'encrypted_token_records' | 'owner_deriv_connections' = 'encrypted_token_records'): Promise<string> {
  if (Date.parse(record.expires_at) > Date.now() + 60_000) return decryptSecret(record.access_token_encrypted);

  // Deriv issues no refresh token to third-party apps: the token response has no
  // refresh_token field, and sending grant_type=refresh_token never returns one.
  // Expired really does mean re-authorization, so this is reported as such rather
  // than attempting an exchange that can only fail.
  throw Object.assign(new Error('Deriv sign-in has expired, log in again'), {
    code: 'session_expired',
    status: 401,
  });
}

async function derivRequest<T>(path: string, input: {
  accessToken: string;
  appId: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${DERIV_API_BASE_URL}${path}`, {
    method: input.method || 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Deriv-App-ID': input.appId,
      Accept: 'application/json',
      ...(input.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  if (!response.ok) throw Object.assign(new Error('Deriv API request failed'), await parseError(response));
  return await response.json();
}

// --- _shared/trader-session.ts ---
const readCookie = (req: Request, name: string) => {
  const cookie = req.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
};

const traderCookie = (value: string, maxAge: number) =>
  `reef_trader_session=${encodeURIComponent(value)}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const clearTraderCookie = () =>
  'reef_trader_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

async function requireTraderSession(req: Request, requireCsrf = false) {
  const siteId = req.headers.get('x-reef-site-id');
  if (!siteId) throw Object.assign(new Error('Site identifier is required'), { code: 'site_required', status: 400 });
  const origin = await resolveAllowedOrigin(req, siteId);
  if (!origin) throw Object.assign(new Error('Origin is not allowed for this site'), { code: 'origin_denied', status: 403 });
  const rawSession = readCookie(req, 'reef_trader_session');
  if (!rawSession) throw Object.assign(new Error('Trader authentication is required'), { code: 'not_authenticated', status: 401 });

  const admin = supabaseAdmin();
  const { data: session } = await admin
    .from('trader_sessions')
    .select('*, token:encrypted_token_records(*, application:deriv_applications(*)), site:sites(id, organisation_id, status, deployment_disabled)')
    .eq('session_hash', await sha256(rawSession))
    .eq('site_id', siteId)
    .eq('origin', origin)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!session || session.site?.status !== 'active' || session.site?.deployment_disabled || !session.token || session.token.revoked_at || !session.token.application) {
    throw Object.assign(new Error('Trader session is invalid or expired'), { code: 'session_expired', status: 401 });
  }
  if (requireCsrf) {
    const submitted = req.headers.get('x-csrf-token');
    if (!submitted || await sha256(submitted) !== session.csrf_hash) {
      throw Object.assign(new Error('CSRF validation failed'), { code: 'csrf_invalid', status: 403 });
    }
  }
  const accessToken = await getValidAccessToken(session.token, session.token.application);
  await admin.from('trader_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', session.id);
  return { origin, session, accessToken, csrfToken: await decryptSecret(session.csrf_secret_encrypted) };
}

const redirectWithError = (origin: string, path: string, code: string, id: string) => {
  const target = new URL(path, origin);
  target.searchParams.set('auth_error', code);
  target.searchParams.set('correlation_id', id);
  return Response.redirect(target.toString(), 302);
};

const resolveRequestHostname = (req: Request, url: URL): string => {
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded.replace(/:\d+$/, '');
  return url.hostname.toLowerCase();
};

Deno.serve(async req => {
  const id = correlationId();
  const url = new URL(req.url);
  if (req.method !== 'GET') return new Response(JSON.stringify(safeError('method_not_allowed', 'Method not allowed', id)), { status: 405 });

  const admin = supabaseAdmin();

  // Cross-domain single-use session handoff: completes central superuser OAuth
  // by setting a first-party HttpOnly trader session cookie on the exact tenant domain.
  const handoffToken = url.searchParams.get('handoff');
  if (handoffToken) {
    const handoffHash = await sha256(handoffToken);
    const { data: handoff } = await admin
      .from('oauth_session_handoffs')
      .select('*')
      .eq('handoff_hash', handoffHash)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!handoff) {
      return new Response(
        JSON.stringify(safeError('handoff_invalid', 'Login session handoff is invalid or expired', id)),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    }

    const expectedHost = new URL(handoff.origin).hostname.toLowerCase();
    const requestHost = resolveRequestHostname(req, url);
    if (requestHost !== expectedHost) {
      return redirectWithError(handoff.origin, handoff.return_path, 'handoff_host_mismatch', id);
    }

    const { data: consumedHandoff } = await admin
      .from('oauth_session_handoffs')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', handoff.id)
      .is('consumed_at', null)
      .select('id');

    if (!consumedHandoff?.length) {
      return redirectWithError(handoff.origin, handoff.return_path, 'callback_replayed', id);
    }

    try {
      const rawSession = await decryptSecret(handoff.session_token_encrypted);
      const target = new URL(handoff.return_path, handoff.origin);
      target.searchParams.set('auth', 'connected');
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.toString(),
          'Set-Cookie': traderCookie(rawSession, Number(handoff.session_max_age) || 3600),
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      console.error('deriv-oauth-callback handoff failed', { correlationId: id, error });
      return redirectWithError(handoff.origin, handoff.return_path, 'handoff_failed', id);
    }
  }

  const state = url.searchParams.get('state');
  if (!state) return new Response(JSON.stringify(safeError('state_missing', 'OAuth state is missing', id)), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const { data: transaction } = await admin
    .from('deriv_oauth_transactions')
    .select('*, application:deriv_applications(*)')
    .eq('state_hash', await sha256(state))
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!transaction?.application) return new Response(JSON.stringify(safeError('state_invalid', 'OAuth state is invalid, expired, or already used', id)), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const consumedAt = new Date().toISOString();
  const { data: consumed } = await admin
    .from('deriv_oauth_transactions')
    .update({ consumed_at: consumedAt })
    .eq('id', transaction.id)
    .is('consumed_at', null)
    .select('id');
  if (!consumed?.length) return redirectWithError(transaction.origin, transaction.return_path, 'callback_replayed', id);

  const oauthError = url.searchParams.get('error');
  const oauthErrorDescription = url.searchParams.get('error_description');
  const code = url.searchParams.get('code');
  const callbackActor = transaction.actor_type === 'platform_owner' ? 'platform_owner' : 'trader';

  // Deriv returns its own error code and description here, and reporting them as
  // "login_cancelled" hid the real cause: a rejected request came back as
  // request_forbidden and looked exactly like the trader closing the window.
  // Only the documented cancellation code means the user actually cancelled.
  const CANCELLED_CODES = new Set(['access_denied', 'user_cancelled', 'login_cancelled']);
  const clientErrorCode = oauthError
    ? CANCELLED_CODES.has(oauthError)
      ? 'login_cancelled'
      : oauthError
    : null;

  if (oauthError || !code) {
    await admin
      .from('deriv_oauth_transactions')
      .update({
        deriv_error_code: oauthError ?? 'code_missing',
        deriv_error_message:
          typeof oauthErrorDescription === 'string' ? oauthErrorDescription.slice(0, 500) : null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', transaction.id);

    await audit({ organisationId: transaction.organisation_id, siteId: transaction.site_id, actorUserId: transaction.owner_user_id, actorType: callbackActor, action: `${transaction.actor_type}.oauth.denied`, provider: 'deriv', correlationId: id, metadata: { code: oauthError || 'code_missing', description: oauthErrorDescription, redirectUri: transaction.redirect_uri } });
    return redirectWithError(
      transaction.origin,
      transaction.return_path,
      clientErrorCode ?? 'code_missing',
      id,
    );
  }

  try {
    let clientSecret: string | null = null;
    if (transaction.application.platform_deriv_app_id) {
      const { data: poolApp } = await admin
        .from('platform_deriv_apps')
        .select('client_secret_encrypted')
        .eq('id', transaction.application.platform_deriv_app_id)
        .maybeSingle();
      if (poolApp?.client_secret_encrypted) {
        clientSecret = await decryptSecret(poolApp.client_secret_encrypted);
      }
    }

    const token = await exchangeAuthorizationCode({
      code,
      clientId: transaction.application.oauth_client_id,
      // Must match the authorize request exactly; the app row may have changed since.
      redirectUri: transaction.redirect_uri || transaction.application.callback_uri,
      codeVerifier: await decryptSecret(transaction.code_verifier_encrypted),
      clientSecret,
    });
    if (!token.access_token) throw new Error('Token response did not include an access token');

    const grantedScopes = token.scope ? token.scope.split(/\s+/).filter(Boolean) : transaction.requested_scopes;
    const missing = transaction.requested_scopes.filter((scope: string) => !grantedScopes.includes(scope));
    if (missing.length > 0) {
      await audit({ organisationId: transaction.organisation_id, siteId: transaction.site_id, actorType: 'trader', action: 'trader.oauth.scope_missing', provider: 'deriv', correlationId: id, metadata: { missing } });
      return redirectWithError(transaction.origin, transaction.return_path, 'required_scope_missing', id);
    }

    const tokenExpiresAt = new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString();
    const subjectHash = await sha256(token.refresh_token || token.access_token);
    if (transaction.actor_type === 'platform_owner' && transaction.owner_user_id) {
      const { error: ownerConnectionError } = await admin.from('owner_deriv_connections').upsert({
        organisation_id: transaction.organisation_id,
        site_id: transaction.site_id,
        deriv_application_id: transaction.deriv_application_id,
        owner_user_id: transaction.owner_user_id,
        subject_hash: subjectHash,
        access_token_encrypted: await encryptSecret(token.access_token),
        refresh_token_encrypted: token.refresh_token ? await encryptSecret(token.refresh_token) : null,
        token_type: token.token_type || 'Bearer',
        scopes: grantedScopes,
        expires_at: tokenExpiresAt,
        revoked_at: null,
        last_error_code: null,
      }, { onConflict: 'site_id' });
      if (ownerConnectionError) throw ownerConnectionError;
      await audit({ organisationId: transaction.organisation_id, siteId: transaction.site_id, actorUserId: transaction.owner_user_id, actorType: 'platform_owner', action: 'owner.deriv.connected', provider: 'deriv', correlationId: id, metadata: { scopes: grantedScopes } });
      const ownerTarget = new URL(transaction.return_path, transaction.origin);
      ownerTarget.searchParams.set('deriv_connection', 'connected');
      return Response.redirect(ownerTarget.toString(), 302);
    }

    const { data: tokenRecord, error: tokenError } = await admin.from('encrypted_token_records').upsert({
      organisation_id: transaction.organisation_id,
      site_id: transaction.site_id,
      deriv_application_id: transaction.deriv_application_id,
      subject_hash: subjectHash,
      access_token_encrypted: await encryptSecret(token.access_token),
      refresh_token_encrypted: token.refresh_token ? await encryptSecret(token.refresh_token) : null,
      token_type: token.token_type || 'Bearer',
      scopes: grantedScopes,
      expires_at: tokenExpiresAt,
      revoked_at: null,
    }, { onConflict: 'site_id,subject_hash' }).select('id').single();
    if (tokenError || !tokenRecord) throw tokenError || new Error('Token storage failed');

    // Best-effort trader attribution right at login time for DForge-style per-site markup commission splits.
    if (grantedScopes.includes('trade')) {
      try {
        const accountsRes = await derivRequest<{ data?: Array<Record<string, unknown>> }>('/trading/v1/options/accounts', {
          accessToken: token.access_token,
          appId: transaction.application.app_id,
        });
        const nowIso = new Date().toISOString();
        const attrRows = (Array.isArray(accountsRes?.data) ? accountsRes.data : [])
          .map(acc => ({
            site_id: transaction.site_id,
            organisation_id: transaction.organisation_id,
            platform_deriv_app_id: transaction.application.platform_deriv_app_id || null,
            deriv_app_id: transaction.application.app_id,
            deriv_loginid: String(acc.account_id || '').toUpperCase(),
            account_type: acc.account_type === 'real' ? 'real' : 'demo',
            currency: typeof acc.currency === 'string' ? acc.currency : '',
            last_seen_at: nowIso,
            updated_at: nowIso,
          }))
          .filter(row => row.deriv_loginid);
        if (attrRows.length > 0) {
          await admin.from('site_trader_attributions').upsert(attrRows, { onConflict: 'site_id,deriv_loginid' });
        }
      } catch (attrErr) {
        console.warn('deriv-oauth-callback trader attribution skipped', { correlationId: id, attrErr });
      }
    }

    const rawSession = randomSecret(48);
    const rawCsrf = randomSecret(32);
    // The trader session lasts exactly as long as the access token it wraps.
    // There is no refresh token to outlive it, so a longer cookie would only keep
    // a session that can no longer call Deriv.
    const sessionSeconds = Math.max(60, token.expires_in || 3600);
    const sessionExpiresAt = new Date(Date.now() + sessionSeconds * 1000).toISOString();
    const { error: sessionError } = await admin.from('trader_sessions').insert({
      session_hash: await sha256(rawSession),
      organisation_id: transaction.organisation_id,
      site_id: transaction.site_id,
      token_record_id: tokenRecord.id,
      origin: transaction.origin,
      csrf_hash: await sha256(rawCsrf),
      csrf_secret_encrypted: await encryptSecret(rawCsrf),
      expires_at: sessionExpiresAt,
    });
    if (sessionError) throw sessionError;

    // Positive signal for the admin preflight: Deriv accepted the redirect URI
    // and issued a token for it.
    await admin
      .from('deriv_oauth_transactions')
      .update({ resolved_at: new Date().toISOString(), deriv_error_code: null })
      .eq('id', transaction.id);

    await audit({ organisationId: transaction.organisation_id, siteId: transaction.site_id, actorType: 'trader', action: 'trader.oauth.completed', provider: 'deriv', correlationId: id, metadata: { scopes: grantedScopes, appId: transaction.application.app_id, sourceType: transaction.application.source_type || 'custom' } });

    const targetHost = new URL(transaction.origin).hostname.toLowerCase();
    const callbackHost = resolveRequestHostname(req, url);

    // If handled on the central superuser callback host (e.g. dsites-admin.vercel.app) for a
    // customer site domain (e.g. gadtrader.vercel.app or mybrand.com), issue a 60s single-use
    // handoff so the tenant domain sets its own first-party HttpOnly session cookie cleanly.
    if (callbackHost !== targetHost) {
      const rawHandoff = randomSecret(40);
      const { error: handoffErr } = await admin.from('oauth_session_handoffs').insert({
        handoff_hash: await sha256(rawHandoff),
        site_id: transaction.site_id,
        organisation_id: transaction.organisation_id,
        origin: transaction.origin,
        return_path: transaction.return_path,
        session_token_encrypted: await encryptSecret(rawSession),
        session_max_age: sessionSeconds,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      if (handoffErr) throw handoffErr;
      const handoffUrl = new URL('/api/deriv-oauth-callback', transaction.origin);
      handoffUrl.searchParams.set('handoff', rawHandoff);
      return new Response(null, {
        status: 302,
        headers: {
          Location: handoffUrl.toString(),
          'Cache-Control': 'no-store',
        },
      });
    }

    const target = new URL(transaction.return_path, transaction.origin);
    target.searchParams.set('auth', 'connected');
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        'Set-Cookie': traderCookie(rawSession, sessionSeconds),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('deriv-oauth-callback failed', { correlationId: id, error });

    // Keep Deriv's own error code and message. A redirect-URI mismatch surfaces
    // here as invalid_request with the reason in the description, and discarding
    // it made every failure look identical to the operator and to the admin
    // preflight, which reads this row to tell a registration problem apart from
    // an expired code.
    const derivError = error as { code?: string; message?: string };
    const derivErrorCode = typeof derivError?.code === 'string' ? derivError.code : null;
    const derivErrorMessage =
      typeof derivError?.message === 'string' ? derivError.message.slice(0, 500) : null;
    // Deriv's exact wording for the mismatch, per its OAuth troubleshooting guide:
    // "The 'redirect_uri' parameter does not match any of the OAuth 2.0 Client's
    // pre-registered redirect urls".
    const redirectUriRejected =
      derivErrorCode === 'invalid_request' &&
      typeof derivErrorMessage === 'string' &&
      /pre-?registered redirect url/i.test(derivErrorMessage);

    await admin
      .from('deriv_oauth_transactions')
      .update({
        deriv_error_code: derivErrorCode,
        deriv_error_message: derivErrorMessage,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', transaction.id);

    await audit({ organisationId: transaction.organisation_id, siteId: transaction.site_id, actorUserId: transaction.owner_user_id, actorType: callbackActor, action: `${transaction.actor_type}.oauth.failed`, provider: 'deriv', correlationId: id, metadata: { derivErrorCode, derivErrorMessage, redirectUri: transaction.redirect_uri } });

    return redirectWithError(
      transaction.origin,
      transaction.return_path,
      redirectUriRejected ? 'redirect_uri_not_registered' : 'token_exchange_failed',
      id,
    );
  }
});
