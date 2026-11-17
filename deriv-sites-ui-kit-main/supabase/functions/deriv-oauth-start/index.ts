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
}): Promise<TokenResponse> {
  const response = await fetch(DERIV_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
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
  if (!record.refresh_token_encrypted) throw Object.assign(new Error('Deriv session expired'), { code: 'session_expired', status: 401 });

  const refreshToken = await decryptSecret(record.refresh_token_encrypted);
  const response = await fetch(DERIV_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: application.oauth_client_id }),
  });
  if (!response.ok) throw Object.assign(new Error('Deriv token refresh failed'), await parseError(response));
  const token: TokenResponse = await response.json();
  const expiresAt = new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString();
  await supabaseAdmin().from(table).update({
    access_token_encrypted: await encryptSecret(token.access_token),
    refresh_token_encrypted: token.refresh_token ? await encryptSecret(token.refresh_token) : record.refresh_token_encrypted,
    token_type: token.token_type || 'Bearer',
    scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : record.scopes,
    expires_at: expiresAt,
  }).eq('id', record.id);
  return token.access_token;
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

const RETURN_PATH = /^\/(?!\/)[^\r\n]*$/;

Deno.serve(async req => {
  const id = correlationId();
  const headerSiteId = req.headers.get('x-reef-site-id');
  const origin = await resolveAllowedOrigin(req, headerSiteId);
  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(safeError('method_not_allowed', 'Method not allowed', id), 405, origin);
  if (!origin) return json(safeError('origin_denied', 'This origin is not registered for the site', id), 403, null);

  try {
    const body = await req.json();
    const siteId = String(body.siteId || headerSiteId || '');
    const returnPath = typeof body.returnPath === 'string' && RETURN_PATH.test(body.returnPath) ? body.returnPath : '/';
    if (!siteId || siteId !== headerSiteId) return json(safeError('site_mismatch', 'Site identifier is invalid', id), 400, origin);

    const requested = Array.isArray(body.scopes) ? [...new Set(body.scopes.map(String))] : [];
    if (requested.length === 0 || requested.some(scope => !KNOWN_SCOPES.includes(scope as typeof KNOWN_SCOPES[number]))) {
      return json(safeError('invalid_scope', 'At least one supported scope is required', id), 400, origin);
    }

    const admin = supabaseAdmin();
    const { data: site } = await admin
      .from('sites')
      .select('id, organisation_id, status, deployment_disabled')
      .eq('id', siteId)
      .eq('status', 'active')
      .maybeSingle();
    if (!site || site.deployment_disabled) return json(safeError('site_unavailable', 'This site is not available', id), 404, origin);

    const { data: application } = await admin
      .from('deriv_applications')
      .select('*')
      .eq('site_id', siteId)
      .in('verification_status', ['configured', 'verified'])
      .maybeSingle();
    if (!application) return json(safeError('deriv_app_missing', 'Deriv application configuration is incomplete', id), 409, origin);

    const allowedScopes = new Set(application.configured_scopes || []);
    if (requested.some(scope => !allowedScopes.has(scope))) {
      return json(safeError('scope_not_configured', 'A requested feature needs a scope not configured for this application', id), 409, origin);
    }

    const state = randomSecret(32);
    const verifier = randomSecret(64);
    const challenge = await sha256(verifier);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { error: insertError } = await admin.from('deriv_oauth_transactions').insert({
      state_hash: await sha256(state),
      organisation_id: site.organisation_id,
      site_id: site.id,
      deriv_application_id: application.id,
      origin,
      return_path: returnPath,
      code_verifier_encrypted: await encryptSecret(verifier),
      requested_scopes: requested,
      expires_at: expiresAt,
    });
    if (insertError) throw insertError;

    const url = new URL(DERIV_AUTHORIZATION_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', application.oauth_client_id);
    url.searchParams.set('redirect_uri', application.callback_uri);
    url.searchParams.set('scope', requested.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    await audit({ organisationId: site.organisation_id, siteId, actorType: 'trader', action: 'trader.oauth.started', provider: 'deriv', correlationId: id, metadata: { scopes: requested } });
    return json({ authorizationUrl: url.toString(), expiresAt, correlationId: id }, 200, origin);
  } catch (error) {
    console.error('deriv-oauth-start failed', { correlationId: id, error });
    return json(safeError('oauth_start_failed', 'Unable to start Deriv login', id), 500, origin);
  }
});
