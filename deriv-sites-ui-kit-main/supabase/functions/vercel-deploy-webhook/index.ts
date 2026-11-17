import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { audit, correlationId } from "../_shared/http.ts";

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

serve(async (req) => {
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
            is_verified: true,
            ssl_status: "provisioned",
          })
          .eq("site_id", siteId)
          .eq("is_primary", true),
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
