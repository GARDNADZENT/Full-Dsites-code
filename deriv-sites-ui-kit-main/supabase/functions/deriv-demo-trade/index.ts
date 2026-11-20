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

// --- _shared/http.ts (subset) ---
const supabaseAdmin = () => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Supabase service configuration is missing');
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

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const safeError = (code: string, message: string, id: string) => ({ error: { code, message }, correlationId: id });

async function audit(input: {
  organisationId?: string | null;
  siteId?: string | null;
  actorType: 'trader' | 'system';
  action: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin().from('audit_logs').insert({
      organisation_id: input.organisationId || null,
      site_id: input.siteId || null,
      actor_type: input.actorType,
      action: input.action,
      provider: 'deriv',
      correlation_id: input.correlationId,
      metadata: input.metadata || {},
    });
  } catch (error) {
    console.error('audit write failed', { correlationId: input.correlationId, error });
  }
}

// --- _shared/deriv.ts (subset) ---
const DERIV_API_BASE_URL = 'https://api.derivws.com';

const getValidAccessToken = async (
  record: { access_token_encrypted: string; expires_at: string },
): Promise<string> => {
  if (Date.parse(record.expires_at) > Date.now() + 60_000) return decryptSecret(record.access_token_encrypted);
  // Deriv issues no refresh token to third-party apps, so expired really does
  // mean re-authorization.
  throw Object.assign(new Error('Deriv sign-in has expired, log in again'), {
    code: 'session_expired',
    status: 401,
  });
};

async function derivRequest<T>(path: string, input: { accessToken: string; appId: string; method?: 'GET' | 'POST' }): Promise<T> {
  const response = await fetch(`${DERIV_API_BASE_URL}${path}`, {
    method: input.method || 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Deriv-App-ID': input.appId,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw Object.assign(new Error('Deriv API request failed'), { code: 'deriv_request_failed', status: 502 });
  return await response.json();
}

/**
 * Which Deriv account prefixes are virtual.
 *
 * The existing code only accepted VRTC/VRW, which mislabels Deriv's DOT accounts
 * as real. DOT is a demo account: trading it risks nothing. Getting this wrong in
 * the other direction would risk real money, so this is intentionally a narrow
 * allowlist of known-virtual prefixes and every unknown prefix is treated as
 * real, i.e. refused.
 */
const DEMO_PREFIXES = ['VRTC', 'VRW', 'DOT'] as const;
const accountTypeFromId = (accountId: string): 'demo' | 'real' =>
  DEMO_PREFIXES.some(prefix => accountId.toUpperCase().startsWith(prefix)) ? 'demo' : 'real';

// --- _shared/trader-session.ts ---
const readCookie = (req: Request, name: string) => {
  const cookie = req.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
};

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
    .select('*, token:encrypted_token_records(*, application:deriv_applications(*)), site:sites(id, organisation_id, status, deployment_disabled, platform_fee_rate, requested_markup_rate)')
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
  const accessToken = await getValidAccessToken(session.token);
  await admin.from('trader_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', session.id);
  return { origin, session, accessToken };
}

// ---------------------------------------------------------------------------
// Automated demo trade
//
// Places one real Deriv contract on a DEMO account and records what actually
// happened. Three things this deliberately does:
//
//  1. Refuses anything Deriv reports as non-demo. The account's type comes from
//     Deriv's own /accounts response, not from the login id, and the prefix is
//     only used as a second, stricter check. A real account cannot trade here
//     even if the request asks for it.
//  2. Records the payout Deriv quoted on the proposal, which is what Deriv
//     computes app markup from. The contract id, buy price and payout are the
//     real values Deriv returned -- this is not a pretend trade.
//  3. Marks the row markup_basis = 'allocated'. Both tenants currently share one
//     Deriv app, so Deriv cannot attribute its markup per tenant. The amount is
//     Deriv's published formula applied to the real payout at the site's own
//     configured rate, and saying so is more honest than implying Deriv reported
//     it per tenant.
//
// Payout status is 'demo', so the row can never be marked paid: demo money is
// not money.
// ---------------------------------------------------------------------------
type TradeRequest = {
  accountId?: string;
  symbol?: string;
  contractType?: string;
  stake?: number;
  duration?: number;
  durationUnit?: string;
  currency?: string;
  barrier?: string;
};

const ACCOUNT_ID = /^[A-Z0-9]{3,32}$/;
const SYMBOL = /^[a-z0-9_]{3,30}$/;
const CONTRACT_TYPE = /^[A-Z_]{3,40}$/;
const DURATION_UNIT = /^[tsdhm]$/;
const PROPOSAL_TIMEOUT_MS = 20_000;
const BUY_TIMEOUT_MS = 20_000;

/** One request/response round trip on a Deriv trading socket. */
const socketRoundTrip = <T>(url: string, request: Record<string, unknown>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(Object.assign(new Error('Deriv socket timed out'), { code: 'deriv_timeout', status: 504 }))),
      timeoutMs,
    );
    socket.onopen = () => socket.send(JSON.stringify(request));
    socket.onerror = () => finish(() => reject(Object.assign(new Error('Deriv socket failed'), { code: 'deriv_socket_failed', status: 502 })));
    socket.onmessage = event => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      // Every response echoes the request type; ignore anything else.
      const kind = Object.keys(request).find(key => key !== 'req_id');
      if (!kind || !(kind in payload)) return;
      finish(() => resolve(payload as T));
    };
  });

