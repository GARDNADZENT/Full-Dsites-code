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

// The scopes a tenant app needs: trade for trading, account_manage for the
// trader's own account, application_read so the app can read its own metadata.
const CONFIGURED_SCOPES = ["trade", "account_manage", "application_read"];

/**
 * Why app registration is unavailable, stated once.
 *
 * `app_register` belongs to Deriv's legacy JSON-RPC stack and exists only on the
 * legacy WebSocket hosts. Those return Cloudflare 520 to server networks. The
 * new platform has no equivalent: its reachable socket serves market data and
 * trading but answers UnknownMethod for app_list/app_register/app_update/app_get,
 * and the REST API has no /applications route (404).
 *
 * Note this is not a missing token scope. The new OAuth 2.0 scope set --
 * trade, account_manage, application_read, payment -- has no admin scope at all;
 * admin belongs to the legacy app model.
 */
const APP_REGISTRATION_REMOVED =
  "Automatic Deriv app creation is unavailable: it requires app_register, which exists only on Deriv's legacy WebSocket API (returns Cloudflare 520 to server networks), and the new platform has no applications API. Register the app at developers.deriv.com, then add it under Admin -> Deriv Pool -> Add app.";

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

const encryptSecret = async (value: string): Promise<string> => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    ENCODER.encode(value),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
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

/** Deriv REST base. Reachable from this network; the legacy WS hosts are not. */
const DERIV_REST_BASE = "https://api.derivws.com";

/**
 * Deriv App IDs: current are alphanumeric OAuth 2.0 client IDs
 * (e.g. 33MsUFUfuukH8nJjySUAA); legacy ones are numeric.
 */
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

type RestProbe = {
  reachable: boolean;
  status: number | null;
  detail: string;
  accounts?: Array<{ accountId: string; accountType: string; currency: string }>;
};

/**
 * Verify a PAT against Deriv's REST API.
 *
 * This deliberately does not use the WebSocket API. `app_register`, `app_list`
 * and `authorize` only exist on the legacy JSON-RPC hosts (ws.derivws.com,
 * ws.binaryws.com and friends), and those are unreachable from Supabase's edge
 * network: the handshake is silently dropped by Deriv's account-level rule on
 * the shared Cloudflare IPs, while api.derivws.com answers normally on the same
 * IPs. REST is therefore the only usable control plane here.
 *
 * PAT requests require the `Deriv-App-ID` header; OAuth access tokens do not.
 */
