import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_CALLBACK_URI = "https://dsites-admin.vercel.app/api/deriv-oauth-callback";
const DEFAULT_HOMEPAGE_URI = "https://dsites-admin.vercel.app";
const DEFAULT_VERIFICATION_URI = "https://dsites-admin.vercel.app/auth";
const DEFAULT_DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";
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

/**
 * Every callback URL a tenant app should accept, most specific first.
 *
 * A tenant's own hostname is the primary callback, because that is the origin a
 * trader signs in from and what `site_deriv_apps.redirect_uri` records. The
 * central platform callback is kept as a fallback so a login started on the
 * admin host still completes.
 */
const deriveCallbackUris = (primary: string, extras: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const candidate of [primary, ...extras]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uris.push(normalized);
  }
  return uris;
};

/**
 * Candidate Deriv app names for a tenant, in the order they will be attempted.
 *
 * app_register rejects duplicate names, rejects "deriv" anywhere in the name,
 * allows only [a-zA-Z0-9 _-], and caps the name at 48 characters. Each candidate
 * therefore stays inside that grammar and keeps the site tag so two similarly
 * named tenants can both be registered.
 */
const nameCandidates = (base: string, tag: string): string[] => {
  const clean = (value: string) =>
    value.replace(/[^a-zA-Z0-9 _-]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 48).trim();
  const candidates = [
    clean(base),
    clean(`${base} app`),
    clean(`${base} ${tag}`),
    clean(`Site ${tag}`),
  ];
  return [...new Set(candidates.filter((value) => value.length >= 3))];
};

const maskLoginId = (loginId: string | null | undefined): string => {
  if (!loginId) return "Unknown";
  if (loginId.length <= 5) return `${loginId.slice(0, 2)}***`;
  return `${loginId.slice(0, 2)}***${loginId.slice(-3)}`;
};

class DerivWsClient {
  private socket: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: number }
  >();

  constructor(private readonly appId = "1089") {}

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    const url = `${DEFAULT_DERIV_WS_URL}?app_id=${encodeURIComponent(this.appId || "1089")}`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error("Timed out connecting to Deriv WebSocket API"));
      }, 12_000);

      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Unable to reach Deriv WebSocket API"));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          const id = Number(data.req_id);
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          if (data.error && typeof data.error === "object") {
            const errObj = data.error as { message?: string; code?: string };
            entry.reject(
              new Error(errObj.message || errObj.code || "Deriv API returned an error"),
            );
          } else {
            entry.resolve(data);
          }
        } catch {
          // ignore malformed messages
        }
      };

      socket.onclose = () => {
        for (const [, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Deriv WebSocket connection closed unexpectedly"));
        }
        this.pending.clear();
      };
    });
  }

  async request(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Deriv WebSocket is not open");
    }
    const id = this.reqId++;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Deriv API request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  async authorize(token: string): Promise<{
    loginid: string;
    email: string;
    userId: string;
    scopes: string[];
    validUntil: string | null;
  }> {
    const res = await this.request({ authorize: token });
    const auth = (res.authorize || {}) as Record<string, unknown>;
    // token_validity is reported in seconds remaining by the WebSocket API.
    const validitySeconds = Number(auth.token_validity);
    const validUntil =
      Number.isFinite(validitySeconds) && validitySeconds > 0
        ? new Date(Date.now() + validitySeconds * 1000).toISOString()
        : null;
    return {
      loginid: String(auth.loginid || ""),
      email: String(auth.email || ""),
      userId: auth.user_id !== undefined ? String(auth.user_id) : "",
      scopes: Array.isArray(auth.scopes) ? auth.scopes.map(String) : [],
      validUntil,
    };
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
  }
}

