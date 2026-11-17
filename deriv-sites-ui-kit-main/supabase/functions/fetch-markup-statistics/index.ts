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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
type OwnerConnection = {
  id: string;
  organisation_id: string;
  site_id: string;
  deriv_application_id: string;
  scopes: string[];
  application: { app_id: string; [key: string]: unknown };
  [key: string]: unknown;
};
const numberValue = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) if (typeof row[key] === 'number' && Number.isFinite(row[key])) return row[key] as number;
  return undefined;
};
const stringValue = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string;
  return undefined;
};
const normalizedRows = (payload: unknown) => {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(source.data) ? source.data : [source.data].filter(Boolean);
  return rows.filter(row => row && typeof row === 'object').map(rowValue => {
    const row = rowValue as Record<string, unknown>;
    return {
      ...(stringValue(row, ['app_id', 'application_id']) ? { applicationId: stringValue(row, ['app_id', 'application_id']) } : {}),
      ...(stringValue(row, ['currency']) ? { currency: stringValue(row, ['currency']) } : {}),
      ...(numberValue(row, ['markup', 'markup_amount', 'total_markup']) !== undefined ? { markupAmount: numberValue(row, ['markup', 'markup_amount', 'total_markup']) } : {}),
      ...(numberValue(row, ['trade_count', 'trades', 'contracts']) !== undefined ? { tradeCount: numberValue(row, ['trade_count', 'trades', 'contracts']) } : {}),
      ...(numberValue(row, ['turnover', 'trade_volume', 'volume']) !== undefined ? { turnover: numberValue(row, ['turnover', 'trade_volume', 'volume']) } : {}),
      raw: row,
    };
  });
};

Deno.serve(async req => {
  const id = correlationId();
  const origin = await resolveAllowedOrigin(req, null);
  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(safeError('method_not_allowed', 'Method not allowed', id), 405, origin);
  if (!origin) return json(safeError('origin_denied', 'Platform origin is not allowed', id), 403, null);
  try {
    const authorization = req.headers.get('authorization');
    if (!authorization) return json(safeError('not_authenticated', 'Platform login is required', id), 401, origin);
    const admin = supabaseAdmin();
    const { data: auth } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (!auth.user) return json(safeError('not_authenticated', 'Platform session is invalid', id), 401, origin);
    const body = await req.json();
    const siteId = typeof body.siteId === 'string' ? body.siteId : null;
    const dateFrom = String(body.dateFrom || '');
    const dateTo = String(body.dateTo || '');
    const adminMode = body.adminMode === true;
    if (!DATE.test(dateFrom) || !DATE.test(dateTo) || dateFrom > dateTo) return json(safeError('date_invalid', 'Use a valid inclusive UTC date range', id), 400, origin);
    const days = (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000;
    if (days > 366) return json(safeError('date_range_too_large', 'Date range cannot exceed 366 days', id), 400, origin);

    let connections: OwnerConnection[] = [];
    if (adminMode) {
      const { data: canViewFinance } = await admin.rpc('has_platform_permission', { _user_id: auth.user.id, _permission: 'finance.read' });
      if (!canViewFinance) return json(safeError('forbidden', 'Finance read permission is required', id), 403, origin);
      const { data } = await admin.from('owner_deriv_connections').select('*, application:deriv_applications(*)').is('revoked_at', null);
      connections = (data || []) as unknown as OwnerConnection[];
    } else {
      if (!siteId) return json(safeError('site_required', 'Site is required', id), 400, origin);
      const { data: site } = await admin.from('sites').select('organisation_id').eq('id', siteId).maybeSingle();
      if (!site) return json(safeError('site_missing', 'Site was not found', id), 404, origin);
      const { data: member } = await admin.rpc('is_organisation_member', { _organisation_id: site.organisation_id, _user_id: auth.user.id });
      if (!member) return json(safeError('forbidden', 'You cannot view this site', id), 403, origin);
      const { data } = await admin.from('owner_deriv_connections').select('*, application:deriv_applications(*)').eq('site_id', siteId).eq('owner_user_id', auth.user.id).is('revoked_at', null);
      connections = (data || []) as unknown as OwnerConnection[];
    }
    if (!connections.length) return json(safeError('deriv_connection_required', 'Connect a Deriv identity with application_read permission', id), 409, origin);

    const records: unknown[] = [];
    const errors: Array<{ siteId: string; code: string }> = [];
    for (const connection of connections) {
      try {
        if (!connection.scopes?.includes('application_read')) throw Object.assign(new Error(), { code: 'scope_missing' });
        const accessToken = await getValidAccessToken(connection, connection.application, 'owner_deriv_connections');
        const payload = await derivRequest<unknown>(`/applications/v1/markup-statistics?date_from=${dateFrom}&date_to=${dateTo}`, { accessToken, appId: connection.application.app_id });
        const normalized = normalizedRows(payload);
        for (const row of normalized) {
          const snapshot = {
            organisation_id: connection.organisation_id, site_id: connection.site_id,
            deriv_application_id: connection.deriv_application_id, date_from: dateFrom, date_to: dateTo,
            currency: row.currency || 'UNSPECIFIED', markup_amount: row.markupAmount ?? null,
            trade_count: row.tradeCount ?? null, turnover: row.turnover ?? null,
            raw_payload: payload, raw_source_version: 'deriv-applications-v1', synchronized_at: new Date().toISOString(),
          };
          await admin.from('markup_statistic_snapshots').upsert(snapshot, { onConflict: 'deriv_application_id,date_from,date_to,currency' });
          records.push({ siteId: connection.site_id, derivApplicationId: connection.application.app_id, startDate: dateFrom, endDate: dateTo, ...row, raw: undefined, synchronizedAt: snapshot.synchronized_at });
        }
        await admin.from('owner_deriv_connections').update({ last_synchronized_at: new Date().toISOString(), last_error_code: null }).eq('id', connection.id);
      } catch (error) {
        const code = String((error as { code?: string }).code || 'markup_unavailable');
        errors.push({ siteId: connection.site_id, code });
        await admin.from('owner_deriv_connections').update({ last_error_code: code }).eq('id', connection.id);
      }
    }
    await audit({ actorUserId: auth.user.id, actorType: adminMode ? 'platform_admin' : 'platform_owner', action: 'markup.statistics.synchronized', provider: 'deriv', correlationId: id, metadata: { siteId, dateFrom, dateTo, recordCount: records.length, errorCount: errors.length } });
    return json({ records, errors, source: 'Deriv registered-application markup statistics', partnerCommissions: { available: false, reason: 'No approved Partner commission API is configured.' }, synchronizedAt: new Date().toISOString(), correlationId: id }, 200, origin);
  } catch (error) {
    console.error('fetch-markup-statistics failed', { correlationId: id, error });
    return json(safeError('markup_unavailable', 'Markup statistics are temporarily unavailable', id), 502, origin);
  }
});
