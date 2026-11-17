import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const supabaseAdmin = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service configuration is missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

export const correlationId = () => crypto.randomUUID();

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

export async function resolveAllowedOrigin(req: Request, requestedSiteId?: string | null): Promise<string | null> {
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

export const corsHeaders = (origin: string | null) => ({
  ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-reef-site-id, x-csrf-token, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});

export const json = (body: unknown, status: number, origin: string | null, extraHeaders: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });

export const safeError = (code: string, message: string, id: string) => ({
  error: { code, message },
  correlationId: id,
});

export async function audit(input: {
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