const getAuthorizedSuperuserClient = async (
  admin: ReturnType<typeof supabaseAdmin>,
  requireAdminScope = false,
) => {
  const { data: cred } = await admin
    .from("superuser_deriv_credentials")
    .select("*")
    .eq("singleton_key", "primary")
    .maybeSingle();

  if (!cred?.api_token_encrypted) {
    throw new Error(
      "Connect your Superuser Deriv API Token first (create one at app.deriv.com/account/api-token with Read + Admin scopes).",
    );
  }

  const token = await decryptSecret(cred.api_token_encrypted);
  const ws = new DerivWsClient(cred.ws_app_id || "1089");
  const auth = await ws.authorize(token);
  if (requireAdminScope && !auth.scopes.includes("admin")) {
    ws.close();
    throw new Error(
      "Your connected Deriv API token does not include the 'admin' scope required to register or update Deriv applications.",
    );
  }
  return { cred, ws, auth };
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

type AdminClient = ReturnType<typeof supabaseAdmin>;

type SiteRegistrationResult = {
  status: number;
  payload: Record<string, unknown>;
};

/**
 * Register one Deriv OAuth app for one tenant site and pin it to that site.
 *
 * The platform owner holds the DevHub account and pays each tenant their share
 * after the platform fee, so every tenant needs its own App ID, client ID and
 * callback: attribution is then one app to one site, which is what makes the
 * split auditable. The app is bound with `bind_platform_deriv_app_to_site` and is
 * deliberately never fed through `rebalance_platform_deriv_assignments`, which
 * could move the tenant's traffic onto somebody else's app.
 */
const registerSiteDerivApp = async (input: {
  admin: AdminClient;
  userId: string;
  siteId: string;
}): Promise<SiteRegistrationResult> => {
  const { admin, userId, siteId } = input;

  const { data: site } = await admin
    .from("sites")
    .select("id, name, status, organisation_id, deriv_mode, requested_markup_rate, site_domains(hostname, status)")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) return { status: 404, payload: { error: "Site not found" } };
  if (site.status === "deleted") return { status: 400, payload: { error: "Site is deleted" } };
  if (site.deriv_mode === "custom") {
    return {
      status: 409,
      payload: {
        error:
          "This site runs its own Deriv application; clear custom mode before registering a platform app",
      },
    };
  }

  // Re-registering would leave the tenant with two apps and split their markup.
  const { data: existingBinding } = await admin
    .from("site_deriv_apps")
    .select("platform_deriv_app_id")
    .eq("site_id", siteId)
    .maybeSingle();
  if (existingBinding?.platform_deriv_app_id) {
    const { data: existingApp } = await admin
      .from("platform_deriv_apps")
      .select("id, name, app_id, oauth_client_id, callback_uri, markup_percentage")
      .eq("id", existingBinding.platform_deriv_app_id)
      .maybeSingle();
    if (existingApp) {
      return {
        status: 200,
        payload: {
          status: "already_registered",
          app: {
            id: existingApp.id,
            name: existingApp.name,
            appId: existingApp.app_id,
            oauthClientId: existingApp.oauth_client_id,
            callbackUri: existingApp.callback_uri,
            markupPercentage: Number(existingApp.markup_percentage),
          },
          site: { id: site.id, name: site.name },
        },
      };
    }
  }

  const markupPercentage = clampMarkup(site.requested_markup_rate, 2.5);
  const { cred, ws } = await getAuthorizedSuperuserClient(admin, true);

  const liveHost = (
    (site.site_domains as Array<{ hostname: string; status: string }> | null) || []
  ).find((row) => row.status === "active" || row.status === "verified");
  const siteCallback = liveHost ? `https://${liveHost.hostname}/api/deriv-oauth-callback` : null;
  const callbacks = deriveCallbackUris(cred.default_callback_uri || DEFAULT_CALLBACK_URI, [siteCallback]);

  const siteTag = siteId.replace(/-/g, "").slice(0, 6);
  const baseName =
    `${site.name || "Site"} ${siteTag}`.replace(/deriv/gi, "DSites").replace(/[^a-zA-Z0-9 _-]/g, "").trim() ||
    `DSites ${siteTag}`;

  const attemptedNames: string[] = [];
  const attemptedCallbacks: string[] = [];
  let registered: { appId: string; name: string; callbackUri: string } | null = null;

  try {
    for (const candidateName of nameCandidates(baseName, siteTag)) {
      attemptedNames.push(candidateName);
      for (const callbackUri of callbacks) {
        attemptedCallbacks.push(callbackUri);
        try {
          const res = await ws.request({
            app_register: 1,
            name: candidateName,
            scopes: ["read", "trade", "trading_information", "payments", "admin"],
            redirect_uri: callbackUri,
            verification_uri: cred.default_verification_uri || DEFAULT_VERIFICATION_URI,
            homepage: cred.default_homepage_uri || DEFAULT_HOMEPAGE_URI,
            app_markup_percentage: markupPercentage,
          });
          const reg = (res.app_register || {}) as Record<string, unknown>;
          const appId = String(reg.app_id || "").trim();
          if (!appId) throw new Error("Deriv did not return an app_id");
          registered = { appId, name: candidateName, callbackUri };
          break;
        } catch (registerError) {
          const message =
            registerError instanceof Error ? registerError.message : "Failed to register app";
          // Deriv reports duplicate names and unusable callback URLs here. Both are
          // recoverable by trying the next candidate, so keep going; anything else
          // is a real failure (auth, scope, outage) and must surface immediately.
          if (!/name|redirect|callback|url|uri|invalid|exist/i.test(message)) throw registerError;
        }
      }
      if (registered) break;
    }
  } finally {
    ws.close();
  }

  if (!registered) {
    await admin
      .from("superuser_deriv_credentials")
      .update({
        last_error: `Deriv refused to register an app for ${site.name}`,
        updated_at: new Date().toISOString(),
      })
      .eq("singleton_key", "primary");
    return {
      status: 502,
      payload: {
        error: "Deriv did not register the application",
        attemptedNames,
        attemptedCallbacks,
      },
    };
  }

  const { data: savedApp, error: saveError } = await admin
    .from("platform_deriv_apps")
    .upsert(
      {
        name: registered.name,
        app_id: registered.appId,
        oauth_client_id: registered.appId,
        callback_uri: registered.callbackUri,
        environment: "production",
        markup_percentage: markupPercentage,
        configured_scopes: DEFAULT_OAUTH_SCOPES,
        registration_source: "auto_registered",
        is_default: false,
        is_active: true,
        notes: `Tenant app for site ${site.name} (${siteId})`,
        created_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "app_id,environment" },
    )
    .select("id, name, app_id, oauth_client_id, callback_uri, markup_percentage")
    .single();
  if (saveError) throw saveError;

  const { error: bindError } = await admin.rpc("bind_platform_deriv_app_to_site", {
    _site_id: siteId,
    _platform_deriv_app_id: savedApp.id,
    _markup_percentage: markupPercentage,
    _scopes: DEFAULT_OAUTH_SCOPES,
  });
  if (bindError) throw bindError;

  await auditLog(admin, {
    userId,
    actorType: "platform_admin",
    action: "superuser.deriv_pool.site_app_registered",
    siteId,
    organisationId: site.organisation_id,
    metadata: { appId: registered.appId, markupPercentage, callbackUri: registered.callbackUri },
  });

  return {
    status: 200,
    payload: {
      status: "registered",
      app: {
        id: savedApp.id,
        name: savedApp.name,
        appId: savedApp.app_id,
        oauthClientId: savedApp.oauth_client_id,
        callbackUri: savedApp.callback_uri,
        markupPercentage: Number(savedApp.markup_percentage),
      },
      site: { id: site.id, name: site.name },
      // Deriv's app_register sets one redirect URL. Any further callback (the
      // central one, or a hostname added later) has to be added in DevHub.
      registrationWarnings:
        callbacks.length > 1
          ? [
              `Registered callback: ${registered.callbackUri}. Add the remaining URL(s) to this app in DevHub: ${callbacks
                .filter((uri) => uri !== registered.callbackUri)
                .join(", ")}`,
            ]
          : [],
    },
  };
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
            "id, name, app_id, oauth_client_id, client_secret_encrypted, legacy_app_id, callback_uri, environment, markup_percentage, configured_scopes, registration_source, is_default, is_active, notes, created_at, updated_at",
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
          .select("site_id, app_id, oauth_client_id, markup_rate, source_type, verification_status"),
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
          wsAppId: cred?.ws_app_id || "1089",
          defaultCallbackUri: cred?.default_callback_uri || DEFAULT_CALLBACK_URI,
          defaultHomepageUri: cred?.default_homepage_uri || DEFAULT_HOMEPAGE_URI,
          defaultVerificationUri: cred?.default_verification_uri || DEFAULT_VERIFICATION_URI,
          defaultPlatformFeeRate: Number(cred?.default_platform_fee_rate ?? 17),
          lastVerifiedAt: cred?.last_verified_at || null,
          tokenValidUntil: cred?.api_token_valid_until || null,
          tokenDaysRemaining: cred?.api_token_valid_until
            ? Math.floor(
                (new Date(cred.api_token_valid_until).getTime() - Date.now()) / 86_400_000,
              )
            : null,
          lastSyncedAt: cred?.last_synced_at || null,
          lastError: cred?.last_error || null,
        },
        apps: (apps || []).map((app) => ({
          id: app.id,
          name: app.name,
          appId: app.app_id,
          oauthClientId: app.oauth_client_id,
          hasClientSecret: Boolean(app.client_secret_encrypted),
          legacyAppId: app.legacy_app_id || null,
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
      const wsAppId =
        typeof body.wsAppId === "string" && /^\d{1,12}$/.test(body.wsAppId.trim())
          ? body.wsAppId.trim()
          : "1089";
      const defaultCallbackUri = validateHttpsUrl(body.defaultCallbackUri, DEFAULT_CALLBACK_URI);
      const defaultHomepageUri = validateHttpsUrl(body.defaultHomepageUri, DEFAULT_HOMEPAGE_URI);
      const defaultVerificationUri = validateHttpsUrl(
        body.defaultVerificationUri,
        DEFAULT_VERIFICATION_URI,
      );
      const defaultPlatformFeeRate = clampFeeRate(body.defaultPlatformFeeRate, 17);

      const patch: Record<string, unknown> = {
        singleton_key: "primary",
        ws_app_id: wsAppId,
        default_callback_uri: defaultCallbackUri,
        default_homepage_uri: defaultHomepageUri,
        default_verification_uri: defaultVerificationUri,
        default_platform_fee_rate: defaultPlatformFeeRate,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      };

      let verifiedAccount: { loginid: string; email: string; scopes: string[] } | null = null;

      if (clearToken) {
        patch.api_token_encrypted = null;
        patch.api_token_scopes = [];
        patch.deriv_loginid = null;
        patch.deriv_email = null;
        patch.deriv_user_id = null;
        patch.last_error = null;
      } else if (rawToken) {
        const ws = new DerivWsClient(wsAppId);
        try {
          const auth = await ws.authorize(rawToken);
          patch.api_token_encrypted = await encryptSecret(rawToken);
          patch.api_token_scopes = auth.scopes;
          patch.deriv_loginid = auth.loginid || null;
          patch.deriv_email = auth.email || null;
          patch.deriv_user_id = auth.userId || null;
          patch.last_verified_at = new Date().toISOString();
          patch.last_error = null;
          // app.deriv.com caps tokens at 90 days; a silent expiry takes login down
          // for every tenant at once, so keep the window visible.
          patch.api_token_valid_until = auth.validUntil || null;
          verifiedAccount = { loginid: auth.loginid, email: auth.email, scopes: auth.scopes };
        } finally {
          ws.close();
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
      const legacyAppId =
        typeof body.legacyAppId === "string" && body.legacyAppId.trim()
          ? body.legacyAppId.trim()
          : null;
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

      // Optional live sync of markup + callback URL to Deriv via app_update
      let syncedToDeriv = false;
      if (body.syncToDeriv === true && /^\d+$/.test(appId)) {
        const { ws } = await getAuthorizedSuperuserClient(admin, true);
        try {
          await ws.request({
            app_update: Number(appId),
            name: name.slice(0, 48),
            scopes: ["read", "trade", "trading_information", "payments", "admin"],
            redirect_uri: callbackUri,
            verification_uri: DEFAULT_VERIFICATION_URI,
            homepage: DEFAULT_HOMEPAGE_URI,
            app_markup_percentage: markupPercentage,
          });
          syncedToDeriv = true;
        } finally {
          ws.close();
        }
      }

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
        legacy_app_id: legacyAppId,
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

      // Deliberately no rebalance: each tenant is pinned to its own app, and a
      // global re-assign would move tenants onto whichever app looks closest.
      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.upserted",
        metadata: {
          poolAppId: savedApp.id,
          appId: savedApp.app_id,
          markupPercentage,
          syncedToDeriv,
        },
      });

      return json({
        app: savedApp,
        syncedToDeriv,
        rebalancedSites: 0,
      });
    }

    // -----------------------------------------------------------------------
    // Action: auto_generate_app (Programmatically register Deriv App via API)
    // -----------------------------------------------------------------------
    if (action === "auto_generate_app") {
      const markupPercentage = clampMarkup(body.markupPercentage, 2.5);
      const isDefault = body.isDefault !== false;
      const { cred, ws } = await getAuthorizedSuperuserClient(admin, true);
      const callbackUri = validateHttpsUrl(
        body.callbackUri,
        cred.default_callback_uri || DEFAULT_CALLBACK_URI,
      );
      const rawName =
        (typeof body.name === "string" && body.name.trim()) ||
        `DSites Trading ${markupPercentage}pct`;
      // Deriv app_register forbids "deriv" in app names and caps length at 48 chars.
      const safeDerivName = rawName
        .replace(/deriv/gi, "DSites")
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .slice(0, 48) || `DSites Hub ${markupPercentage}`;

      try {
        const res = await ws.request({
          app_register: 1,
          name: safeDerivName,
          scopes: ["read", "trade", "trading_information", "payments", "admin"],
          redirect_uri: callbackUri,
          verification_uri: cred.default_verification_uri || DEFAULT_VERIFICATION_URI,
          homepage: cred.default_homepage_uri || DEFAULT_HOMEPAGE_URI,
          app_markup_percentage: markupPercentage,
        });

        const registered = (res.app_register || {}) as Record<string, unknown>;
        const newAppId = String(registered.app_id || "").trim();
        if (!newAppId) throw new Error("Deriv did not return an app_id");

        if (isDefault) {
          await admin
            .from("platform_deriv_apps")
            .update({ is_default: false })
            .eq("environment", "production")
            .eq("is_default", true);
        }

        const { data: saved, error } = await admin
          .from("platform_deriv_apps")
          .upsert(
            {
              name: safeDerivName,
              app_id: newAppId,
              oauth_client_id: newAppId,
              callback_uri: callbackUri,
              environment: "production",
              markup_percentage: markupPercentage,
              configured_scopes: DEFAULT_OAUTH_SCOPES,
              registration_source: "auto_registered",
              is_default: isDefault,
              is_active: true,
              created_by: user.id,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "app_id,environment" },
          )
          .select("id, name, app_id, oauth_client_id, callback_uri, markup_percentage, is_default")
          .single();
        if (error) throw error;

        // No rebalance: an unassigned app must not be pushed onto live tenants.
        await auditLog(admin, {
          userId: user.id,
          actorType: "platform_admin",
          action: "superuser.deriv_pool.auto_registered",
          metadata: { appId: newAppId, markupPercentage },
        });

        return json({ app: saved, rebalancedSites: 0 });
      } finally {
        ws.close();
      }
    }

    // -----------------------------------------------------------------------
    // Action: register_site_deriv_app (one Deriv app per tenant site)
    // -----------------------------------------------------------------------
    if (action === "register_site_deriv_app") {
      const siteId = String(body.siteId || "").trim();
      if (!siteId) return json({ error: "Site ID is required" }, 400);
      const result = await registerSiteDerivApp({ admin, userId: user.id, siteId });
      return json(result.payload, result.status);
    }

    // -----------------------------------------------------------------------
    // Action: register_all_site_deriv_apps (register every eligible tenant site)
    // -----------------------------------------------------------------------
    if (action === "register_all_site_deriv_apps") {
      const { data: cred } = await admin
        .from("superuser_deriv_credentials")
        .select("api_token_encrypted, api_token_scopes")
        .eq("singleton_key", "primary")
        .maybeSingle();
      if (!cred?.api_token_encrypted) {
        return json({ error: "Connect your Superuser Deriv API Token first" }, 409);
      }
      if (!Array.isArray(cred.api_token_scopes) || !cred.api_token_scopes.includes("admin")) {
        return json({ error: "The connected Deriv token is missing the 'admin' scope" }, 409);
      }

      const { data: sites } = await admin
        .from("sites")
        .select("id, name, status, deriv_mode")
        .neq("status", "deleted")
        .order("created_at", { ascending: true });
      const { data: bindings } = await admin
        .from("site_deriv_apps")
        .select("site_id, platform_deriv_app_id");
      const boundSites = new Set(
        (bindings || []).filter((row) => Boolean(row.platform_deriv_app_id)).map((row) => row.site_id),
      );
      const pending = (sites || []).filter(
        (row) => row.deriv_mode !== "custom" && !boundSites.has(row.id),
      );

      const registered: Array<{ siteId: string; siteName: string; appId: string }> = [];
      const failed: Array<{ siteId: string; siteName: string; message: string }> = [];

      // Sequential on purpose: app_register is rate limited and a partial result is
      // expected, so one tenant failing must not abort the rest.
      for (const row of pending) {
        const result = await registerSiteDerivApp({ admin, userId: user.id, siteId: row.id });
        const app = (result.payload.app || {}) as Record<string, unknown>;
        if (result.status === 200 && app.appId) {
          registered.push({ siteId: row.id, siteName: row.name, appId: String(app.appId) });
        } else {
          failed.push({
            siteId: row.id,
            siteName: row.name,
            message: String(result.payload.error || `Failed (${result.status})`),
          });
        }
      }

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.bulk_registered",
        metadata: { registeredCount: registered.length, failedCount: failed.length },
      });

      return json({ registered, failed, skipped: boundSites.size });
    }

    // -----------------------------------------------------------------------
    // Action: repair_deriv_assignments (undo assignments that override a binding)
    // -----------------------------------------------------------------------
    if (action === "repair_deriv_assignments") {
      const { data: repaired, error } = await admin.rpc("repair_platform_deriv_assignments");
      if (error) throw error;
      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.deriv_pool.assignments_repaired",
        metadata: { repairedSites: repaired ?? 0 },
      });
      return json({ repairedSites: repaired ?? 0 });
    }

    // -----------------------------------------------------------------------
    // Action: import_deriv_apps (Import existing Deriv apps owned by superuser)
    // -----------------------------------------------------------------------
    if (action === "import_deriv_apps") {
      const { cred, ws } = await getAuthorizedSuperuserClient(admin, false);
      const fallbackCallback = cred.default_callback_uri || DEFAULT_CALLBACK_URI;
      try {
        const res = await ws.request({ app_list: 1 });
        const list = Array.isArray(res.app_list)
          ? (res.app_list as Array<Record<string, unknown>>)
          : [];

        let imported = 0;
        for (const item of list) {
          const appId = String(item.app_id || "").trim();
          if (!appId) continue;
          const name = String(item.name || `App ${appId}`).slice(0, 120);
          const markup = clampMarkup(item.app_markup_percentage, 0);
          const redirectUri =
            typeof item.redirect_uri === "string" && item.redirect_uri.startsWith("https://")
              ? item.redirect_uri
              : fallbackCallback;

          const { error } = await admin.from("platform_deriv_apps").upsert(
            {
              name,
              app_id: appId,
              oauth_client_id: appId,
              callback_uri: redirectUri,
              environment: "production",
              markup_percentage: markup,
              configured_scopes: DEFAULT_OAUTH_SCOPES,
              registration_source: "imported",
              is_active: true,
              created_by: user.id,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "app_id,environment" },
          );
          if (!error) imported += 1;
        }

        await auditLog(admin, {
          userId: user.id,
          actorType: "platform_admin",
          action: "superuser.deriv_pool.imported",
          metadata: { imported, totalFound: list.length },
        });

        return json({ imported, totalFound: list.length, rebalancedSites: 0 });
      } finally {
        ws.close();
      }
    }

    // -----------------------------------------------------------------------
    // Action: delete_pool_app
    // -----------------------------------------------------------------------
    if (action === "delete_pool_app") {
      const id = String(body.id || "").trim();
      if (!id) return json({ error: "Pool app id is required" }, 400);

      const { error } = await admin.from("platform_deriv_apps").delete().eq("id", id);
      if (error) throw error;

      // Repair, not rebalance: only sites whose binding still points at a live app
      // are restored. Sites that genuinely lost their app stay unassigned instead
      // of being handed another tenant's application.
      const { data: rebalanced } = await admin.rpc("repair_platform_deriv_assignments");
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
      const now = new Date();
      const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10);
      const defaultTo = now.toISOString().slice(0, 10);
      const dateFrom =
        typeof body.dateFrom === "string" && DATE_PATTERN.test(body.dateFrom)
          ? body.dateFrom
          : defaultFrom;
      const dateTo =
        typeof body.dateTo === "string" && DATE_PATTERN.test(body.dateTo)
          ? body.dateTo
          : defaultTo;

      if (dateFrom > dateTo) {
        return json({ error: "dateFrom must be on or before dateTo" }, 400);
      }

      const { data: poolApps } = await admin
        .from("platform_deriv_apps")
        .select("id, app_id, markup_percentage")
        .eq("is_active", true);

      if (!poolApps?.length) {
        return json({ error: "Add or generate at least one Deriv App in the pool first." }, 409);
      }

      const [{ data: allAttributions }, { data: allSites }] = await Promise.all([
        admin
          .from("site_trader_attributions")
          .select("site_id, organisation_id, deriv_app_id, deriv_loginid, first_seen_at, last_seen_at")
          .order("last_seen_at", { ascending: false }),
        admin.from("sites").select("id, organisation_id, platform_fee_rate"),
      ]);

      const siteMap = new Map((allSites || []).map((s) => [s.id, s]));
      const attrByLogin = new Map<
        string,
        Array<{ site_id: string; organisation_id: string; deriv_app_id: string; last_seen_at: string }>
      >();
      for (const a of allAttributions || []) {
        const key = a.deriv_loginid.toUpperCase();
        const arr = attrByLogin.get(key) || [];
        arr.push(a);
        attrByLogin.set(key, arr);
      }

      const { cred, ws } = await getAuthorizedSuperuserClient(admin, false);
      let processed = 0;
      let attributed = 0;
      let unattributed = 0;
      const appErrors: Array<{ appId: string; message: string }> = [];

      try {
        for (const app of poolApps) {
          if (!/^\d+$/.test(app.app_id)) continue;
          try {
            let offset = 0;
            const limit = 500;
            for (let page = 0; page < 10; page += 1) {
              const res = await ws.request({
                app_markup_details: 1,
                app_id: Number(app.app_id),
                date_from: `${dateFrom} 00:00:00`,
                date_to: `${dateTo} 23:59:59`,
                description: 1,
                limit,
                offset,
              });
              const details = (res.app_markup_details || {}) as {
                transactions?: Array<Record<string, unknown>>;
              };
              const txns = Array.isArray(details.transactions) ? details.transactions : [];
              if (!txns.length) break;

              const upserts: Array<Record<string, unknown>> = [];
              for (const tx of txns) {
                const txId = String(
                  tx.transaction_id || tx.contract_id || `${tx.transaction_time}-${offset}-${upserts.length}`,
                );
                const clientLogin = String(tx.client_loginid || "").toUpperCase();
                const gross = Number(tx.app_markup_usd ?? tx.app_markup_value ?? tx.app_markup ?? 0);
                const currency = String(
                  tx.app_markup_usd !== undefined ? "USD" : tx.dev_currcode || tx.client_currcode || "USD",
                );
                const rawTime = tx.transaction_time;
                const tradedAt =
                  typeof rawTime === "number"
                    ? new Date(rawTime * 1000).toISOString()
                    : typeof rawTime === "string" && rawTime
                      ? new Date(rawTime.replace(" ", "T") + (rawTime.endsWith("Z") ? "" : "Z")).toISOString()
                      : new Date().toISOString();

                const candidates = clientLogin ? attrByLogin.get(clientLogin) || [] : [];
                const matched =
                  candidates.find((c) => c.deriv_app_id === app.app_id) || candidates[0] || null;
                const matchedSite = matched ? siteMap.get(matched.site_id) : null;

                if (matched && matchedSite) {
                  const feeRate = Number(
                    matchedSite.platform_fee_rate ?? cred.default_platform_fee_rate ?? 17,
                  );
                  const superFee = Math.round(((gross * feeRate) / 100) * 1_000_000) / 1_000_000;
                  const ownerNet = Math.round((gross - superFee) * 1_000_000) / 1_000_000;
                  attributed += 1;
                  upserts.push({
                    external_transaction_id: txId,
                    deriv_app_id: app.app_id,
                    platform_deriv_app_id: app.id,
                    site_id: matchedSite.id,
                    organisation_id: matchedSite.organisation_id,
                    client_loginid: clientLogin || null,
                    contract_id: tx.contract_id ? String(tx.contract_id) : null,
                    currency,
                    gross_markup_amount: gross,
                    applied_markup_rate: Number(app.markup_percentage),
                    platform_fee_rate: feeRate,
                    superuser_fee_amount: superFee,
                    owner_net_amount: ownerNet,
                    attribution_status: "attributed",
                    traded_at: tradedAt,
                    raw_payload: tx,
                    synchronized_at: new Date().toISOString(),
                  });
                } else {
                  unattributed += 1;
                  upserts.push({
                    external_transaction_id: txId,
                    deriv_app_id: app.app_id,
                    platform_deriv_app_id: app.id,
                    site_id: null,
                    organisation_id: null,
                    client_loginid: clientLogin || null,
                    contract_id: tx.contract_id ? String(tx.contract_id) : null,
                    currency,
                    gross_markup_amount: gross,
                    applied_markup_rate: Number(app.markup_percentage),
                    platform_fee_rate: 100,
                    superuser_fee_amount: gross,
                    owner_net_amount: 0,
                    attribution_status: "unattributed",
                    payout_status: "paid",
                    traded_at: tradedAt,
                    raw_payload: tx,
                    synchronized_at: new Date().toISOString(),
                  });
                }
              }

              if (upserts.length) {
                const { error: upsertErr } = await admin
                  .from("site_commission_ledger")
                  .upsert(upserts, { onConflict: "deriv_app_id,external_transaction_id" });
                if (upsertErr) throw upsertErr;
                processed += upserts.length;
              }

              if (txns.length < limit) break;
              offset += limit;
            }
          } catch (appErr) {
            appErrors.push({
              appId: app.app_id,
              message: appErr instanceof Error ? appErr.message : "Failed to fetch markup details",
            });
          }
        }
      } finally {
        ws.close();
      }

      await admin
        .from("superuser_deriv_credentials")
        .update({
          last_synced_at: new Date().toISOString(),
          last_error: appErrors[0]?.message || null,
        })
        .eq("singleton_key", "primary");

      await auditLog(admin, {
        userId: user.id,
        actorType: "platform_admin",
        action: "superuser.commissions.synchronized",
        metadata: { dateFrom, dateTo, processed, attributed, unattributed, errors: appErrors.length },
      });

      return json({
        dateFrom,
        dateTo,
        processed,
        attributed,
        unattributed,
        errors: appErrors,
        synchronizedAt: new Date().toISOString(),
      });
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
