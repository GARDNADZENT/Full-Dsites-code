import { supabase } from "@/integrations/supabase/client";

export type DerivAppMode = "platform_managed" | "custom";

export const DEFAULT_MARKUP_RATE = 2.5;
export const MIN_MARKUP_RATE = 0;
export const MAX_MARKUP_RATE = 3;
export const MARKUP_PRESETS = [0, 0.5, 1, 1.5, 2, 2.5, 3] as const;

export const CENTRAL_DERIV_CALLBACK_URL =
  "https://dsites-admin.vercel.app/api/deriv-oauth-callback";

export const DEFAULT_RISK_DISCLAIMER =
  "Deriv offers complex derivatives, such as options and contracts for difference (CFDs). These products may not be suitable for all clients, and trading them puts you at risk. Never trade with borrowed money or money that you cannot afford to lose.";

export type PlatformDerivPoolStatus = {
  poolReady: boolean;
  activeAppCount: number;
  defaultMarkup: number;
  defaultAppId: string | null;
  defaultAppName: string | null;
  minMarkup: number;
  maxMarkup: number;
  recommendedMin: number;
  recommendedMax: number;
  availableTiers: number[];
  centralCallbackUri: string;
  defaultPlatformFeeRate: number;
  superuserConnected: boolean;
  superuserLoginId: string | null;
};

export type AssignPoolAppResult = {
  status: "assigned" | "queued_for_pool";
  platformDerivAppId: string | null;
  appId: string | null;
  oauthClientId: string | null;
  callbackUri: string;
  poolAppName?: string;
  requestedMarkupRate: number;
  appliedMarkupRate: number;
  platformFeeRate: number;
  ownerShareRate: number;
};

export type PlatformPoolApp = {
  id: string;
  name: string;
  appId: string;
  oauthClientId: string;
  hasClientSecret: boolean;
  callbackUri: string;
  environment: "production" | "staging";
  markupPercentage: number;
  configuredScopes: string[];
  registrationSource: "manual" | "auto_registered" | "imported";
  isDefault: boolean;
  isActive: boolean;
  notes: string;
  assignedSiteCount: number;
  updatedAt: string;
};

export type SuperuserDerivCredential = {
  connected: boolean;
  loginId: string | null;
  email: string | null;
  scopes: string[];
  hasReadScope: boolean;
  wsAppId: string;
  defaultCallbackUri: string;
  defaultHomepageUri: string;
  defaultVerificationUri: string;
  defaultPlatformFeeRate: number;
  lastVerifiedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  tokenValidUntil: string | null;
  tokenDaysRemaining: number | null;
};

export type PlatformSiteSummary = {
  id: string;
  name: string;
  status: string;
  hostname: string | null;
  ownerEmail: string;
  ownerDerivLoginId: string | null;
  derivMode: string;
  requestedMarkupRate: number;
  appliedMarkupRate: number | null;
  assignedAppId: string | null;
  /** Exact redirect_uri sent to Deriv for this site's login. */
  callbackUri: string | null;
  platformFeeRate: number;
  realTraders: number;
  demoTraders: number;
  currency: string;
  grossMarkup: number;
  superuserFee: number;
  ownerNet: number;
  ownerPaid: number;
  ownerPending: number;
  tradeCount: number;
};

export type PlatformCommissionTotals = {
  currency: string;
  grossMarkup: number;
  superuserFee: number;
  ownerNet: number;
  ownerPaid: number;
  ownerPending: number;
  tradeCount: number;
  attributedTrades: number;
  unattributedTrades: number;
};

export type SuperuserDerivStatus = {
  credential: SuperuserDerivCredential;
  apps: PlatformPoolApp[];
  sites: PlatformSiteSummary[];
  totals: PlatformCommissionTotals[];
};

export type SiteCommissionsResponse = {
  site: {
    id: string;
    name: string;
    derivMode: DerivAppMode;
    requestedMarkupRate: number;
    appliedMarkupRate: number;
    assignedAppId: string | null;
  /** Exact redirect_uri sent to Deriv for this site's login. */
  callbackUri: string | null;
    platformFeeRate: number;
    ownerShareRate: number;
    ownerDerivLoginId: string | null;
    derivAffiliateId: string | null;
  };
  traders: { real: number; demo: number; total: number };
  currencies: Array<{
    currency: string;
    grossMarkup: number;
    platformFee: number;
    ownerNet: number;
    paidAmount: number;
    pendingAmount: number;
    tradeCount: number;
  }>;
  recentTrades: Array<{
    id: string;
    trader: string;
    contractId: string | null;
    currency: string;
    grossMarkup: number;
    platformFee: number;
    ownerNet: number;
    payoutStatus: string;
    tradedAt: string;
  }>;
};