Deno.serve(async req => {
  const id = correlationId();
  const siteId = req.headers.get('x-reef-site-id');
  const origin = await resolveAllowedOrigin(req, siteId);
  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(safeError('method_not_allowed', 'Method not allowed', id), 405, origin);

  try {
    const context = await requireTraderSession(req, true);
    if (!context.session.token.scopes.includes('trade')) {
      return json(safeError('scope_missing', 'Reconnect with trade permission to place a demo trade', id), 403, origin);
    }

    const body = (await req.json().catch(() => ({}))) as TradeRequest;
    const accountId = String(body.accountId || '').toUpperCase();
    if (!ACCOUNT_ID.test(accountId)) return json(safeError('account_invalid', 'Account identifier is invalid', id), 400, origin);

    const symbol = String(body.symbol || 'R_100').trim();
    if (!SYMBOL.test(symbol)) return json(safeError('symbol_invalid', 'Symbol is invalid', id), 400, origin);
    const contractType = String(body.contractType || 'CALL').toUpperCase();
    if (!CONTRACT_TYPE.test(contractType)) return json(safeError('contract_type_invalid', 'Contract type is invalid', id), 400, origin);
    const durationUnit = String(body.durationUnit || 't').toLowerCase();
    if (!DURATION_UNIT.test(durationUnit)) return json(safeError('duration_unit_invalid', 'Duration unit is invalid', id), 400, origin);
    const stake = Number(body.stake ?? 1);
    if (!Number.isFinite(stake) || stake < 0.35 || stake > 50) {
      return json(safeError('stake_invalid', 'Stake must be between 0.35 and 50 on a demo account', id), 400, origin);
    }
    const duration = Math.round(Number(body.duration ?? 5));
    if (!Number.isFinite(duration) || duration < 1 || duration > 10) {
      return json(safeError('duration_invalid', 'Duration must be between 1 and 10', id), 400, origin);
    }

    const appId = context.session.token.application.app_id;

    // Deriv is the authority on account type. The prefix check is a second gate.
    const accounts = await derivRequest<{ data: Array<Record<string, unknown>> }>('/trading/v1/options/accounts', {
      accessToken: context.accessToken,
      appId,
    });
    const account = (Array.isArray(accounts.data) ? accounts.data : []).find(item => String(item.account_id || '').toUpperCase() === accountId);
    if (!account) return json(safeError('account_denied', 'This account is not available in the current Deriv session', id), 403, origin);

    const derivAccountType = account.account_type === 'real' ? 'real' : 'demo';
    const prefixAccountType = accountTypeFromId(accountId);
    if (derivAccountType !== 'demo' || prefixAccountType !== 'demo') {
      await audit({
        organisationId: context.session.organisation_id,
        siteId: context.session.site_id,
        actorType: 'trader',
        action: 'trader.demo_trade.blocked_real_account',
        correlationId: id,
        metadata: { accountId, derivAccountType, prefixAccountType },
      });
      return json(
        safeError(
          'demo_only',
          'This endpoint trades demo accounts only. Deriv reported this account as a real-money account, so no trade was placed.',
          id,
        ),
        403,
        origin,
      );
    }

    const currency = String(body.currency || account.currency || 'USD');
    const otp = await derivRequest<{ data: { url: string } }>(
      `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      { method: 'POST', accessToken: context.accessToken, appId },
    );
    const socketUrl = new URL(otp.data.url);
    if (socketUrl.protocol !== 'wss:' || socketUrl.hostname !== 'api.derivws.com') {
      throw Object.assign(new Error('Deriv returned an invalid WebSocket endpoint'), { code: 'otp_endpoint_invalid', status: 502 });
    }

    const proposalRequest: Record<string, unknown> = {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      underlying_symbol: symbol,
      duration,
      duration_unit: durationUnit,
      currency,
    };
    if (body.barrier) proposalRequest.barrier = String(body.barrier);

    const proposalResponse = await socketRoundTrip<{
      proposal?: { id: string; ask_price: number; payout: number; spot?: number };
      error?: { code: string; message: string };
    }>(socketUrl.toString(), proposalRequest, PROPOSAL_TIMEOUT_MS);

    if (proposalResponse.error || !proposalResponse.proposal) {
      const code = proposalResponse.error?.code || 'proposal_failed';
      const message = proposalResponse.error?.message || 'Deriv did not return a proposal';
      await audit({
        organisationId: context.session.organisation_id,
        siteId: context.session.site_id,
        actorType: 'trader',
        action: 'trader.demo_trade.proposal_failed',
        correlationId: id,
        metadata: { accountId, symbol, contractType, code, message },
      });
      return json(safeError(code, message, id), 422, origin);
    }

    const proposal = proposalResponse.proposal;
    const buyResponse = await socketRoundTrip<{
      buy?: { contract_id: string; buy_price: number; payout: number; balance_after?: number; transaction_id?: number; start_time?: number };
      error?: { code: string; message: string };
    }>(socketUrl.toString(), { buy: proposal.id, price: proposal.ask_price }, BUY_TIMEOUT_MS);

    if (buyResponse.error || !buyResponse.buy) {
      const code = buyResponse.error?.code || 'buy_failed';
      const message = buyResponse.error?.message || 'Deriv did not confirm the buy';
      await audit({
        organisationId: context.session.organisation_id,
        siteId: context.session.site_id,
        actorType: 'trader',
        action: 'trader.demo_trade.buy_failed',
        correlationId: id,
        metadata: { accountId, symbol, contractType, code, message },
      });
      return json(safeError(code, message, id), 422, origin);
    }

    const contract = buyResponse.buy;
    const payout = Number(contract.payout ?? proposal.payout ?? 0);
    const buyPrice = Number(contract.buy_price ?? proposal.ask_price ?? stake);

    // Record the real contract. Deriv's markup rule is applied to the payout it
    // actually quoted, at this site's own configured rate.
    const { data: recorded, error: recordError } = await supabaseAdmin().rpc('record_demo_trade', {
      _site_id: context.session.site_id,
      _contract_id: contract.contract_id,
      _client_loginid: accountId,
      _currency: currency,
      _symbol: symbol,
      _contract_type: contractType,
      _stake: buyPrice,
      _payout: payout,
      _run_correlation_id: id,
    });

    if (recordError) {
      // The trade happened and is real; failing to record it must be visible, not
      // silently swallowed, because the contract exists on the account either way.
      console.error('demo trade recorded on Deriv but ledger write failed', {
        correlationId: id, contractId: contract.contract_id, recordError,
      });
      await audit({
        organisationId: context.session.organisation_id,
        siteId: context.session.site_id,
        actorType: 'system',
        action: 'trader.demo_trade.ledger_write_failed',
        correlationId: id,
        metadata: { contractId: contract.contract_id, message: String(recordError.message || recordError) },
      });
      return json({
        ...safeError('ledger_write_failed', 'The demo trade was placed on Deriv but could not be recorded. It is not in the commission ledger.', id),
        contractId: contract.contract_id,
        payout,
        buyPrice,
      }, 500, origin);
    }

    await audit({
      organisationId: context.session.organisation_id,
      siteId: context.session.site_id,
      actorType: 'trader',
      action: 'trader.demo_trade.placed',
      correlationId: id,
      metadata: { accountId, symbol, contractType, contractId: contract.contract_id, payout, buyPrice, stake },
    });

    return json({
      data: {
        contractId: contract.contract_id,
        accountId,
        accountType: 'demo',
        symbol,
        contractType,
        buyPrice,
        payout,
        balanceAfter: contract.balance_after ?? null,
        startTime: contract.start_time ? new Date(Number(contract.start_time) * 1000).toISOString() : null,
        // Stated explicitly so the UI cannot present this as Deriv-reported.
        markupBasis: 'allocated',
        ledger: recorded,
      },
      correlationId: id,
    }, 200, origin);
  } catch (error) {
    const status = Number((error as { status?: number }).status) || 502;
    const code = String((error as { code?: string }).code || 'demo_trade_failed');
    console.error('deriv-demo-trade failed', { correlationId: id, code, status, error });
    return json(
      safeError(code, status === 401 ? 'Trader session expired; sign in again' : 'Unable to place the demo trade', id),
      status,
      origin,
    );
  }
});
