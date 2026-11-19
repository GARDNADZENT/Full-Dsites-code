import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Register one Deriv OAuth application per tenant site.
 *
 * The platform owner holds the DevHub account and pays each tenant their share
 * after the platform fee (default 17%). That split is only auditable when
 * attribution maps one app to one site, so this function registers a per-tenant
 * app and pins it with `bind_platform_deriv_app_to_site`. It never rebalances:
 * `rebalance_platform_deriv_assignments` would move a tenant's traffic onto
 * whichever app happened to be closest, pooling two tenants' markup together.
 *
 * Actions
 *   register_site_deriv_app        { siteId }  -> one site
 *   register_all_site_deriv_apps   {}          -> every eligible tenant
 *   repair_deriv_assignments       {}          -> undo assignments that override
 *                                                 a site's pinned binding
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const DEFAULT_CALLBACK_URI = "https://dsites-admin.vercel.app/api/deriv-oauth-callback";
const DEFAULT_HOMEPAGE_URI = "https://dsites-admin.vercel.app";
const DEFAULT_VERIFICATION_URI = "https://dsites-admin.vercel.app/auth";
const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";

// The scopes a tenant app needs: trade for trading, account_manage for the
// trader's own account, application_read so the app can read its own metadata.
const APP_SCOPES = ["read", "trade", "trading_information", "payments", "admin"];
const CONFIGURED_SCOPES = ["trade", "account_manage", "application_read"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const fromBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const encryptionKey = async () => {
  const configured = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!configured) throw new Error("TOKEN_ENCRYPTION_KEY secret is not configured");
  const raw = fromBase64Url(configured);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const decryptSecret = async (value: string): Promise<string> => {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) throw new Error("Stored encrypted credential is invalid");
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await encryptionKey(),
    fromBase64Url(encrypted),
  );
  return DECODER.decode(clear);
};

const supabaseAdmin = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service configuration is missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

type Admin = ReturnType<typeof supabaseAdmin>;

const clampMarkup = (value: unknown, fallback = 2.5): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(3, Math.max(0, parsed)) * 100) / 100;
};