const verifyPatOverRest = async (token: string, derivAppId: string): Promise<RestProbe> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": derivAppId,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");

    if (res.ok) {
      let accounts: RestProbe["accounts"] = [];
      try {
        const parsed = JSON.parse(text) as {
          data?: Array<{ account_id?: string; account_type?: string; currency?: string }>;
        };
        accounts = (parsed.data || []).map((row) => ({
          accountId: String(row.account_id || ""),
          accountType: String(row.account_type || ""),
          currency: String(row.currency || ""),
        }));
      } catch {
        // A 200 with an unexpected body still proves the token is accepted.
      }
      return { reachable: true, status: res.status, detail: "Token accepted by Deriv", accounts };
    }

    // 401/403 mean Deriv answered and rejected something: actionable.
    if (res.status === 401 || res.status === 403) {
      const detail = text.slice(0, 200).replace(/\s+/g, "");
      // "Invalid application" is about the App ID header, not the token. Say so,
      // otherwise the operator re-issues a perfectly good token chasing it.
      if (/invalid application/i.test(detail)) {
        return {
          reachable: true,
          status: res.status,
          detail:
            `Deriv does not recognise the App ID "${derivAppId}" (HTTP ${res.status}). ` +
            "The App ID must be the one that issued this token, from developers.deriv.com. " +
            "A PAT needs a PAT-type app; an OAuth 2.0 app ID will not authorise a personal access token.",
        };
      }
      return {
        reachable: true,
        status: res.status,
        detail: `Deriv rejected this token (HTTP ${res.status}): ${text.slice(0, 200).replace(/\s+/g, " ") || "no detail"}`,
      };
    }

    return {
      reachable: true,
      status: res.status,
      detail: `Deriv answered HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ") || "no detail"}`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return {
      reachable: false,
      status: null,
      detail:
        name === "AbortError"
          ? "api.derivws.com did not answer within 8s"
          : `${name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
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

  // Registering a Deriv app used to happen here, over the legacy WebSocket API.
  // That path has been removed: the legacy hosts (ws.derivws.com and friends)
  // answer Cloudflare 520 to server networks, and the new platform exposes no
  // applications API -- its reachable socket routes no app_* methods (they
  // answer UnknownMethod, exactly like a bogus method name) and every
  // /applications REST path is 404.
  //
  // Refuse explicitly with the reason and the manual route. Returning a network
  // error here is what previously sent the operator hunting for a bad token.
  return {
    status: 503,
    payload: {
      error: "deriv_app_registration_unavailable",
      message: APP_REGISTRATION_REMOVED,
      legacyRemoved: true,
      unavailable: ["app_register", "app_list", "app_update", "app_delete"],
      manualAlternative:
        "Create the app at developers.deriv.com with the callback URL for this tenant, then add it under Admin -> Deriv Pool -> Add app and assign it to the site.",
    },
  };
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

    // -----------------------------------------------------------------------
    // Action: save_superuser_token
    //
    // Stores the operator's Deriv credential. Verification goes over REST
    // (api.derivws.com), which is the new platform and is reachable; this
    // function makes no WebSocket call at all any more.
    // -----------------------------------------------------------------------
    if (action === "save_superuser_token") {
      const rawToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
      const clearToken = body.clearToken === true;
      const patch: Record<string, unknown> = {
        singleton_key: "primary",
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      };

      if (typeof body.defaultCallbackUri === "string" && body.defaultCallbackUri.trim()) {
        patch.default_callback_uri = body.defaultCallbackUri.trim();
      }
      const feeRate = Number(body.defaultPlatformFeeRate);
      if (Number.isFinite(feeRate)) {
        patch.default_platform_fee_rate = Math.round(Math.min(100, Math.max(0, feeRate)) * 100) / 100;
      }

      if (clearToken) {
        patch.api_token_encrypted = null;
        patch.api_token_scopes = [];
        patch.deriv_loginid = null;
        patch.deriv_email = null;
        patch.api_token_valid_until = null;
        patch.last_error = null;
      }

      let verification: RestProbe | null = null;
      let appReachability: { reachable: boolean; detail: string } | null = null;

      if (rawToken) {
        // PATs are rejected without Deriv-App-ID, and the header must carry the
        // App ID that *issued* the token. Deriv's current App IDs are
        // alphanumeric OAuth 2.0 client IDs (e.g. 33MsUFUfuukH8nJjySUAA), so an
        // old digits-only check here silently threw them away and fell back to
        // 1089 -- Deriv's shared public demo app, which answers 401
        // "Invalid application" for any personal access token.
        const { data: existing } = await admin
          .from("superuser_deriv_credentials")
          .select("ws_app_id")
          .eq("singleton_key", "primary")
          .maybeSingle();
        const candidateAppId = [
          typeof body.derivAppId === "string" ? body.derivAppId.trim() : "",
          typeof body.wsAppId === "string" ? body.wsAppId.trim() : "",
          String(existing?.ws_app_id || "").trim(),
        ].find((value) => APP_ID_PATTERN.test(value));

        if (!candidateAppId) {
          return json(
            {
              error:
                "A Deriv App ID is required to verify a personal access token. Copy it from developers.deriv.com and paste it into the App ID field.",
              needsAppId: true,
            },
            400,
          );
        }
        patch.ws_app_id = candidateAppId;

        verification = await verifyPatOverRest(rawToken, candidateAppId);
        // A token Deriv rejects is not worth storing; a token that could not be
        // checked because the network failed is stored so the operator is not
        // blocked from making progress.
        if (verification.reachable && verification.status !== 200) {
          return json(
            { error: verification.detail, status: verification.status, retryable: false },
            400,
          );
        }

        patch.api_token_encrypted = await encryptSecret(rawToken);
        patch.api_token_scopes = verification.status === 200 ? ["read", "trade", "account_manage"] : [];
        patch.deriv_loginid = verification.accounts?.[0]?.accountId || null;
        patch.deriv_email = null;
        patch.last_verified_at = verification.reachable ? new Date().toISOString() : null;
        patch.last_error = verification.reachable ? null : verification.detail;
        // App registration no longer depends on this network: the legacy path
        // it used has been removed, so there is nothing to probe.
        appReachability = { reachable: false, detail: "legacy app registration removed" };
      }

      const { error: upsertError } = await admin
        .from("superuser_deriv_credentials")
        .upsert(patch, { onConflict: "singleton_key" });
      if (upsertError) throw upsertError;

      await auditLog(admin, {
        userId: user.id,
        action: clearToken
          ? "superuser.deriv.disconnected"
          : rawToken
            ? "superuser.deriv.connected"
            : "superuser.deriv.settings_updated",
        metadata: {
          loginId: verification?.accounts?.[0]?.accountId,
          restVerified: verification?.status === 200,
          restReachable: verification?.reachable ?? null,
          appRegistrationAvailable: false,
        },
      });

      return json({
        ok: true,
        verifiedAccount: verification?.accounts?.length
          ? { loginid: verification.accounts[0].accountId, email: "", scopes: ["read", "trade", "account_manage"] }
          : null,
        verification,
        appRegistration: appReachability
          ? {
              available: false,
              legacyRemoved: true,
              detail: appReachability.detail,
              note: APP_REGISTRATION_REMOVED,
            }
          : null,
      });
    }

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

    // -----------------------------------------------------------------------
    // Action: add_app_for_site
    //
    // The operator creates the app in DevHub (unavoidable while the application
    // API host is blocked) and pastes the App ID here. This records it in the
    // pool and pins it to one site in a single step, with no WebSocket call: the
    // deployed manage-platform-deriv "add app" path would try to sync the app over
    // the blocked host and fail after the record was already written.
    // -----------------------------------------------------------------------
    if (action === "add_app_for_site") {
      const siteId = String(body.siteId || "").trim();
      const appId = String(body.derivAppId || body.appId || "").trim();
      if (!siteId || !appId) return json({ error: "siteId and derivAppId are required" }, 400);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(appId)) {
        return json({ error: "That does not look like a Deriv App ID" }, 400);
      }

      const { data: site } = await admin
        .from("sites")
        .select("id, name")
        .eq("id", siteId)
        .maybeSingle<{ id: string; name: string | null }>();
      if (!site) return json({ error: "Site not found" }, 404);

      const markupPercentage = clampMarkup(body.markupPercentage, 2.5);
      const rawName =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : `${site.name || "Site"} DSites`.replace(/deriv/gi, "DSites").slice(0, 48);

      const record: Record<string, unknown> = {
        name: rawName,
        app_id: appId,
        oauth_client_id: String(body.oauthClientId || "").trim() || appId,
        callback_uri:
          (typeof body.callbackUri === "string" && body.callbackUri.trim()) || DEFAULT_CALLBACK_URI,
        environment: "production",
        markup_percentage: markupPercentage,
        // Manual, not auto: the app was created in DevHub by the operator.
        registration_source: "manual",
        is_default: false,
        is_active: true,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      };
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      if (clientSecret) record.client_secret_encrypted = await encryptSecret(clientSecret);

      const { data: savedApp, error: saveError } = await admin
        .from("platform_deriv_apps")
        .upsert(record, { onConflict: "app_id,environment" })
        .select("id, name, app_id, callback_uri, markup_percentage")
        .single<{ id: string; name: string; app_id: string; callback_uri: string; markup_percentage: number }>();
      if (saveError) return json({ error: saveError.message }, 400);

      const { error: bindError } = await admin.rpc("bind_platform_deriv_app_to_site", {
        _site_id: siteId,
        _platform_deriv_app_id: savedApp.id,
        _markup_percentage: markupPercentage,
        _scopes: CONFIGURED_SCOPES,
      });
      if (bindError) return json({ error: bindError.message }, 400);

      await auditLog(admin, {
        userId: user.id,
        action: "superuser.deriv_pool.app_added_for_site",
        siteId,
        metadata: { appId, markupPercentage },
      });

      return json({
        status: "registered",
        app: {
          id: savedApp.id,
          name: savedApp.name,
          appId: savedApp.app_id,
          callbackUri: savedApp.callback_uri,
          markupPercentage: Number(savedApp.markup_percentage),
        },
        site: { id: site.id, name: site.name },
      });
    }

    // -----------------------------------------------------------------------
    // Action: assign_app_to_site
    //
    // Manual counterpart to automatic registration: pins an operator-supplied
    // App ID to a site. This is the documented path while Deriv's application API
    // host is blocked, and it is also how an imported app gets attached.
    // -----------------------------------------------------------------------
    if (action === "assign_app_to_site") {
      const siteId = String(body.siteId || "").trim();
      const platformDerivAppId = String(body.platformDerivAppId || "").trim();
      if (!siteId || !platformDerivAppId) {
        return json({ error: "siteId and platformDerivAppId are required" }, 400);
      }

      const { data, error } = await admin.rpc("bind_platform_deriv_app_to_site", {
        _site_id: siteId,
        _platform_deriv_app_id: platformDerivAppId,
        // Keep the site's own markup rather than letting a default silently
        // change what the tenant earns.
        _markup_percentage: clampMarkup(body.markupPercentage, 2.5),
        _scopes: CONFIGURED_SCOPES,
      });
      if (error) return json({ error: error.message }, 400);

      await auditLog(admin, {
        userId: user.id,
        action: "superuser.deriv_pool.app_assigned_manually",
        siteId,
        metadata: { platformDerivAppId },
      });

      const result = (data || {}) as Record<string, unknown>;
      return json({
        status: String(result.status || "bound"),
        appId: result.appId ? String(result.appId) : null,
        siteId,
      });
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