export type PlatformUserOption = {
  id: string;
  email: string;
  display_name: string | null;
  created_at?: string;
};

export function clampMarkupRate(value: number | string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MARKUP_RATE;
  const clamped = Math.min(MAX_MARKUP_RATE, Math.max(MIN_MARKUP_RATE, num));
  return Math.round(clamped * 100) / 100;
}

export function formatMarkupRate(value: number | string): string {
  const clamped = clampMarkupRate(value);
  return `${Number.isInteger(clamped) ? clamped : clamped.toFixed(2).replace(/0$/, "")}%`;
}

export function ownerShareRate(platformFeeRate: number): number {
  return Math.max(0, Math.round((100 - Number(platformFeeRate || 0)) * 100) / 100);
}

export function normalizeDerivLoginId(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidDerivLoginId(value: string): boolean {
  const trimmed = normalizeDerivLoginId(value);
  return !trimmed || /^(CR|MF|VRTC|VR|MLT|MX|SVG)\d{3,20}$/.test(trimmed);
}

export function suggestedVercelSlug(siteName: string, internalName?: string): string {
  const base = (siteName || internalName || "").trim();
  if (!base) return "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return /^[a-z0-9]/.test(slug) && slug.length >= 3 ? slug : "";
}

export function decimalString(value: number | string): string {
  const clamped = clampMarkupRate(value);
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(2).replace(/0$/, "");
}

export async function getPlatformDerivPoolStatus(): Promise<PlatformDerivPoolStatus> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("get_platform_deriv_pool_status");
  if (error || !data) {
    return {
      poolReady: false,
      activeAppCount: 0,
      defaultMarkup: DEFAULT_MARKUP_RATE,
      defaultAppId: null,
      defaultAppName: null,
      minMarkup: MIN_MARKUP_RATE,
      maxMarkup: MAX_MARKUP_RATE,
      recommendedMin: 2,
      recommendedMax: 3,
      availableTiers: [],
      centralCallbackUri: CENTRAL_DERIV_CALLBACK_URL,
      defaultPlatformFeeRate: 17,
      superuserConnected: false,
      superuserLoginId: null,
    };
  }
  return {
    poolReady: Boolean(data.poolReady),
    activeAppCount: Number(data.activeAppCount || 0),
    defaultMarkup: Number(data.defaultMarkup ?? DEFAULT_MARKUP_RATE),
    defaultAppId: data.defaultAppId || null,
    defaultAppName: data.defaultAppName || null,
    minMarkup: Number(data.minMarkup ?? MIN_MARKUP_RATE),
    maxMarkup: Number(data.maxMarkup ?? MAX_MARKUP_RATE),
    recommendedMin: Number(data.recommendedMin ?? 2),
    recommendedMax: Number(data.recommendedMax ?? 3),
    availableTiers: Array.isArray(data.availableTiers)
      ? data.availableTiers.map((tier: unknown) => Number(tier))
      : [],
    centralCallbackUri: data.centralCallbackUri || CENTRAL_DERIV_CALLBACK_URL,
    defaultPlatformFeeRate: Number(data.defaultPlatformFeeRate ?? 17),
    superuserConnected: Boolean(data.superuserConnected),
    superuserLoginId: data.superuserLoginId || null,
  };
}

export async function assignPlatformDerivAppToSite(input: {
  siteId: string;
  markupPercentage: number;
  environment?: "production" | "staging";
  scopes?: string[];
  plan?: "partnership_monthly" | "one_time";
  ownerDerivLoginId?: string;
  derivAffiliateId?: string;
}): Promise<AssignPoolAppResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("assign_platform_deriv_app_to_site", {
    _site_id: input.siteId,
    _markup_percentage: clampMarkupRate(input.markupPercentage),
    _environment: input.environment || "production",
    _scopes: input.scopes?.length ? input.scopes : ["trade"],
    _plan: input.plan || null,
    _owner_deriv_loginid: input.ownerDerivLoginId?.trim() || null,
    _deriv_affiliate_id: input.derivAffiliateId?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return data as AssignPoolAppResult;
}

export async function invokeManagePlatformDeriv<T>(
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("manage-platform-deriv", {
    body,
  });

  if (error) {
    let message = error.message || "Request failed";
    const ctx = "context" in error ? (error as { context?: unknown }).context : null;
    if (ctx instanceof Response) {
      const parsed = await ctx.json().catch(() => null);
      if (typeof parsed?.error === "string") message = parsed.error;
      else if (parsed?.error?.message) message = parsed.error.message;
    }
    throw new Error(message);
  }

  if (data?.error) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error?.message || "Request failed";
    throw new Error(message);
  }

  return data as T;
}