/** Minimal Deriv WebSocket RPC client, matching the platform pool implementation. */
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
    const url = `${DERIV_WS_URL}?app_id=${encodeURIComponent(this.appId || "1089")}`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error("Timed out connecting to the Deriv WebSocket API"));
      }, 12_000);

      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Unable to reach the Deriv WebSocket API"));
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
            entry.reject(new Error(errObj.message || errObj.code || "Deriv API returned an error"));
          } else {
            entry.resolve(data);
          }
        } catch {
          // ignore malformed frames
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

  async request(payload: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
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

  async authorize(token: string) {
    const res = await this.request({ authorize: token });
    const auth = (res.authorize || {}) as Record<string, unknown>;
    return {
      loginid: String(auth.loginid || ""),
      scopes: Array.isArray(auth.scopes) ? auth.scopes.map(String) : [],
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

/**
 * Callback URLs for a tenant app, most specific first.
 *
 * Deriv's app_register stores a single redirect_uri, so the tenant's own
 * hostname is the right choice: that is the origin a trader signs in from and
 * the value `site_deriv_apps.redirect_uri` records. The central platform
 * callback is kept as an alternative so a login started on the admin host can
 * also complete.
 */
const deriveCallbackUris = (central: string, tenantHostname: string | null): string[] => {
  const candidates = [
    tenantHostname ? `https://${tenantHostname}/api/deriv-oauth-callback` : null,
    central,
  ];
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
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
 * Candidate app names, in the order they will be tried.
 *
 * app_register rejects duplicate names, rejects "deriv" anywhere in the name,
 * allows only [a-zA-Z0-9 _-], and caps the name at 48 characters. Tenants are
 * frequently named after Deriv tools, so every candidate is sanitised and keeps
 * the site tag so two similarly named tenants can both be registered.
 */
const nameCandidates = (siteName: string, tag: string): string[] => {
  const clean = (value: string) =>
    value
      .replace(/deriv/gi, "DSites")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 48)
      .trim();
  const base = clean(`${siteName || "Site"} ${tag}`) || `DSites ${tag}`;
  return [...new Set([base, clean(`${base} app`), clean(`${base} ${tag}`), clean(`Site ${tag}`)].filter(
    (value) => value.length >= 3,
  ))];
};

const auditLog = async (
  admin: Admin,
  input: { userId: string; action: string; siteId?: string | null; organisationId?: string | null; metadata?: Record<string, unknown> },
) => {
  await admin.from("audit_logs").insert({
    actor_user_id: input.userId,
    actor_type: "platform_admin",
    action: input.action,
    site_id: input.siteId || null,
    organisation_id: input.organisationId || null,
    provider: "deriv",
    correlation_id: crypto.randomUUID(),
    metadata: input.metadata || {},
  });
};

type RegistrationOutcome = {
  status: number;
  payload: Record<string, unknown>;
};

const registerSiteDerivApp = async (
  admin: Admin,
  userId: string,
  siteId: string,
): Promise<RegistrationOutcome> => {
  const { data: site } = await admin
    .from("sites")
    .select(
      "id, name, status, organisation_id, deriv_mode, requested_markup_rate, site_domains(hostname, status)",
    )
    .eq("id", siteId)
    .maybeSingle();
  if (!site) return { status: 404, payload: { error: "Site not found" } };
  if (site.status === "deleted") return { status: 400, payload: { error: "This site is deleted" } };
  if (site.deriv_mode === "custom") {
    return {
      status: 409,
      payload: {
        error:
          "This site runs its own Deriv application. Clear custom mode before registering a platform app.",
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

  const { data: cred } = await admin
    .from("superuser_deriv_credentials")
    .select("*")
    .eq("singleton_key", "primary")
    .maybeSingle();
  if (!cred?.api_token_encrypted) {
    return {
      status: 409,
      payload: {
        error:
          "Connect your Superuser Deriv API Token first (create one at app.deriv.com with Read + Admin scopes).",
        needsToken: true,
      },
    };
  }

  const token = await decryptSecret(cred.api_token_encrypted);
  const ws = new DerivWsClient(cred.ws_app_id || "1089");
  let registered: { appId: string; name: string; callbackUri: string } | null = null;
  const attemptedNames: string[] = [];
  const attemptedCallbacks: string[] = [];

  try {
    const auth = await ws.authorize(token);
    if (!auth.scopes.includes("admin")) {
      return {
        status: 409,
        payload: {
          error:
            "The connected Deriv token is missing the 'admin' scope, which app_register requires. Recreate the token with Read + Admin.",
          needsToken: true,
          scopes: auth.scopes,
        },
      };
    }

    const markupPercentage = clampMarkup(site.requested_markup_rate, 2.5);
    const tenantHost = (
      (site.site_domains as Array<{ hostname: string; status: string }> | null) || []
    ).find((row) => row.status === "active" || row.status === "verified")?.hostname;
    const callbacks = deriveCallbackUris(cred.default_callback_uri || DEFAULT_CALLBACK_URI, tenantHost || null);
    const tag = siteId.replace(/-/g, "").slice(0, 6);

    for (const candidateName of nameCandidates(site.name, tag)) {
      attemptedNames.push(candidateName);
      for (const callbackUri of callbacks) {
        attemptedCallbacks.push(callbackUri);
        try {
          const res = await ws.request({
            app_register: 1,
            name: candidateName,
            scopes: APP_SCOPES,
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
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to register the app";
          // Duplicate names and unusable callback URLs are recoverable with the
          // next candidate. Anything else (auth, scope, outage) must surface.
          if (!/name|redirect|callback|url|uri|invalid|exist/i.test(message)) throw error;
        }
      }
      if (registered) break;
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
          configured_scopes: CONFIGURED_SCOPES,
          registration_source: "auto_registered",
          // Never default: a default would invite a shared/tier reading of the pool.
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
      _scopes: CONFIGURED_SCOPES,
    });
    if (bindError) throw bindError;

    await auditLog(admin, {
      userId,
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
        // app_register stores one redirect URI. Any further callback has to be
        // added on the app in DevHub, so say so rather than fail silently later.
        registrationWarnings:
          callbacks.length > 1
            ? [
                `Registered callback: ${registered.callbackUri}. Add the other URL(s) to this app in DevHub: ${callbacks
                  .filter((uri) => uri !== registered.callbackUri)
                  .join(", ")}`,
              ]
            : [],
      },
    };
  } finally {
    ws.close();
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ error: "Authentication required" }, 401);
    }

    const admin = supabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, ""),
    );
    if (authError || !authData.user) return json({ error: "Invalid or expired session" }, 401);
    const user = authData.user;

    // Registering apps changes where tenant money is attributed: platform admins only.
    const { data: isAdmin } = await admin.rpc("is_platform_admin", { _user_id: user.id });
    if (!isAdmin) return json({ error: "Superuser admin permission is required" }, 403);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || "register_all_site_deriv_apps");

    if (action === "register_site_deriv_app") {
      const siteId = String(body.siteId || "").trim();
      if (!siteId) return json({ error: "siteId is required" }, 400);
      const result = await registerSiteDerivApp(admin, user.id, siteId);
      return json(result.payload, result.status);
    }

    if (action === "register_all_site_deriv_apps") {
      const { data: sites } = await admin
        .from("sites")
        .select("id, name, status, deriv_mode")
        .neq("status", "deleted")
        .order("created_at", { ascending: true });
      const { data: bindings } = await admin
        .from("site_deriv_apps")
        .select("site_id, platform_deriv_app_id");
      const bound = new Set(
        (bindings || []).filter((row) => Boolean(row.platform_deriv_app_id)).map((row) => row.site_id),
      );
      const pending = (sites || []).filter(
        (row) => row.deriv_mode !== "custom" && !bound.has(row.id),
      );

      const registered: Array<{ siteId: string; siteName: string; appId: string }> = [];
      const failed: Array<{ siteId: string; siteName: string; message: string }> = [];

      // Sequential: app_register is rate limited and a partial result is expected,
      // so one tenant failing must not abort the rest of the run.
      for (const row of pending) {
        const result = await registerSiteDerivApp(admin, user.id, row.id);
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
        action: "superuser.deriv_pool.bulk_registered",
        metadata: { registeredCount: registered.length, failedCount: failed.length },
      });

      return json({ registered, failed, skipped: bound.size });
    }

    if (action === "repair_deriv_assignments") {
      const { data: repaired, error } = await admin.rpc("repair_platform_deriv_assignments");
      if (error) throw error;
      await auditLog(admin, {
        userId: user.id,
        action: "superuser.deriv_pool.assignments_repaired",
        metadata: { repairedSites: repaired ?? 0 },
      });
      return json({ repairedSites: repaired ?? 0 });
    }

    return json({ error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    console.error("manage-site-deriv-apps failed", error);
    return json({ error: error instanceof Error ? error.message : "Operation failed" }, 500);
  }
});
