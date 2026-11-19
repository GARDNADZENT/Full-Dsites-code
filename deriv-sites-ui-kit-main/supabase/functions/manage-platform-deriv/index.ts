import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_CALLBACK_URI = "https://dsites-admin.vercel.app/api/deriv-oauth-callback";
const DEFAULT_HOMEPAGE_URI = "https://dsites-admin.vercel.app";
const DEFAULT_VERIFICATION_URI = "https://dsites-admin.vercel.app/auth";
const DEFAULT_OAUTH_SCOPES = ["trade", "account_manage", "application_read"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string) => {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const getEncryptionKey = async () => {
  const configured = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!configured) throw new Error("TOKEN_ENCRYPTION_KEY secret is not configured");
  const raw = fromBase64Url(configured);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const encryptSecret = async (value: string): Promise<string> => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await getEncryptionKey(),
    encoder.encode(value),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
};

const decryptSecret = async (value: string): Promise<string> => {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) {
    throw new Error("Stored encrypted credential is invalid");
  }
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await getEncryptionKey(),
    fromBase64Url(encrypted),
  );
  return decoder.decode(clear);
};

const supabaseAdmin = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service configuration is missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

const clampMarkup = (value: unknown, fallback = 2.5): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(3, Math.max(0, parsed)) * 100) / 100;
};

const clampFeeRate = (value: unknown, fallback = 17): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(100, Math.max(0, parsed)) * 100) / 100;
};