export async function getSiteCommissions(siteId: string): Promise<SiteCommissionsResponse> {
  return invokeManagePlatformDeriv<SiteCommissionsResponse>({
    action: "site_commissions",
    siteId,
  });
}

export async function listPlatformUsers(): Promise<PlatformUserOption[]> {
  const res = await invokeManagePlatformDeriv<{ users: PlatformUserOption[] }>({
    action: "list_users",
  });
  return Array.isArray(res.users) ? res.users : [];
}

export async function assignSiteOwner(
  siteId: string,
  target: { userId?: string; email?: string },
): Promise<{ assignedOwner: PlatformUserOption; organisationId: string }> {
  return invokeManagePlatformDeriv({
    action: "assign_site_owner",
    siteId,
    targetUserId: target.userId || "",
    targetEmail: target.email || "",
  });
}

export async function getSuperuserDerivStatus(): Promise<SuperuserDerivStatus> {
  return invokeManagePlatformDeriv<SuperuserDerivStatus>({ action: "get_status" });
}

export async function saveSuperuserDerivToken(input: {
  apiToken?: string;
  clearToken?: boolean;
  wsAppId?: string;
  defaultCallbackUri?: string;
  defaultHomepageUri?: string;
  defaultVerificationUri?: string;
  defaultPlatformFeeRate?: number;
}): Promise<{ ok: boolean; verifiedAccount: { loginid: string; email: string; scopes: string[] } | null }> {
  return invokeManagePlatformDeriv({ action: "save_superuser_token", ...input });
}

export async function upsertPoolApp(input: {
  id?: string;
  name?: string;
  appId: string;
  oauthClientId?: string;
  clientSecret?: string;
  callbackUri?: string;
  environment?: "production" | "staging";
  markupPercentage: number;
  configuredScopes?: string[];
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}): Promise<{ app: PlatformPoolApp; rebalancedSites: number }> {
  // Display names stay intact locally; nothing is pushed to Deriv (app_update is legacy-only).
  return invokeManagePlatformDeriv({ action: "upsert_pool_app", ...input });
}

/**
 * Per-tenant app registration lives in its own Edge Function.
 *
 * `manage-platform-deriv` v1 is deployed and pinned, so the per-site registration
 * logic ships separately rather than by rewriting that function.
 */
async function invokeManageSiteDerivApps<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("manage-site-deriv-apps", { body });

  if (error) {
    let message = error.message || "Request failed";
    const ctx = "context" in error ? (error as { context?: unknown }).context : null;
    if (ctx instanceof Response) {
      const parsed = await ctx.json().catch(() => null);
      if (typeof parsed?.error === "string") message = parsed.error;
      else if (parsed?.error?.message) message = parsed.error.message;
    }
    throw new Error(message);
  }

  if (data?.error) {
    const message =
      typeof data.error === "string" ? data.error : data.error?.message || "Request failed";
    throw new Error(message);
  }

  return data as T;
}

export type SiteDerivRegistration = {
  status: "registered" | "already_registered";
  app: {
    id: string;
    name: string;
    appId: string;
    oauthClientId: string;
    callbackUri: string;
    markupPercentage: number;
  };
  site: { id: string; name: string };
  registrationWarnings?: string[];
};

export type BulkSiteDerivRegistration = {
  registered: Array<{ siteId: string; siteName: string; appId: string }>;
  failed: Array<{ siteId: string; siteName: string; message: string }>;
  skipped: number;
};

/**
 * Register the tenant's own Deriv app and pin it to that site.
 *
 * Each tenant gets a distinct App ID, client ID and callback so the operator can
 * attribute markup per tenant and pay out their share minus the platform fee.
 */
export async function registerSiteDerivApp(
  siteId: string,
): Promise<SiteDerivRegistration> {
  return invokeManageSiteDerivApps({ action: "register_site_deriv_app", siteId });
}

/** Register every tenant site that does not have an app yet. */
export async function registerAllSiteDerivApps(): Promise<BulkSiteDerivRegistration> {
  return invokeManageSiteDerivApps({ action: "register_all_site_deriv_apps" });
}

