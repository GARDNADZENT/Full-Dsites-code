import { createClient } from "npm:@supabase/supabase-js@2";

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

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const timingSafeEqual = (a: string, b: string) => {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
};

const hmacSha1Hex = async (secret: string, body: string) => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const verifyWebhookRequest = async (
  req: Request,
  rawBody: string,
  expectedSecret: string,
) => {
  if (!expectedSecret) return false;

  const vercelSig = req.headers.get("x-vercel-signature")?.trim().toLowerCase();
  if (vercelSig) {
    const computed = await hmacSha1Hex(expectedSecret, rawBody);
    return timingSafeEqual(vercelSig, computed);
  }

  const suppliedSecret =
    new URL(req.url).searchParams.get("secret") ||
    req.headers.get("x-reef-webhook-secret") ||
    "";
  return Boolean(suppliedSecret) && timingSafeEqual(suppliedSecret, expectedSecret);
};

const mapVercelStatus = (eventType: string, rawState: string) => {
  const normalizedEvent = eventType.toLowerCase();
  const normalizedState = rawState.toLowerCase();

  if (
    normalizedEvent === "deployment.succeeded" ||
    normalizedEvent === "deployment.ready" ||
    normalizedEvent === "deployment.promoted" ||
    normalizedState === "ready"
  ) {
    return "deployed";
  }
  if (
    normalizedEvent === "deployment.error" ||
    normalizedState === "error" ||
    normalizedState === "failed"
  ) {
    return "build_failed";
  }
  if (
    normalizedEvent === "deployment.canceled" ||
    normalizedState === "canceled" ||
    normalizedState === "cancelled"
  ) {
    return "cancelled";
  }
  return "building";
};