const validateHttpsUrl = (value: unknown, fallback: string): string => {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${raw}`);
  }
  return parsed.toString();
};

const maskLoginId = (loginId: string | null | undefined): string => {
  if (!loginId) return "Unknown";
  if (loginId.length <= 5) return `${loginId.slice(0, 2)}***`;
  return `${loginId.slice(0, 2)}***${loginId.slice(-3)}`;
};

/** The scopes a new-platform (OAuth 2.0) Deriv app can hold. No admin scope exists. */
const DERIV_OPERATOR_SCOPES = ["trade", "account_manage", "application_read", "payment"];

const DERIV_REST_BASE = "https://api.derivws.com";

/**
 * Why app registration/update is unavailable, stated once.
 *
 * `app_register` and `app_update` belong to Deriv's legacy JSON-RPC stack and
 * exist only on the legacy WebSocket hosts, which return Cloudflare 520 to
 * server networks. The new platform has no equivalent: its reachable socket
 * routes no app_* methods and the REST API has no /applications route.
 *
 * This is not a token-scope problem. The new OAuth 2.0 scope set -- trade,
 * account_manage, application_read, payment -- has no admin scope; admin belongs
 * to the legacy app model.
 */
const APP_REGISTRATION_REMOVED =
  "Automatic Deriv app creation is unavailable: app_register exists only on Deriv's legacy WebSocket API (Cloudflare 520 to server networks) and the new platform has no applications API. Register the app at developers.deriv.com, then add it under Admin -> Deriv Pool -> Add app.";

type OperatorTokenVerification = {
  reachable: boolean;
  status: number;
  detail: string;
  accounts: Array<{ accountId: string; accountType: string; currency: string }>;
};

/**
 * Verify an operator (or app owner) Deriv token against the new platform.
 *
 * This is the only verification available: `authorize` is a legacy WebSocket
 * method, and the legacy hosts return Cloudflare 520 to server networks. The new
 * platform authenticates with a Bearer token and identifies the app with a
 * `Deriv-App-ID` header, so a successful account listing proves both the token
 * and the app ID are accepted.
 */
const verifyOperatorTokenOverRest = async (
  token: string,
  appId: string,
): Promise<OperatorTokenVerification> => {
  const empty = { accounts: [] as OperatorTokenVerification["accounts"] };
  let response: Response;
  try {
    response = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": appId,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return {
      reachable: false,
      status: 0,
      detail: `Could not reach ${DERIV_REST_BASE}: ${error instanceof Error ? error.message : String(error)}`,
      ...empty,
    };
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const first = (body.errors as Array<{ code?: string; message?: string }> | undefined)?.[0];
    return {
      reachable: true,
      status: response.status,
      detail: first?.message || "Deriv rejected this token or app ID",
      ...empty,
    };
  }

  const rows = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  return {
    reachable: true,
    status: response.status,
    detail: "Token accepted by Deriv",
    accounts: rows
      .map((row) => ({
        accountId: String(row.account_id || ""),
        accountType: row.account_type === "real" ? "real" : "demo",
        currency: typeof row.currency === "string" ? row.currency : "",
      }))
      .filter((row) => row.accountId),
  };
};

const auditLog = async (
  admin: ReturnType<typeof supabaseAdmin>,
  input: {
    userId: string;
    actorType: "platform_admin" | "platform_owner";
    action: string;
    siteId?: string | null;
    organisationId?: string | null;
    metadata?: Record<string, unknown>;
  },
) => {
  await admin.from("audit_logs").insert({
    actor_user_id: input.userId,
    actor_type: input.actorType,
    action: input.action,
    site_id: input.siteId || null,
    organisation_id: input.organisationId || null,
    provider: "deriv",
    correlation_id: crypto.randomUUID(),
    metadata: input.metadata || {},
  });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ error: "Authentication required" }, 401);
    }

    const admin = supabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, ""),
    );
    if (authError || !authData.user) {
      return json({ error: "Invalid or expired session" }, 401);
    }
    const user = authData.user;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || "get_status");

    // -----------------------------------------------------------------------
    // Site-owner + Admin action: site_commissions
    // -----------------------------------------------------------------------
    if (action === "site_commissions") {
      const siteId = String(body.siteId || "").trim();
      if (!siteId) return json({ error: "siteId is required" }, 400);

      const { data: site } = await admin
        .from("sites")
        .select(
          "id, name, user_id, organisation_id, deriv_mode, platform_deriv_app_id, requested_markup_rate, platform_fee_rate, owner_deriv_loginid, deriv_affiliate_id",
        )
        .eq("id", siteId)
        .maybeSingle();
      if (!site) return json({ error: "Site not found" }, 404);

      const [{ data: isMember }, { data: isFinance }] = await Promise.all([
        admin.rpc("is_organisation_member", {
          _organisation_id: site.organisation_id,
          _user_id: user.id,
        }),
        admin.rpc("has_platform_permission", {
          _user_id: user.id,
          _permission: "finance.read",
        }),
      ]);

      if (!isMember && !isFinance && site.user_id !== user.id) {
        return json({ error: "Forbidden" }, 403);
      }

      const dateFrom =
        typeof body.dateFrom === "string" && DATE_PATTERN.test(body.dateFrom)
          ? body.dateFrom
          : null;
      const dateTo =
        typeof body.dateTo === "string" && DATE_PATTERN.test(body.dateTo)
          ? body.dateTo
          : null;

      let ledgerQuery = admin
        .from("site_commission_ledger")
        .select("*")
        .eq("site_id", siteId)
        .order("traded_at", { ascending: false })
        .limit(500);

      if (dateFrom) ledgerQuery = ledgerQuery.gte("traded_at", `${dateFrom}T00:00:00Z`);
      if (dateTo) ledgerQuery = ledgerQuery.lte("traded_at", `${dateTo}T23:59:59.999Z`);

      const [{ data: ledgerRows }, { data: traders }, { data: derivApp }] = await Promise.all([
        ledgerQuery,
        admin
          .from("site_trader_attributions")
          .select("account_type")
          .eq("site_id", siteId),
        admin
          .from("deriv_applications")
          .select("app_id, oauth_client_id, markup_rate, source_type, verification_status")
          .eq("site_id", siteId)
          .maybeSingle(),
      ]);

      const byCurrency: Record<
        string,
        {
          currency: string;
          grossMarkup: number;
          platformFee: number;
          ownerNet: number;
          paidAmount: number;
          pendingAmount: number;
          tradeCount: number;
        }
      > = {};

      for (const row of ledgerRows || []) {
        const cur = row.currency || "USD";
        const bucket = byCurrency[cur] || {
          currency: cur,
          grossMarkup: 0,
          platformFee: 0,
          ownerNet: 0,
          paidAmount: 0,
          pendingAmount: 0,
          tradeCount: 0,
        };
        const gross = Number(row.gross_markup_amount || 0);
        const fee = Number(row.superuser_fee_amount || 0);
        const net = Number(row.owner_net_amount || 0);
        bucket.grossMarkup += gross;
        bucket.platformFee += fee;
        bucket.ownerNet += net;
        if (row.payout_status === "paid") bucket.paidAmount += net;
        else bucket.pendingAmount += net;
        bucket.tradeCount += 1;
        byCurrency[cur] = bucket;
      }

      const realTraders = (traders || []).filter((t) => t.account_type === "real").length;
      const demoTraders = (traders || []).filter((t) => t.account_type === "demo").length;

      return json({
        site: {
          id: site.id,
          name: site.name,
          derivMode: site.deriv_mode,
          requestedMarkupRate: Number(site.requested_markup_rate ?? 2.5),
          appliedMarkupRate: Number(derivApp?.markup_rate ?? site.requested_markup_rate ?? 2.5),
          assignedAppId: derivApp?.app_id || null,
          platformFeeRate: Number(site.platform_fee_rate ?? 17),
          ownerShareRate: Math.max(0, 100 - Number(site.platform_fee_rate ?? 17)),
          ownerDerivLoginId: site.owner_deriv_loginid || null,
          derivAffiliateId: site.deriv_affiliate_id || null,
        },
        traders: { real: realTraders, demo: demoTraders, total: realTraders + demoTraders },
        currencies: Object.values(byCurrency),
        recentTrades: (ledgerRows || []).slice(0, 25).map((row) => ({
          id: row.id,
          trader: isFinance ? row.client_loginid : maskLoginId(row.client_loginid),
          contractId: row.contract_id,
          currency: row.currency,
          grossMarkup: Number(row.gross_markup_amount || 0),
          platformFee: Number(row.superuser_fee_amount || 0),
          ownerNet: Number(row.owner_net_amount || 0),
          payoutStatus: row.payout_status,
          tradedAt: row.traded_at,
        })),
      });
    }

    // -----------------------------------------------------------------------
    // All remaining actions require Superuser / Platform Admin permission
    // -----------------------------------------------------------------------
    const { data: isAdmin } = await admin.rpc("is_platform_admin", { _user_id: user.id });
    const { data: canViewFinance } = await admin.rpc("has_platform_permission", {
      _user_id: user.id,
      _permission: "finance.read",
    });

    if (!isAdmin && !(action === "get_status" && canViewFinance)) {
      return json({ error: "Superuser admin permission is required" }, 403);
    }

    // -----------------------------------------------------------------------
    // Action: list_users (for DForge "Who is this site for?")
    // -----------------------------------------------------------------------
    if (action === "list_users") {
      const { data: profiles, error } = await admin
        .from("profiles")
        .select("id, email, display_name, created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return json({ users: profiles || [] });
    }

    // -----------------------------------------------------------------------
    // Action: assign_site_owner (for DForge "Create for another user")
    // -----------------------------------------------------------------------
    if (action === "assign_site_owner") {
      const siteId = String(body.siteId || "").trim();
      const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
      const targetEmail =
        typeof body.targetEmail === "string" ? body.targetEmail.trim().toLowerCase() : "";

      if (!siteId || (!targetUserId && !targetEmail)) {
        return json({ error: "siteId and targetUserId or targetEmail are required" }, 400);
      }

      let profileQuery = admin.from("profiles").select("id, email, display_name");
      profileQuery = targetUserId
        ? profileQuery.eq("id", targetUserId)
        : profileQuery.ilike("email", targetEmail);
      const { data: targetProfile } = await profileQuery.maybeSingle();

      if (!targetProfile) {
        return json(
          { error: "No registered user found with that account. Ask them to sign up first or select from existing users." },
          404,
        );
      }

      // Ensure target user has a personal organisation
      let { data: targetOrg } = await admin
        .from("organisations")
        .select("id")
        .eq("owner_user_id", targetProfile.id)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!targetOrg) {
        const label =
          (targetProfile.display_name || targetProfile.email.split("@")[0] || "Operator").slice(
            0,
            80,
          ) + "'s sites";
        const slug = `owner-${targetProfile.id.replace(/-/g, "")}`;
        const { data: createdOrg, error: orgErr } = await admin
          .from("organisations")
          .upsert(
            { name: label, slug, owner_user_id: targetProfile.id, status: "active" },
            { onConflict: "slug" },
          )
          .select("id")
          .single();
        if (orgErr || !createdOrg) throw orgErr || new Error("Could not create user organisation");
        targetOrg = createdOrg;
        await admin.from("organisation_members").upsert(
          {
            organisation_id: targetOrg.id,
            user_id: targetProfile.id,
            role: "tenant_owner",
            status: "active",
          },
          { onConflict: "organisation_id,user_id" },
        );
      }

      await Promise.all([
        admin
          .from("sites")
          .update({
            user_id: targetProfile.id,
            organisation_id: targetOrg.id,
            created_by_admin_id: targetProfile.id === user.id ? null : user.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", siteId),
        admin
          .from("site_configurations")
          .update({ organisation_id: targetOrg.id })
          .eq("site_id", siteId),
        admin
          .from("deriv_applications")
          .update({ organisation_id: targetOrg.id })
          .eq("site_id", siteId),
      ]);

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "site.owner_assigned",
        siteId,
        organisationId: targetOrg.id,
        metadata: { targetUserId: targetProfile.id, targetEmail: targetProfile.email },
      });

      return json({
        assignedOwner: targetProfile,
        organisationId: targetOrg.id,
      });
    }

    // -----------------------------------------------------------------------
    // Action: get_status (Superuser Deriv Pool & Commission Control Center)
    // -----------------------------------------------------------------------
    if (action === "get_status") {
      const [
        { data: cred },
        { data: apps },
        { data: sites },
        { data: profiles },
        { data: domains },
        { data: derivApps },
        { data: attributions },
        { data: ledger },
      ] = await Promise.all([
        admin.from("superuser_deriv_credentials").select("*").eq("singleton_key", "primary").maybeSingle(),
        admin
          .from("platform_deriv_apps")
          .select(
            "id, name, app_id, oauth_client_id, client_secret_encrypted, callback_uri, environment, markup_percentage, configured_scopes, registration_source, is_default, is_active, notes, created_at, updated_at",
          )
          .order("markup_percentage", { ascending: true })
          .order("created_at", { ascending: true }),
        admin
          .from("sites")
          .select(
            "id, name, user_id, status, deriv_mode, platform_deriv_app_id, requested_markup_rate, platform_fee_rate, owner_deriv_loginid, deriv_affiliate_id, created_at",
          )
          .order("created_at", { ascending: false }),
        admin.from("profiles").select("id, email, display_name"),
        admin
          .from("site_domains")
          .select("site_id, hostname, is_primary, is_verified, status")
          .order("is_primary", { ascending: false }),
        admin
          .from("deriv_applications")
          .select("site_id, app_id, oauth_client_id, callback_uri, markup_rate, source_type, verification_status"),
        admin.from("site_trader_attributions").select("site_id, account_type"),
        admin
          .from("site_commission_ledger")
          .select(
            "site_id, currency, gross_markup_amount, superuser_fee_amount, owner_net_amount, attribution_status, payout_status",
          ),
      ]);

      const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
      const domainMap = new Map<string, string>();
      for (const d of domains || []) {
        if (!domainMap.has(d.site_id)) domainMap.set(d.site_id, d.hostname);
      }
      const siteDerivMap = new Map((derivApps || []).map((d) => [d.site_id, d]));

      const siteCountByPoolApp = new Map<string, number>();
      for (const s of sites || []) {
        if (s.platform_deriv_app_id) {
          siteCountByPoolApp.set(
            s.platform_deriv_app_id,
            (siteCountByPoolApp.get(s.platform_deriv_app_id) || 0) + 1,
          );
        }
      }

      const traderCountBySite = new Map<string, { real: number; demo: number }>();
      for (const a of attributions || []) {
        const cur = traderCountBySite.get(a.site_id) || { real: 0, demo: 0 };
        if (a.account_type === "real") cur.real += 1;
        else cur.demo += 1;
        traderCountBySite.set(a.site_id, cur);
      }

      const siteCommissions = new Map<
        string,
        {
          currency: string;
          grossMarkup: number;
          superuserFee: number;
          ownerNet: number;
          ownerPaid: number;
          ownerPending: number;
          trades: number;
        }
      >();
      const totalsByCurrency = new Map<
        string,
        {
          currency: string;
          grossMarkup: number;
          superuserFee: number;
          ownerNet: number;
          ownerPaid: number;
          ownerPending: number;
          tradeCount: number;
          attributedTrades: number;
          unattributedTrades: number;
        }
      >();

      for (const row of ledger || []) {
        const currency = row.currency || "USD";
        const gross = Number(row.gross_markup_amount || 0);
        const sup = Number(row.superuser_fee_amount || 0);
        const net = Number(row.owner_net_amount || 0);

        const total = totalsByCurrency.get(currency) || {
          currency,
          grossMarkup: 0,
          superuserFee: 0,
          ownerNet: 0,
          ownerPaid: 0,
          ownerPending: 0,
          tradeCount: 0,
          attributedTrades: 0,
          unattributedTrades: 0,
        };
        total.grossMarkup += gross;
        total.superuserFee += sup;
        total.ownerNet += net;
        if (row.payout_status === "paid") total.ownerPaid += net;
        else total.ownerPending += net;
        total.tradeCount += 1;
        if (row.attribution_status === "attributed") total.attributedTrades += 1;
        else total.unattributedTrades += 1;
        totalsByCurrency.set(currency, total);

        if (row.site_id) {
          const sc = siteCommissions.get(row.site_id) || {
            currency,
            grossMarkup: 0,
            superuserFee: 0,
            ownerNet: 0,
            ownerPaid: 0,
            ownerPending: 0,
            trades: 0,
          };
          sc.grossMarkup += gross;
          sc.superuserFee += sup;
          sc.ownerNet += net;
          if (row.payout_status === "paid") sc.ownerPaid += net;
          else sc.ownerPending += net;
          sc.trades += 1;
          siteCommissions.set(row.site_id, sc);
        }
      }

      const scopes = Array.isArray(cred?.api_token_scopes) ? cred.api_token_scopes : [];

      return json({
        credential: {
          connected: Boolean(cred?.api_token_encrypted),
          loginId: cred?.deriv_loginid || null,
          email: cred?.deriv_email || null,
          scopes,
          hasAdminScope: scopes.includes("admin"),
          hasReadScope: scopes.includes("read"),
          wsAppId: cred?.ws_app_id || "",
          defaultCallbackUri: cred?.default_callback_uri || DEFAULT_CALLBACK_URI,
          defaultHomepageUri: cred?.default_homepage_uri || DEFAULT_HOMEPAGE_URI,
          defaultVerificationUri: cred?.default_verification_uri || DEFAULT_VERIFICATION_URI,
          defaultPlatformFeeRate: Number(cred?.default_platform_fee_rate ?? 17),
          lastVerifiedAt: cred?.last_verified_at || null,
          lastSyncedAt: cred?.last_synced_at || null,
          lastError: cred?.last_error || null,
        },
        apps: (apps || []).map((app) => ({
          id: app.id,
          name: app.name,
          appId: app.app_id,
          oauthClientId: app.oauth_client_id,
          hasClientSecret: Boolean(app.client_secret_encrypted),
          callbackUri: app.callback_uri,
          environment: app.environment,
          markupPercentage: Number(app.markup_percentage),
          configuredScopes: app.configured_scopes || [],
          registrationSource: app.registration_source,
          isDefault: app.is_default,
          isActive: app.is_active,
          notes: app.notes || "",
          assignedSiteCount: siteCountByPoolApp.get(app.id) || 0,
          updatedAt: app.updated_at,
        })),
        sites: (sites || []).map((s) => {
          const owner = profileMap.get(s.user_id);
          const da = siteDerivMap.get(s.id);
          const tc = traderCountBySite.get(s.id) || { real: 0, demo: 0 };
          const sc = siteCommissions.get(s.id);
          return {
            id: s.id,
            name: s.name,
            status: s.status,
            hostname: domainMap.get(s.id) || null,
            ownerEmail: owner?.email || "Unknown",
            ownerDerivLoginId: s.owner_deriv_loginid || null,
            derivMode: s.deriv_mode,
            requestedMarkupRate: Number(s.requested_markup_rate ?? 2.5),
            appliedMarkupRate: da?.markup_rate !== null && da?.markup_rate !== undefined
              ? Number(da.markup_rate)
              : null,
            assignedAppId: da?.app_id || null,
            callbackUri: da?.callback_uri || null,
            platformFeeRate: Number(s.platform_fee_rate ?? 17),
            realTraders: tc.real,
            demoTraders: tc.demo,
            currency: sc?.currency || "USD",
            grossMarkup: sc?.grossMarkup || 0,
            superuserFee: sc?.superuserFee || 0,
            ownerNet: sc?.ownerNet || 0,
            ownerPaid: sc?.ownerPaid || 0,
            ownerPending: sc?.ownerPending || 0,
            tradeCount: sc?.trades || 0,
          };
        }),
        totals: Array.from(totalsByCurrency.values()),
      });
    }

    // -----------------------------------------------------------------------
    // Action: save_superuser_token
    // -----------------------------------------------------------------------
    if (action === "save_superuser_token") {
      const rawToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
      const clearToken = body.clearToken === true;
      // App IDs are OAuth 2.0 client IDs and are alphanumeric. There is no
      // numeric-only form any more, and no default: sending a made-up ID would
      // make the REST check fail on the app header instead of the token.
      const submittedAppId = typeof body.wsAppId === "string" ? body.wsAppId.trim() : "";
      if (submittedAppId && !/^[A-Za-z0-9_-]{4,64}$/.test(submittedAppId)) {
        return json({ error: "Deriv App ID must be 4-64 characters, letters and digits" }, 400);
      }
      const defaultCallbackUri = validateHttpsUrl(body.defaultCallbackUri, DEFAULT_CALLBACK_URI);
      const defaultHomepageUri = validateHttpsUrl(body.defaultHomepageUri, DEFAULT_HOMEPAGE_URI);
      const defaultVerificationUri = validateHttpsUrl(
        body.defaultVerificationUri,
        DEFAULT_VERIFICATION_URI,
      );
      const defaultPlatformFeeRate = clampFeeRate(body.defaultPlatformFeeRate, 17);

      // The App ID column is NOT NULL and scopes every REST call, so an existing
      // value is reused rather than cleared when the field is left blank.
      const { data: currentCredential } = await admin
        .from("superuser_deriv_credentials")
        .select("ws_app_id")
        .eq("singleton_key", "primary")
        .maybeSingle();
      const storedAppId = String(currentCredential?.ws_app_id || "").trim();
      const effectiveAppId = submittedAppId || storedAppId;

      const patch: Record<string, unknown> = {
        singleton_key: "primary",
        default_callback_uri: defaultCallbackUri,
        default_homepage_uri: defaultHomepageUri,
        default_verification_uri: defaultVerificationUri,
        default_platform_fee_rate: defaultPlatformFeeRate,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      };
      if (effectiveAppId) patch.ws_app_id = effectiveAppId;

      let verifiedAccount: { loginid: string; email: string; scopes: string[] } | null = null;

      if (clearToken) {
        patch.api_token_encrypted = null;
        patch.api_token_scopes = [];
        patch.deriv_loginid = null;
        patch.deriv_email = null;
        patch.deriv_user_id = null;
        patch.last_error = null;
      } else if (rawToken) {
        // Verify over the new platform's REST API. No WebSocket call is made
        // anywhere in this function: the legacy hosts are unreachable and the
        // legacy methods are gone from the codebase.
        const appIdForCheck = effectiveAppId;
        if (!appIdForCheck) {
          return json(
            {
              error: "Deriv App ID is required to verify a token: the new platform identifies the app with a Deriv-App-ID header.",
            },
            400,
          );
        }
        const verification = await verifyOperatorTokenOverRest(rawToken, appIdForCheck);
        if (!verification.reachable) {
          patch.api_token_encrypted = await encryptSecret(rawToken);
          patch.api_token_scopes = [];
          patch.last_verified_at = null;
          patch.last_error = verification.detail;
        } else if (verification.status !== 200) {
          // Deriv answered and rejected it: do not store a token that cannot work.
          patch.api_token_encrypted = null;
          patch.api_token_scopes = [];
          patch.last_verified_at = null;
          patch.last_error = verification.detail;
        } else {
          patch.api_token_encrypted = await encryptSecret(rawToken);
          patch.api_token_scopes = DERIV_OPERATOR_SCOPES;
          patch.deriv_loginid = verification.accounts[0]?.accountId || null;
          patch.deriv_email = null;
          patch.deriv_user_id = null;
          patch.last_verified_at = new Date().toISOString();
          patch.last_error = null;
          verifiedAccount = {
            loginid: verification.accounts[0]?.accountId || "",
            email: "",
            scopes: DERIV_OPERATOR_SCOPES,
          };
        }
      }

      const { error } = await admin
        .from("superuser_deriv_credentials")
        .upsert(patch, { onConflict: "singleton_key" });
      if (error) throw error;

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: clearToken
          ? "superuser.deriv.disconnected"
          : rawToken
            ? "superuser.deriv.connected"
            : "superuser.deriv.settings_updated",
        metadata: {
          loginId: verifiedAccount?.loginid,
          scopes: verifiedAccount?.scopes,
          defaultCallbackUri,
          defaultPlatformFeeRate,
        },
      });

      return json({
        ok: true,
        verifiedAccount,
        defaultCallbackUri,
        defaultPlatformFeeRate,
      });
    }

    // -----------------------------------------------------------------------
    // Action: upsert_pool_app (Manual add/edit v2 DevHub App ID or v1/v2 App)
    // -----------------------------------------------------------------------
    if (action === "upsert_pool_app") {
      const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
      const appId = String(body.appId || "").trim();
      const oauthClientId = String(body.oauthClientId || appId).trim();
      const markupPercentage = clampMarkup(body.markupPercentage, 2.5);
      const name =
        (typeof body.name === "string" && body.name.trim()) ||
        `DSites Pool (${markupPercentage}% Markup)`;
      const callbackUri = validateHttpsUrl(body.callbackUri, DEFAULT_CALLBACK_URI);
      const environment = body.environment === "staging" ? "staging" : "production";
      const isDefault = body.isDefault === true;
      const isActive = body.isActive !== false;
      const notes = typeof body.notes === "string" ? body.notes.trim() : null;
      const clientSecret =
        typeof body.clientSecret === "string" && body.clientSecret.trim()
          ? body.clientSecret.trim()
          : null;
      const scopes =
        Array.isArray(body.configuredScopes) && body.configuredScopes.length > 0
          ? [...new Set(body.configuredScopes.map(String).filter(Boolean))]
          : DEFAULT_OAUTH_SCOPES;

      if (!appId) return json({ error: "v2 DevHub App ID is required" }, 400);

      // app_update is a legacy-only WebSocket method with no new-platform
      // equivalent, so the app cannot be pushed to Deriv from here. The value is
      // stored locally and the caller is told the sync did not happen.
      const syncedToDeriv = false;
      const syncWarning =
        body.syncToDeriv === true
          ? "Not pushed to Deriv: app_update exists only on the legacy WebSocket API. Edit the app's markup and redirect URI in the Deriv dashboard instead."
          : null;

      if (isDefault) {
        await admin
          .from("platform_deriv_apps")
          .update({ is_default: false })
          .eq("environment", environment)
          .eq("is_default", true);
      }

      const rowPayload: Record<string, unknown> = {
        name: name.slice(0, 120),
        app_id: appId,
        oauth_client_id: oauthClientId,
        callback_uri: callbackUri,
        environment,
        markup_percentage: markupPercentage,
        configured_scopes: scopes,
        is_default: isDefault,
        is_active: isActive,
        notes,
        updated_at: new Date().toISOString(),
      };
      if (clientSecret) {
        rowPayload.client_secret_encrypted = await encryptSecret(clientSecret);
      }
      if (!id) {
        rowPayload.created_by = user.id;
        rowPayload.registration_source = "manual";
      }

      const query = id
        ? admin.from("platform_deriv_apps").update(rowPayload).eq("id", id)
        : admin
            .from("platform_deriv_apps")
            .upsert(rowPayload, { onConflict: "app_id,environment" });

      const { data: savedApp, error } = await query
        .select("id, name, app_id, oauth_client_id, callback_uri, environment, markup_percentage, is_default, is_active")
        .single();
      if (error) throw error;

      const { data: rebalanced } = await admin.rpc("rebalance_platform_deriv_assignments");

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.upserted",
        metadata: {
          poolAppId: savedApp.id,
          appId: savedApp.app_id,
          markupPercentage,
          syncedToDeriv,
          syncWarning,
          rebalancedSites: rebalanced ?? 0,
        },
      });

      return json({
        app: savedApp,
        syncedToDeriv,
        rebalancedSites: rebalanced ?? 0,
      });
    }

    // -----------------------------------------------------------------------
    // Action: auto_generate_app (Programmatically register Deriv App via API)
    // -----------------------------------------------------------------------
    if (action === "auto_generate_app") {
      // app_register is a legacy-only WebSocket method. It has been removed along
      // with the rest of the legacy stack, so this action cannot create an app.
      return json(
        {
          error: "deriv_app_registration_unavailable",
          message: APP_REGISTRATION_REMOVED,
          legacyRemoved: true,
          manualAlternative:
            "Register the application at developers.deriv.com, then add its App ID with upsert_pool_app.",
        },
        503,
      );
    }

    // -----------------------------------------------------------------------
    // Action: auto_generate_tier_pool (One-click DForge 0%-3% Tier Pool)
    // -----------------------------------------------------------------------
    if (action === "auto_generate_tier_pool") {
      // The tier pool was built by registering one app per markup tier with
      // app_register. That is legacy-only and has been removed, so no tier apps
      // can be created here. Tiers are now expressed per site instead
      // (sites.requested_markup_rate), not as separate Deriv apps.
      return json(
        {
          error: "deriv_app_registration_unavailable",
          message: APP_REGISTRATION_REMOVED,
          legacyRemoved: true,
          manualAlternative:
            "Register each markup tier's application at developers.deriv.com and add them with upsert_pool_app. Tiers no longer need separate apps for billing: per-site markup is recorded per site.",
        },
        503,
      );
    }

    if (action === "import_deriv_apps") {
      // Importing the account's apps used app_list, a legacy-only WebSocket
      // method. The new platform's application_read scope cannot be used to
      // fetch them either: it has no reachable endpoint (every /applications
      // path returns 404). Apps are added explicitly with upsert_pool_app.
      return json(
        {
          error: "deriv_app_list_unavailable",
          message:
            "Listing Deriv applications is unavailable: app_list exists only on the legacy WebSocket API, and the new platform exposes no applications endpoint. Add each app ID manually under Add app.",
          legacyRemoved: true,
          manualAlternative: "Add apps with upsert_pool_app.",
        },
        503,
      );
    }

    // -----------------------------------------------------------------------
    // Action: delete_pool_app
    // -----------------------------------------------------------------------
    if (action === "delete_pool_app") {
      const id = String(body.id || "").trim();
      if (!id) return json({ error: "Pool app id is required" }, 400);

      const { error } = await admin.from("platform_deriv_apps").delete().eq("id", id);
      if (error) throw error;

      const { data: rebalanced } = await admin.rpc("rebalance_platform_deriv_assignments");
      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.deleted",
        metadata: { poolAppId: id, rebalancedSites: rebalanced ?? 0 },
      });

      return json({ deleted: true, rebalancedSites: rebalanced ?? 0 });
    }

    // -----------------------------------------------------------------------
    // Action: sync_commissions (Pull Deriv app_markup_details & attribute per site!)
    // -----------------------------------------------------------------------
    if (action === "sync_commissions") {
      // Commission attribution used app_markup_details, a legacy-only WebSocket
      // method. Beyond being unreachable, it is also unusable by design now: it
      // reports markup per app_id, and the platform serves every site from one
      // shared app, so the totals could not be split per site anyway.
      //
      // Per-site attribution does not depend on it. Trader-to-site attribution is
      // recorded continuously by deriv-trader-accounts (site_trader_attributions)
      // on the new platform, and per-site rates live on the sites row
      // (requested_markup_rate, platform_fee_rate, deriv_affiliate_id).
      return json(
        {
          error: "deriv_markup_reporting_unavailable",
          message:
            "Markup reporting is unavailable: app_markup_details exists only on the legacy WebSocket API. Per-site attribution is captured from trader account activity instead, and per-site rates are stored per site.",
          legacyRemoved: true,
        },
        503,
      );
    }

    // -----------------------------------------------------------------------
    // Action: update_deriv_application_callback
    //
    // Deriv rejects a login whose redirect_uri is not registered on the OAuth
    // 2.0 client, with "does not match any of the OAuth 2.0 Client's
    // pre-registered redirect urls". The platform controls the value it sends,
    // so it can be corrected here instead of in DevHub -- which matters because
    // the registered URI may already be the tenant origin (trader logins go
    // through the tenant's own /api/deriv-oauth-callback rewrite).
    //
    // Written in all three places the flow reads it from, so a later rebind
    // cannot restore the stale value.
    // -----------------------------------------------------------------------
    if (action === "update_deriv_application_callback") {
      const siteId = String(body.siteId || "").trim();
      if (!siteId) return json({ error: "siteId is required" }, 400);
      const callbackUri = validateHttpsUrl(body.callbackUri, DEFAULT_CALLBACK_URI);

      const { data: application, error: readError } = await admin
        .from("deriv_applications")
        .select("id, app_id, callback_uri, platform_deriv_app_id")
        .eq("site_id", siteId)
        .maybeSingle();
      if (readError) throw readError;
      if (!application) {
        return json(
          { error: "This site has no Deriv application assigned yet. Add one under Pool apps first." },
          404,
        );
      }

      const unchanged = application.callback_uri === callbackUri;
      const nowIso = new Date().toISOString();

      if (!unchanged) {
        const { error } = await admin
          .from("deriv_applications")
          .update({ callback_uri: callbackUri, updated_at: nowIso })
          .eq("id", application.id);
        if (error) throw error;
      }

      // site_deriv_apps mirrors the value for the admin/site views.
      await admin.from("site_deriv_apps").update({ redirect_uri: callbackUri }).eq("site_id", siteId);

      if (application.platform_deriv_app_id) {
        await admin
          .from("platform_deriv_apps")
          .update({ callback_uri: callbackUri, updated_at: nowIso })
          .eq("id", application.platform_deriv_app_id);
      }

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.callback_uri_updated",
        siteId,
        metadata: {
          appId: application.app_id,
          previousCallbackUri: application.callback_uri,
          callbackUri,
          unchanged,
        },
      });

      return json({ callbackUri, callbackUpdated: !unchanged });
    }

    // -----------------------------------------------------------------------
    // Action: mark_payout (Mark site owner's accrued commissions as paid)
    // -----------------------------------------------------------------------
    if (action === "mark_payout") {
      const siteId = String(body.siteId || "").trim();
      const currency = typeof body.currency === "string" && body.currency.trim()
        ? body.currency.trim()
        : null;
      const payoutReference =
        typeof body.payoutReference === "string" && body.payoutReference.trim()
          ? body.payoutReference.trim()
          : `PAYOUT-${new Date().toISOString().slice(0, 10)}`;

      if (!siteId) return json({ error: "siteId is required" }, 400);

      let updateQuery = admin
        .from("site_commission_ledger")
        .update({
          payout_status: "paid",
          payout_reference: payoutReference,
          paid_at: new Date().toISOString(),
        })
        .eq("site_id", siteId)
        .in("payout_status", ["accrued", "approved"]);

      if (currency) updateQuery = updateQuery.eq("currency", currency);

      const { data: updated, error } = await updateQuery.select("id, owner_net_amount, currency");
      if (error) throw error;

      const totalPaid = (updated || []).reduce(
        (sum, row) => sum + Number(row.owner_net_amount || 0),
        0,
      );

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.commissions.payout_marked",
        siteId,
        metadata: { count: updated?.length || 0, totalPaid, currency, payoutReference },
      });

      return json({
        paidCount: updated?.length || 0,
        totalPaid,
        payoutReference,
      });
    }

    return json({ error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    console.error("manage-platform-deriv error", error);
    return json(
      { error: error instanceof Error ? error.message : "Operation failed" },
      500,
    );
  }
});