/**
 * Undo app assignments that override a site's pinned binding, without handing any
 * tenant another tenant's application.
 */
export async function repairDerivAssignments(): Promise<{ repairedSites: number }> {
  return invokeManageSiteDerivApps({ action: "repair_deriv_assignments" });
}

/** Bind an existing pool app to one site (manual path when registration is blocked). */
export async function assignPoolAppToSite(input: {
  siteId: string;
  platformDerivAppId: string;
}): Promise<{ status: string; appId: string | null; siteId: string }> {
  return invokeManageSiteDerivApps({ action: "assign_app_to_site", ...input });
}

/**
 * Record a DevHub-created app and pin it to one tenant in a single step.
 *
 * Used when automatic registration is blocked: the operator creates the app once
 * in DevHub, then this writes it to the pool and binds it without any WebSocket
 * call.
 */
export async function addAppForSite(input: {
  siteId: string;
  derivAppId: string;
  name?: string;
  oauthClientId?: string;
  clientSecret?: string;
  callbackUri?: string;
  markupPercentage?: number;
}): Promise<SiteDerivRegistration> {
  return invokeManageSiteDerivApps({ action: "add_app_for_site", ...input });
}

export type SuperuserTokenVerification = {
  ok: boolean;
  verifiedAccount: { loginid: string; email: string; scopes: string[] } | null;
  verification: {
    reachable: boolean;
    status: number | null;
    detail: string;
    accounts?: Array<{ accountId: string; accountType: string; currency: string }>;
  } | null;
  appRegistration: {
    available: boolean;
    detail: string;
    note: string;
  } | null;
};

/**
 * Save the superuser Deriv token, verifying it over Deriv's REST API.
 *
 * Verification uses the new platform's REST API (api.derivws.com) with a Bearer
 * token and a Deriv-App-ID header. The legacy WebSocket stack that carried
 * `authorize` has been removed from the platform entirely.
 */
export async function saveSuperuserToken(input: {
  apiToken?: string;
  clearToken?: boolean;
  wsAppId?: string;
  derivAppId?: string;
  defaultCallbackUri?: string;
  defaultPlatformFeeRate?: number;
}): Promise<SuperuserTokenVerification> {
  return invokeManageSiteDerivApps({ action: "save_superuser_token", ...input });
}

export async function importDerivApps(): Promise<{
  imported: number;
  totalFound: number;
  rebalancedSites: number;
}> {
  return invokeManagePlatformDeriv({ action: "import_deriv_apps" });
}

export async function deletePoolApp(id: string): Promise<{ deleted: boolean; rebalancedSites: number }> {
  return invokeManagePlatformDeriv({ action: "delete_pool_app", id });
}

export async function syncCommissions(dateFrom?: string, dateTo?: string): Promise<{
  dateFrom: string;
  dateTo: string;
  processed: number;
  attributed: number;
  unattributed: number;
  errors: Array<{ appId: string; message: string }>;
  synchronizedAt: string;
}> {
  return invokeManagePlatformDeriv({ action: "sync_commissions", dateFrom, dateTo });
}

export async function markPayout(input: {
  siteId: string;
  currency?: string;
  payoutReference?: string;
}): Promise<{ paidCount: number; totalPaid: number; payoutReference: string }> {
  return invokeManagePlatformDeriv({ action: "mark_payout", ...input });
}

/**
 * Point a tenant's Deriv login at a specific callback URL.
 *
 * Deriv requires the redirect_uri on the authorize request and the token
 * exchange to match the OAuth client's registration exactly, and rejects the
 * login with `invalid_request` when it does not. The platform controls what it
 * sends, so this is the one side of that mismatch it can correct without DevHub.
 *
 * Writes through to `deriv_applications` (what `deriv-oauth-start` reads),
 * `site_deriv_apps` and the shared pool app, so a later rebind does not quietly
 * restore the old value.
 */
export async function updateDerivApplicationCallback(input: {
  siteId: string;
  callbackUri: string;
}): Promise<{ callbackUri: string; callbackUpdated: boolean }> {
  return invokeManagePlatformDeriv<{ callbackUri: string; callbackUpdated: boolean }>({
    action: "update_deriv_application_callback",
    siteId: input.siteId,
    callbackUri: input.callbackUri,
  });
}

export type CallbackVerificationStatus = "registered" | "not_registered" | "unverified";

export interface CallbackVerification {
  status: CallbackVerificationStatus;
  message: string;
  appId: string;
  oauthClientId: string;
  callbackUri: string;
  lastAttempt: {
    redirectUri: string | null;
    derivErrorCode: string | null;
    at: string;
    stale: boolean;
  } | null;
}

