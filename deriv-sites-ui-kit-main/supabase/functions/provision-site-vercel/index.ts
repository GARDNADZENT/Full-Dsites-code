import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { audit, correlationId } from "../_shared/http.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const env = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Server configuration is missing ${name}`);
  return value;
};

const withTeam = (path: string, teamId?: string) => {
  if (!teamId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}teamId=${encodeURIComponent(teamId)}`;
};

const vercelRequest = async (
  path: string,
  init: RequestInit = {},
  teamId?: string,
) => {
  const response = await fetch(
    `https://api.vercel.com${withTeam(path, teamId)}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env("VERCEL_ACCESS_TOKEN")}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      body?.error?.message || body?.message || body?.error || "Unknown error";
    const err = new Error(`Vercel API failed (${response.status}): ${detail}`);
    Object.assign(err, {
      status: response.status,
      vercelCode: body?.error?.code,
    });
    throw err;
  }
  return body;
};

const attachDomain = async (
  projectId: string,
  hostname: string,
  teamId?: string,
) => {
  try {
    return await vercelRequest(
      `/v10/projects/${encodeURIComponent(projectId)}/domains`,
      {
        method: "POST",
        body: JSON.stringify({ name: hostname }),
      },
      teamId,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) {
      // If the domain is already attached to this project, read its current status idempotently.
      return await vercelRequest(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
        { method: "GET" },
        teamId,
      );
    }
    throw error;
  }
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45);