Deno.serve(async (req) => {
  const requestId = correlationId();
  if (req.method !== "POST")
    return respond({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("VERCEL_WEBHOOK_SECRET")?.trim() || "";
  const rawBody = await req.text();
  if (!(await verifyWebhookRequest(req, rawBody, expectedSecret))) {
    return respond({ error: "Invalid webhook signature or secret" }, 401);
  }

  try {
    const body = JSON.parse(rawBody);
    const data = body?.payload && typeof body.payload === "object"
      ? body.payload
      : body;
    const deploymentPayload =
      data?.deployment && typeof data.deployment === "object"
        ? data.deployment
        : data;

    const projectId = String(
      data?.project?.id ||
        data?.projectId ||
        deploymentPayload?.projectId ||
        "",
    ).trim();
    const commitSha = String(
      deploymentPayload?.meta?.githubCommitSha ||
        data?.meta?.githubCommitSha ||
        body?.commitSha ||
        "",
    ).trim();

    if (!projectId && !commitSha) {
      return respond({ error: "Vercel project ID or commit SHA is missing" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    let siteId: string | null = null;
    let siteProductionUrl: string | null = null;
    let deploymentId: string | null = null;

    if (projectId) {
      const { data: dedicatedIntegration } = await admin
        .from("site_integrations")
        .select("site_id, netlify_site_url")
        .eq("netlify_site_id", projectId)
        .maybeSingle();

      if (dedicatedIntegration) {
        siteId = dedicatedIntegration.site_id;
        siteProductionUrl = dedicatedIntegration.netlify_site_url;
      }
    }

    if (siteId) {
      let query = admin.from("site_deployments").select("id").eq("site_id", siteId);
      if (commitSha) query = query.eq("commit_sha", commitSha);
      else query = query.in("status", ["committed", "building"]);
      const { data: deployment } = await query
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      deploymentId = deployment?.id || null;
    } else if (commitSha) {
      // Shared multi-tenant Vercel project: match the deployment by its GitHub commit SHA.
      const { data: deployment } = await admin
        .from("site_deployments")
        .select("id, site_id")
        .eq("commit_sha", commitSha)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (deployment) {
        deploymentId = deployment.id;
        siteId = deployment.site_id;
        const { data: sharedIntegration } = await admin
          .from("site_integrations")
          .select("netlify_site_url")
          .eq("site_id", siteId)
          .maybeSingle();
        siteProductionUrl = sharedIntegration?.netlify_site_url || null;
      }
    }

    if (!siteId || !deploymentId) {
      return respond({ ignored: true, reason: "No matching site deployment" });
    }

    const eventType = String(body?.type || "");
    const rawState = String(
      deploymentPayload?.readyState || deploymentPayload?.state || data?.state || "",
    );
    const status = mapVercelStatus(eventType, rawState);

    const rawUrl = String(deploymentPayload?.url || data?.url || "").trim();
    const deployUrl = rawUrl
      ? rawUrl.startsWith("http")
        ? rawUrl
        : `https://${rawUrl}`
      : siteProductionUrl;
    const inspectorUrl = String(
      data?.links?.deployment ||
        deploymentPayload?.inspectorUrl ||
        data?.inspectorUrl ||
        "",
    ).trim() || null;
    const vercelDeployId = String(
      deploymentPayload?.id || data?.deploymentId || body?.id || "",
    ).trim() || null;
    const target = String(
      data?.target || deploymentPayload?.target || "production",
    );

    const { data: site } = await admin
      .from("sites")
      .select("organisation_id")
      .eq("id", siteId)
      .maybeSingle();

    await admin
      .from("site_deployments")
      .update({
        status,
        netlify_deploy_id: vercelDeployId,
        netlify_deploy_url: siteProductionUrl || deployUrl || null,
        netlify_log_url: inspectorUrl,
        deploy_context: target,
        error_message:
          status === "build_failed"
            ? String(
                deploymentPayload?.errorMessage ||
                  data?.errorMessage ||
                  "Vercel build failed",
              )
            : null,
        completed_at:
          status === "deployed" ||
          status === "build_failed" ||
          status === "cancelled"
            ? new Date().toISOString()
            : null,
      })
      .eq("id", deploymentId);

    if (site) {
      await admin.from("deployment_logs").insert({
        organisation_id: site.organisation_id,
        site_id: siteId,
        deployment_id: deploymentId,
        level: status === "build_failed" ? "error" : "info",
        stage: "provider_webhook",
        message: `Vercel deployment is ${status}`,
        provider: "vercel",
        metadata: {
          vercelDeployId,
          vercelProjectId: projectId || null,
          commitSha: commitSha || null,
          eventType: eventType || null,
        },
      });
    }

    if (status === "deployed" && target === "production") {
      await Promise.all([
        admin
          .from("site_domains")
          .update({
            status: "active",
            ssl_status: "provisioned",
          })
          .eq("site_id", siteId)
          .eq("is_primary", true)
          .eq("is_verified", true),
        admin.from("sites").update({ status: "active" }).eq("id", siteId),
      ]);

      const healthUrl = siteProductionUrl || deployUrl;
      if (site && healthUrl) {
        const started = Date.now();
        try {
          const check = await fetch(healthUrl, {
            method: "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(10_000),
          });
          await admin.from("site_health_checks").insert({
            organisation_id: site.organisation_id,
            site_id: siteId,
            deployment_id: deploymentId,
            url: healthUrl,
            status: check.ok ? "healthy" : "degraded",
            http_status: check.status,
            latency_ms: Date.now() - started,
          });
        } catch {
          await admin.from("site_health_checks").insert({
            organisation_id: site.organisation_id,
            site_id: siteId,
            deployment_id: deploymentId,
            url: healthUrl,
            status: "unhealthy",
            latency_ms: Date.now() - started,
            error_code: "health_request_failed",
          });
        }
      }
    }

    if (site) {
      await audit({
        organisationId: site.organisation_id,
        siteId,
        actorType: "provider",
        action: `deployment.${status}`,
        provider: "vercel",
        correlationId: requestId,
        metadata: {
          deploymentId,
          vercelDeployId,
          commitSha: commitSha || null,
        },
      });
    }

    return respond({ ok: true, deploymentId, status });
  } catch (error) {
    console.error("vercel-deploy-webhook", error);
    return respond(
      { error: error instanceof Error ? error.message : "Webhook failed" },
      500,
    );
  }
});