/**
 * Ask Deriv whether a tenant's redirect URI is actually registered.
 *
 * Deriv validates `redirect_uri` only after the user signs in, so there is no
 * direct API to query the registration and the published OpenAPI spec has no
 * applications endpoint that would expose it. The one conclusive signal is a
 * real login, so this reads back the verdict the callback recorded on the most
 * recent attempt:
 *
 * - `registered`     the token exchange succeeded, so Deriv accepted the URI
 * - `not_registered` Deriv rejected it as a pre-registered-redirect-url mismatch
 * - `unverified`     no login has completed yet
 *
 * A `stale` last attempt means the URI has changed since that attempt, so the
 * verdict describes the old value and a fresh login is needed.
 */
export async function checkDerivApplicationCallback(
  siteId: string,
): Promise<CallbackVerification> {
  return invokeManagePlatformDeriv<CallbackVerification>({
    action: "check_deriv_application_callback",
    siteId,
  });
}

// ---------------------------------------------------------------------------
// Commission simulation
//
// There is no writer for site_commission_ledger and Deriv's new API cannot
// report earned markup, so the split is only observable by simulation. The
// formula is Deriv's own: API Terms §4.3.3 computes app markup per trade from
// the contract *payout* and the configured markup percentage, truncating to zero
// any amount below the smallest unit of the account currency.
// ---------------------------------------------------------------------------

export type SimulatedSiteTotals = {
  siteId: string;
  siteName: string;
  markupRate: number;
  platformFeeRate: number;
  trades: number;
  truncatedTrades: number;
  payoutTotal: number;
  grossTotal: number;
  feeTotal: number;
  ownerTotal: number;
};

export type SimulatedTrade = {
  siteId: string;
  siteName: string;
  contractId: string;
  payout: number;
  stake: number;
  markupRate: number;
  gross: number;
  fee: number;
  ownerNet: number;
  truncatedToZero: boolean;
};

export type SimulateCommissionsResult = {
  runId: string;
  inserted: number;
  skipped: number;
  basis: "payout";
  formula: string;
  sites: SimulatedSiteTotals[];
  trades: SimulatedTrade[];
};

/**
 * Run the commission simulation.
 *
 * The arithmetic and the ledger write both happen inside the database function,
 * so the formula and the rows it produces can never disagree, and a run is a
 * single transaction. Nothing here writes to site config: per-tenant margins are
 * arguments to this call only.
 */
export async function simulateCommissions(input: {
  siteIds?: string[];
  tradesPerSite?: number;
  payoutMin?: number;
  payoutMax?: number;
  runId?: string;
  /** When true each tenant gets baseRate + index * rateStep instead of its own rate. */
  marginSpread?: boolean;
  baseRate?: number;
  rateStep?: number;
}): Promise<SimulateCommissionsResult> {
  // Newer RPC is not in the generated Database types yet, so it is called
  // through the untyped client, the same way get_platform_deriv_pool_status is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("simulate_commissions", {
    _run_id: input.runId ?? null,
    _site_ids: input.siteIds ?? null,
    _trades_per_site: input.tradesPerSite ?? 5,
    _payout_min: input.payoutMin ?? 10,
    _payout_max: input.payoutMax ?? 200,
    _margin_spread: input.marginSpread ?? true,
    _base_rate: input.baseRate ?? 1,
    _rate_step: input.rateStep ?? 1,
  });
  if (error) throw error;
  return data as SimulateCommissionsResult;
}

export type CommissionLedgerTotal = {
  siteId: string;
  siteName: string;
  isSimulated: boolean;
  trades: number;
  truncatedTrades: number;
  grossTotal: number;
  feeTotal: number;
  ownerTotal: number;
};

/** Per-tenant totals over the ledger as a whole, real and simulated separately. */
export async function fetchCommissionLedgerTotals(options?: {
  simulatedOnly?: boolean;
  runId?: string;
}): Promise<CommissionLedgerTotal[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("commission_ledger_totals", {
    _is_simulated: options?.simulatedOnly ?? null,
    _run_id: options?.runId ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    siteId: String(row.site_id),
    siteName: String(row.site_name),
    isSimulated: Boolean(row.is_simulated),
    trades: Number(row.trades),
    truncatedTrades: Number(row.truncated_trades),
    grossTotal: Number(row.gross_total),
    feeTotal: Number(row.fee_total),
    ownerTotal: Number(row.owner_total),
  }));
}