serve(async (req) => {
  const requestId = correlationId();
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST")
    return respond({ error: "Method not allowed" }, 405);

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization)
      return respond({ error: "Authentication required" }, 401);

    const supabaseUrl = env("SUPABASE_URL");
    const admin = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
    const { data: auth, error: authError } = await admin.auth.getUser(
      authorization.replace(/^Bearer\s+/i, ""),
    );
    if (authError || !auth.user)
      return respond({ error: "Invalid session" }, 401);

    const { siteId } = await req.json();
    if (typeof siteId !== "string" || !siteId.trim())
      return respond({ error: "siteId is required" }, 400);

    const [{ data: site }, { data: domain }, { data: existing }] =
      await Promise.all([
        admin.from("sites").select("*").eq("id", siteId).maybeSingle(),
        admin
          .from("site_domains")
          .select("hostname")
          .eq("site_id", siteId)
          .order("is_primary", { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from("site_integrations")
          .select("*")
          .eq("site_id", siteId)
          .maybeSingle(),
      ]);

    if (!site) return respond({ error: "Site not found" }, 404);

    const [{ data: canEditOrganisation }, { data: canOperateSites }] =
      await Promise.all([
        admin.rpc("has_organisation_role", {
          _organisation_id: site.organisation_id,
          _user_id: auth.user.id,
          _roles: ["tenant_owner", "tenant_developer"],
        }),
        admin.rpc("has_platform_permission", {
          _user_id: auth.user.id,
          _permission: "deployments.write",
        }),
      ]);

    if (
      site.user_id !== auth.user.id &&
      !canEditOrganisation &&
      !canOperateSites
    ) {
      return respond(
        { error: "You do not have permission to provision this site" },
        403,
      );
    }

    if (existing?.netlify_site_id && existing.status === "connected") {
      return respond({ integration: existing });
    }

    const owner = env("GITHUB_REPO_OWNER");
    const repository = env("GITHUB_REPO_NAME");
    const branch = Deno.env.get("GITHUB_REPO_BRANCH")?.trim() || "main";
    const githubInstallationId = Number(
      Deno.env.get("GITHUB_APP_INSTALLATION_ID")?.trim() || "0",
    ) || null;
    const teamId = Deno.env.get("VERCEL_TEAM_ID")?.trim() || undefined;
    const teamSlug = Deno.env.get("VERCEL_TEAM_SLUG")?.trim() || "";
    const sharedProjectId =
      Deno.env.get("VERCEL_SHARED_PROJECT_ID")?.trim() || "";
    const backendApiUrl =
      Deno.env.get("TENANT_BACKEND_API_URL")?.trim() || "";
    const hostname = domain?.hostname?.trim().toLowerCase() || "";

    await admin.from("site_integrations").upsert(
      {
        site_id: siteId,
        github_installation_id: githubInstallationId,
        github_repository_owner: owner,
        github_repository_name: repository,
        github_default_branch: branch,
        status: "provisioning",
        last_error: null,
      },
      { onConflict: "site_id" },
    );

    const actorType = canOperateSites ? "platform_admin" : "platform_owner";

    try {
      if (sharedProjectId) {
        // Mode A: Attach the tenant's domain to the single shared Vercel tenant project.
        const project = await vercelRequest(
          `/v9/projects/${encodeURIComponent(sharedProjectId)}`,
          { method: "GET" },
          teamId,
        );

        let domainResult: Record<string, unknown> | null = null;
        if (hostname) {
          domainResult = await attachDomain(project.id, hostname, teamId);
          await admin
            .from("site_domains")
            .update({
              is_verified: true,
              status: domainResult?.verified === false ? "verified" : "active",
              ssl_status:
                domainResult?.verified === false ? "pending" : "provisioned",
            })
            .eq("site_id", siteId)
            .eq("hostname", hostname);
        }

        const adminUrl = teamSlug
          ? `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(project.name)}/settings/domains`
          : `https://vercel.com/dashboard`;
        const productionUrl = hostname
          ? `https://${hostname}`
          : `https://${project.name}.vercel.app`;

        // Suffix siteId so each tenant keeps a unique provider reference on the shared project.
        const { data: integration, error: integrationError } = await admin
          .from("site_integrations")
          .upsert(
            {
              site_id: siteId,
              github_installation_id: githubInstallationId,
              github_repository_owner: owner,
              github_repository_name: repository,
              github_default_branch: branch,
              netlify_site_id: `${project.id}:${siteId}`,
              netlify_site_name: hostname
                ? `${project.name} (${hostname})`
                : project.name,
              netlify_site_url: productionUrl,
              netlify_admin_url: adminUrl,
              netlify_account_id: teamId || project.accountId || null,
              status: "connected",
              last_error: null,
            },
            { onConflict: "site_id" },
          )
          .select()
          .single();

        if (integrationError) throw new Error(integrationError.message);

        await audit({
          organisationId: site.organisation_id,
          siteId,
          actorUserId: auth.user.id,
          actorType,
          action: "deployment.site_provisioned",
          provider: "vercel",
          correlationId: requestId,
          metadata: {
            mode: "shared",
            vercelProjectId: project.id,
            hostname: hostname || null,
            domainVerified: domainResult?.verified ?? null,
          },
        });

        return respond({
          integration,
          mode: "shared",
          domainVerification: Array.isArray(domainResult?.verification)
            ? domainResult.verification
            : [],
        });
      }

      // Mode B: Create an isolated Vercel project per tenant site.
      const projectName = `${slugify(hostname || site.name || "reef-site")}-${siteId.slice(0, 8)}`;
      const project = await vercelRequest(
        "/v10/projects",
        {
          method: "POST",
          body: JSON.stringify({
            name: projectName,
            framework: null,
            gitRepository: {
              type: "github",
              repo: `${owner}/${repository}`,
            },
            rootDirectory: "new-user-interface-main",
            installCommand: "cd .. && npm install --include=optional",
            buildCommand: "npm run build",
            outputDirectory: "dist",
            commandForIgnoringBuildStep: "node scripts/vercel-ignore-site.js",
          }),
        },
        teamId,
      );

      const envVars = [
        {
          key: "REEF_SITE_ID",
          value: siteId,
          type: "plain",
          target: ["production", "preview"],
        },
        {
          key: "APP_ENV",
          value: "production",
          type: "plain",
          target: ["production", "preview"],
        },
        {
          key: "SITE_CONFIG_API_BASE_URL",
          value: `${supabaseUrl.replace(/\/$/, "")}/functions/v1`,
          type: "plain",
          target: ["production", "preview"],
        },
        ...(backendApiUrl
          ? [
              {
                key: "BACKEND_API_URL",
                value: backendApiUrl,
                type: "plain",
                target: ["production", "preview"],
              },
            ]
          : []),
      ];

      await vercelRequest(
        `/v10/projects/${encodeURIComponent(project.id)}/env?upsert=true`,
        {
          method: "POST",
          body: JSON.stringify(envVars),
        },
        teamId,
      );

      let domainResult: Record<string, unknown> | null = null;
      if (hostname) {
        domainResult = await attachDomain(project.id, hostname, teamId);
      }

      const adminUrl = teamSlug
        ? `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(project.name)}`
        : `https://vercel.com/dashboard`;
      const productionUrl = hostname
        ? `https://${hostname}`
        : `https://${project.name}.vercel.app`;

      const { data: integration, error: integrationError } = await admin
        .from("site_integrations")
        .upsert(
          {
            site_id: siteId,
            github_installation_id: githubInstallationId,
            github_repository_owner: owner,
            github_repository_name: repository,
            github_default_branch: branch,
            netlify_site_id: project.id,
            netlify_site_name: project.name,
            netlify_site_url: productionUrl,
            netlify_admin_url: adminUrl,
            netlify_account_id: teamId || project.accountId || null,
            status: "connected",
            last_error: null,
          },
          { onConflict: "site_id" },
        )
        .select()
        .single();

      if (integrationError) throw new Error(integrationError.message);

      await audit({
        organisationId: site.organisation_id,
        siteId,
        actorUserId: auth.user.id,
        actorType,
        action: "deployment.site_provisioned",
        provider: "vercel",
        correlationId: requestId,
        metadata: {
          mode: "dedicated",
          vercelProjectId: project.id,
          hostname: hostname || null,
          repository: `${owner}/${repository}`,
        },
      });

      return respond({
        integration,
        mode: "dedicated",
        domainVerification: Array.isArray(domainResult?.verification)
          ? domainResult.verification
          : [],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provisioning failed";
      await admin
        .from("site_integrations")
        .update({ status: "failed", last_error: message })
        .eq("site_id", siteId);
      await audit({
        organisationId: site.organisation_id,
        siteId,
        actorUserId: auth.user.id,
        actorType,
        action: "deployment.site_provision_failed",
        provider: "vercel",
        correlationId: requestId,
        metadata: { errorCode: "vercel_provision_failed" },
      });
      throw error;
    }
  } catch (error) {
    console.error("provision-site-vercel", error);
    return respond(
      {
        error: "Provisioning failed. Contact support with the correlation ID.",
        code: "vercel_provision_failed",
        correlationId: requestId,
      },
      500,
    );
  }
});
