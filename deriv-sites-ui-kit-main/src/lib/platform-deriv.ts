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
  legacyAppId: string | null;
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
  hasAdminScope: boolean;
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
  legacyAppId?: string;
  callbackUri?: string;
  environment?: "production" | "staging";
  markupPercentage: number;
  configuredScopes?: string[];
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
  syncToDeriv?: boolean;
}): Promise<{ app: PlatformPoolApp; syncedToDeriv: boolean; rebalancedSites: number }> {
  // Display names stay intact locally; the Edge Function sanitizes the name it sends to Deriv.
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
