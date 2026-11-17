import { createClient } from "npm:@supabase/supabase-js@2";

const correlationId = () => crypto.randomUUID();

const writeAudit = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  input: {
    organisationId?: string | null;
    siteId?: string | null;
    actorUserId?: string | null;
    actorType: "platform_owner" | "platform_admin" | "trader" | "system" | "provider";
    action: string;
    provider?: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  },
) => {
  try {
    await admin.from("audit_logs").insert({
      organisation_id: input.organisationId || null,
      site_id: input.siteId || null,
      actor_user_id: input.actorUserId || null,
      actor_type: input.actorType,
      action: input.action,
      provider: input.provider || null,
      correlation_id: input.correlationId,
      metadata: input.metadata || {},
    });
  } catch (err) {
    console.error("audit write failed", { correlationId: input.correlationId, err });
  }
};

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

const VERCEL_SUFFIX = ".vercel.app";

const STATIC_RESERVED_HOSTNAMES = new Set([
  "dsites-admin.vercel.app",
  "dsites-trading.vercel.app",
  "dsites-backend.vercel.app",
  "vercel.app",
  "www.vercel.app",
  "localhost",
]);

const RESERVED_VERCEL_SLUGS = new Set([
  "dsites-admin",
  "dsites-trading",
  "dsites-backend",
  "www",
  "api",
  "admin",
  "vercel",
]);

const MULTI_PART_TLDS = new Set([
  "co.ke",
  "or.ke",
  "ac.ke",
  "go.ke",
  "me.ke",
  "sc.ke",
  "ne.ke",
  "co.tz",
  "or.tz",
  "co.ug",
  "co.rw",
  "co.za",
  "org.za",
  "com.ng",
  "org.ng",
  "com.gh",
  "co.uk",
  "org.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.in",
  "com.br",
  "com.sg",
  "com.my",
]);

const HOSTNAME_REGEX =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VERCEL_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

class DomainActionError extends Error {
  status: number;
  code: string;
  suggestions?: string[];

  constructor(
    message: string,
    status: number,
    code: string,
    suggestions?: string[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.suggestions = suggestions;
  }
}

const normalizeHostname = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .split(":")[0]
    .replace(/\.+$/, "")
    .trim();
};

const extractEnvHost = (value?: string): string | null => {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return normalizeHostname(value) || null;
  }
};

const getReservedHostnames = (extra: Array<string | null | undefined> = []) => {
  const reserved = new Set(STATIC_RESERVED_HOSTNAMES);
  for (const candidate of [
    extractEnvHost(Deno.env.get("PLATFORM_BASE_URL")),
    extractEnvHost(Deno.env.get("TENANT_BACKEND_API_URL")),
    ...extra.map((v) => (v ? normalizeHostname(v) : null)),
  ]) {
    if (candidate) reserved.add(candidate);
  }
  return reserved;
};

const suggestVercelSlugs = (slug: string): string[] => {
  const base = slug
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "my-trading";
  return [`${base}-fx`, `${base}-trade`, `${base}-hub`].filter(
    (item) => !RESERVED_VERCEL_SLUGS.has(item),
  );
};

const validateHostname = (
  hostname: string,
  reserved: Set<string>,
): { isVercelSubdomain: boolean; slug: string } => {
  if (reserved.has(hostname)) {
    throw new DomainActionError(
      `"${hostname}" is reserved by the platform. Choose a different domain.`,
      400,
      "domain_reserved",
    );
  }

  if (hostname.endsWith(VERCEL_SUFFIX)) {
    const slug = hostname.slice(0, -VERCEL_SUFFIX.length);
    if (slug.includes(".")) {
      throw new DomainActionError(
        "Vercel only supports single-level subdomains like my-brand.vercel.app (nested sub.project.vercel.app is not supported).",
        400,
        "vercel_nested_subdomain_unsupported",
      );
    }
    if (
      slug.length < 3 ||
      slug.length > 63 ||
      !VERCEL_SLUG_REGEX.test(slug) ||
      slug.includes("--") ||
      slug.includes("-git-")
    ) {
      throw new DomainActionError(
        "Invalid Vercel subdomain. Use 3-63 lowercase letters, numbers, and single hyphens (without '--' or '-git-').",
        400,
        "vercel_subdomain_invalid",
      );
    }
    if (RESERVED_VERCEL_SLUGS.has(slug)) {
      throw new DomainActionError(
        `"${hostname}" is reserved by the platform. Choose a different subdomain.`,
        400,
        "domain_reserved",
        suggestVercelSlugs(`${slug}-app`),
      );
    }
    return { isVercelSubdomain: true, slug };
  }

  if (!HOSTNAME_REGEX.test(hostname)) {
    throw new DomainActionError(
      "Enter a valid domain name (for example: mybrand.com or trade.mybrand.com).",
      400,
      "domain_invalid",
    );
  }

  return { isVercelSubdomain: false, slug: "" };
};

const buildDnsRecords = (
  hostname: string,
  isVercelSubdomain: boolean,
  verification: Array<{ type?: string; domain?: string; value?: string }> = [],
) => {
  if (!hostname || isVercelSubdomain) return [];

  const records: Array<{
    type: string;
    name: string;
    value: string;
    purpose: string;
    required: boolean;
  }> = [];

  for (const item of verification) {
    if (item?.domain && item?.value) {
      records.push({
        type: (item.type || "TXT").toUpperCase(),
        name: item.domain,
        value: item.value,
        purpose: "Confirms domain ownership with Vercel before activation",
        required: true,
      });
    }
  }

  const labels = hostname.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const rootLabelCount = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
  const isApex = labels.length <= rootLabelCount;

  if (isApex) {
    records.push({
      type: "A",
      name: "@",
      value: "76.76.21.21",
      purpose: "Points your root domain to Vercel (SSL provisioned automatically)",
      required: true,
    });
    records.push({
      type: "CNAME",
      name: "www",
      value: "cname.vercel-dns.com",
      purpose: "Optional: points www to Vercel",
      required: false,
    });
  } else {
    records.push({
      type: "CNAME",
      name: labels.slice(0, labels.length - rootLabelCount).join("."),
      value: "cname.vercel-dns.com",
      purpose: "Points your subdomain to Vercel (SSL provisioned automatically)",
      required: true,
    });
  }

  return records;
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
      detail,
    });
    throw err;
  }
  return body;
};

const attachDomain = async (
  projectId: string,
  hostname: string,
  isVercelSubdomain: boolean,
  slug: string,
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
    const detail = (error as { detail?: string }).detail || "";

    if (status === 409) {
      // Check whether this project already owns the domain (idempotent retry)
      // vs. another Vercel account/project holding it.
      try {
        return await vercelRequest(
          `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
          { method: "GET" },
          teamId,
        );
      } catch {
        if (isVercelSubdomain) {
          throw new DomainActionError(
            `"${hostname}" is already taken on Vercel. Pick a different free subdomain name.`,
            409,
            "domain_taken",
            suggestVercelSlugs(slug),
          );
        }
        throw new DomainActionError(
          `"${hostname}" is already linked to another Vercel project or account. Remove it from that Vercel project first, then retry.`,
          409,
          "domain_taken",
        );
      }
    }

    if (status === 400 || status === 403) {
      if (/limit|maximum|quota/i.test(detail)) {
        throw new DomainActionError(
          "This Vercel project has reached its domain limit. Upgrade the Vercel plan or remove unused domains.",
          409,
          "vercel_domain_limit",
        );
      }
      if (isVercelSubdomain) {
        throw new DomainActionError(
          `"${hostname}" cannot be claimed on Vercel (${detail || "unavailable"}). Try a different subdomain.`,
          409,
          "domain_taken",
          suggestVercelSlugs(slug),
        );
      }
      throw new DomainActionError(
        `Vercel rejected "${hostname}": ${detail || "check the domain format and try again"}.`,
        400,
        "vercel_domain_rejected",
      );
    }

    throw error;
  }
};

const verifyAndInspectDomain = async (
  projectId: string,
  hostname: string,
  isVercelSubdomain: boolean,
  initialResult: Record<string, unknown>,
  triggerVerify: boolean,
  teamId?: string,
) => {
  let domainResult = initialResult;

  if (triggerVerify) {
    try {
      domainResult = await vercelRequest(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}/verify`,
        { method: "POST" },
        teamId,
      );
    } catch {
      // If verification is still pending, fetch current domain metadata for TXT records.
      try {
        domainResult = await vercelRequest(
          `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
          { method: "GET" },
          teamId,
        );
      } catch {
        // Keep initial result.
      }
    }
  }

  const verification = Array.isArray(domainResult?.verification)
    ? (domainResult.verification as Array<{
        type?: string;
        domain?: string;
        value?: string;
        reason?: string;
      }>)
    : [];

  if (isVercelSubdomain) {
    const isVerified = domainResult?.verified !== false;
    return {
      isVerified,
      status: isVerified ? ("active" as const) : ("pending" as const),
      sslStatus: isVerified ? "provisioned" : "pending",
      misconfigured: false,
      verification,
      dnsRecords: [],
    };
  }

  let misconfigured: boolean | null = null;
  try {
    const config = await vercelRequest(
      `/v6/domains/${encodeURIComponent(hostname)}/config`,
      { method: "GET" },
      teamId,
    );
    if (typeof config?.misconfigured === "boolean") {
      misconfigured = config.misconfigured;
    }
  } catch {
    misconfigured = null;
  }

  // Security: never mark an external custom domain verified unless Vercel confirms
  // project ownership (domainResult.verified === true) AND DNS is checked.
  const ownershipVerified = domainResult?.verified === true;
  const dnsPointed = ownershipVerified && misconfigured === false;

  const isVerified = dnsPointed;
  const status: "pending" | "verified" | "active" = dnsPointed
    ? "active"
    : "pending";
  const sslStatus = dnsPointed
    ? "provisioned"
    : ownershipVerified
      ? "awaiting_dns"
      : "awaiting_verification";

  return {
    isVerified,
    status,
    sslStatus,
    misconfigured: misconfigured ?? true,
    ownershipVerified,
    verification,
    dnsRecords: buildDnsRecords(hostname, false, verification),
  };
};

const detachReplacedVercelAliases = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  projectId: string,
  siteId: string,
  activeHostname: string,
  reserved: Set<string>,
  teamId?: string,
) => {
  const { data: oldRows } = await admin
    .from("site_domains")
    .select("id, hostname")
    .eq("site_id", siteId)
    .neq("hostname", activeHostname);

  if (!Array.isArray(oldRows) || oldRows.length === 0) return;

  for (const row of oldRows) {
    const candidate = String(row.hostname || "").toLowerCase();
    if (!candidate.endsWith(VERCEL_SUFFIX) || reserved.has(candidate)) continue;
    try {
      await vercelRequest(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(candidate)}`,
        { method: "DELETE" },
        teamId,
      );
    } catch {
      // Ignore if already detached.
    }
    await admin.from("site_domains").delete().eq("id", row.id);
  }
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45);

Deno.serve(async (req) => {
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

    const body = await req.json().catch(() => ({}));
    const siteId = typeof body?.siteId === "string" ? body.siteId.trim() : "";
    const action: "provision" | "attach" | "verify" =
      body?.action === "verify"
        ? "verify"
        : body?.action === "attach"
          ? "attach"
          : "provision";
    const requestedHostname =
      typeof body?.hostname === "string"
        ? normalizeHostname(body.hostname)
        : "";

    if (!siteId) return respond({ error: "siteId is required" }, 400);

    const [{ data: site }, { data: domain }, { data: existing }] =
      await Promise.all([
        admin.from("sites").select("*").eq("id", siteId).maybeSingle(),
        admin
          .from("site_domains")
          .select("id, hostname, status, is_verified, ssl_status")
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

    const hostname =
      requestedHostname || normalizeHostname(domain?.hostname || "");
    const expectedUrl = hostname ? `https://${hostname}` : "";

    // Fast path only when plain provisioning is requested, the integration is already
    // connected to the exact current hostname, and the domain is already active.
    if (
      action === "provision" &&
      existing?.netlify_site_id &&
      existing.status === "connected" &&
      (!hostname ||
        (existing.netlify_site_url === expectedUrl &&
          domain?.hostname === hostname &&
          domain?.is_verified === true &&
          domain?.status === "active"))
    ) {
      const isVercelSubdomain = hostname.endsWith(VERCEL_SUFFIX);
      return respond({
        integration: existing,
        domain: hostname
          ? {
              hostname,
              isVercelSubdomain,
              isVerified: Boolean(domain?.is_verified),
              status: domain?.status || "active",
              sslStatus: domain?.ssl_status || "provisioned",
              misconfigured: false,
            }
          : null,
        dnsRecords: buildDnsRecords(hostname, isVercelSubdomain),
        domainVerification: [],
      });
    }

    if ((action === "attach" || action === "verify") && !hostname) {
      return respond(
        {
          error:
            "Enter a free .vercel.app subdomain or your custom domain first.",
          code: "hostname_missing",
        },
        400,
      );
    }

    const owner =
      Deno.env.get("GITHUB_REPO_OWNER")?.trim() ||
      existing?.github_repository_owner ||
      "GARDNADZENT";
    const repository =
      Deno.env.get("GITHUB_REPO_NAME")?.trim() ||
      existing?.github_repository_name ||
      "Full-Dsites-code";
    const branch = Deno.env.get("GITHUB_REPO_BRANCH")?.trim() || "main";
    const githubInstallationId =
      Number(Deno.env.get("GITHUB_APP_INSTALLATION_ID")?.trim() || "0") || null;
    const teamId = Deno.env.get("VERCEL_TEAM_ID")?.trim() || undefined;
    const teamSlug = Deno.env.get("VERCEL_TEAM_SLUG")?.trim() || "";
    const sharedProjectId =
      Deno.env.get("VERCEL_SHARED_PROJECT_ID")?.trim() || "";
    const backendApiUrl =
      Deno.env.get("TENANT_BACKEND_API_URL")?.trim() || "";

    let hostnameMeta = { isVercelSubdomain: false, slug: "" };
    const baseReserved = getReservedHostnames();
    if (hostname) {
      hostnameMeta = validateHostname(hostname, baseReserved);

      // Ensure no other tenant site already claims this hostname.
      const { data: conflicting } = await admin
        .from("site_domains")
        .select("site_id")
        .eq("hostname", hostname)
        .maybeSingle();

      if (conflicting && conflicting.site_id !== siteId) {
        return respond(
          {
            error: `"${hostname}" is already connected to another site.`,
            code: "domain_claimed",
            ...(hostnameMeta.isVercelSubdomain
              ? { suggestions: suggestVercelSlugs(hostnameMeta.slug) }
              : {}),
          },
          409,
        );
      }
    }

    if (!existing || existing.status !== "connected") {
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
    }

    const actorType = canOperateSites ? "platform_admin" : "platform_owner";

    try {
      if (sharedProjectId) {
        // Mode A: Attach the tenant's custom domain OR free <slug>.vercel.app
        // subdomain to the single shared Vercel tenant project.
        const project = await vercelRequest(
          `/v9/projects/${encodeURIComponent(sharedProjectId)}`,
          { method: "GET" },
          teamId,
        );

        const reserved = getReservedHostnames([`${project.name}.vercel.app`]);
        if (hostname) {
          hostnameMeta = validateHostname(hostname, reserved);
        }

        let inspected: Awaited<ReturnType<typeof verifyAndInspectDomain>> | null =
          null;

        if (hostname) {
          const attached = await attachDomain(
            project.id,
            hostname,
            hostnameMeta.isVercelSubdomain,
            hostnameMeta.slug,
            teamId,
          );

          inspected = await verifyAndInspectDomain(
            project.id,
            hostname,
            hostnameMeta.isVercelSubdomain,
            attached,
            action === "verify" || !hostnameMeta.isVercelSubdomain,
            teamId,
          );

          await admin.from("site_domains").upsert(
            {
              site_id: siteId,
              hostname,
              is_primary: true,
              is_verified: inspected.isVerified,
              status: inspected.status,
              ssl_status: inspected.sslStatus,
            },
            { onConflict: "hostname" },
          );

          await admin
            .from("site_domains")
            .update({ is_primary: false })
            .eq("site_id", siteId)
            .neq("hostname", hostname);

          await detachReplacedVercelAliases(
            admin,
            project.id,
            siteId,
            hostname,
            reserved,
            teamId,
          );
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

        await writeAudit(admin, {
          organisationId: site.organisation_id,
          siteId,
          actorUserId: auth.user.id,
          actorType,
          action:
            action === "verify"
              ? "deployment.domain_verified"
              : "deployment.site_provisioned",
          provider: "vercel",
          correlationId: requestId,
          metadata: {
            mode: "shared",
            action,
            vercelProjectId: project.id,
            hostname: hostname || null,
            isVercelSubdomain: hostnameMeta.isVercelSubdomain,
            domainVerified: inspected?.isVerified ?? null,
            domainStatus: inspected?.status ?? null,
          },
        });

        return respond({
          integration,
          mode: "shared",
          domain: hostname
            ? {
                hostname,
                isVercelSubdomain: hostnameMeta.isVercelSubdomain,
                isVerified: inspected?.isVerified ?? false,
                status: inspected?.status ?? "pending",
                sslStatus: inspected?.sslStatus ?? "pending",
                misconfigured: inspected?.misconfigured ?? false,
              }
            : null,
          dnsRecords: inspected?.dnsRecords ?? [],
          domainVerification: inspected?.verification ?? [],
        });
      }

      // Mode B: Isolated Vercel project per tenant site (reuses existing project on re-attach/verify).
      const existingDedicatedProjectId =
        existing?.netlify_site_id && !existing.netlify_site_id.includes(":")
          ? existing.netlify_site_id
          : null;

      const project = existingDedicatedProjectId
        ? await vercelRequest(
            `/v9/projects/${encodeURIComponent(existingDedicatedProjectId)}`,
            { method: "GET" },
            teamId,
          )
        : await (async () => {
            const projectName = `${slugify(hostnameMeta.slug || hostname || site.name || "reef-site")}-${siteId.slice(0, 8)}`;
            const created = await vercelRequest(
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
                  commandForIgnoringBuildStep:
                    "node scripts/vercel-ignore-site.js",
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
              `/v10/projects/${encodeURIComponent(created.id)}/env?upsert=true`,
              {
                method: "POST",
                body: JSON.stringify(envVars),
              },
              teamId,
            );

            return created;
          })();

      const finalHostname = hostname || `${project.name}.vercel.app`;
      const finalIsVercel = finalHostname.endsWith(VERCEL_SUFFIX);
      const finalSlug = finalIsVercel
        ? finalHostname.slice(0, -VERCEL_SUFFIX.length)
        : "";

      let inspected: Awaited<ReturnType<typeof verifyAndInspectDomain>> | null =
        null;

      if (finalHostname === `${project.name}.vercel.app`) {
        inspected = {
          isVerified: true,
          status: "active",
          sslStatus: "provisioned",
          misconfigured: false,
          verification: [],
          dnsRecords: [],
        };
      } else {
        const attached = await attachDomain(
          project.id,
          finalHostname,
          finalIsVercel,
          finalSlug,
          teamId,
        );
        inspected = await verifyAndInspectDomain(
          project.id,
          finalHostname,
          finalIsVercel,
          attached,
          action === "verify" || !finalIsVercel,
          teamId,
        );
      }

      await admin.from("site_domains").upsert(
        {
          site_id: siteId,
          hostname: finalHostname,
          is_primary: true,
          is_verified: inspected.isVerified,
          status: inspected.status,
          ssl_status: inspected.sslStatus,
        },
        { onConflict: "hostname" },
      );

      await admin
        .from("site_domains")
        .update({ is_primary: false })
        .eq("site_id", siteId)
        .neq("hostname", finalHostname);

      const adminUrl = teamSlug
        ? `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(project.name)}`
        : `https://vercel.com/dashboard`;
      const productionUrl = `https://${finalHostname}`;

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

      await writeAudit(admin, {
        organisationId: site.organisation_id,
        siteId,
        actorUserId: auth.user.id,
        actorType,
        action:
          action === "verify"
            ? "deployment.domain_verified"
            : "deployment.site_provisioned",
        provider: "vercel",
        correlationId: requestId,
        metadata: {
          mode: "dedicated",
          action,
          vercelProjectId: project.id,
          hostname: finalHostname,
          isVercelSubdomain: finalIsVercel,
          domainVerified: inspected.isVerified,
          repository: `${owner}/${repository}`,
        },
      });

      return respond({
        integration,
        mode: "dedicated",
        domain: {
          hostname: finalHostname,
          isVercelSubdomain: finalIsVercel,
          isVerified: inspected.isVerified,
          status: inspected.status,
          sslStatus: inspected.sslStatus,
          misconfigured: inspected.misconfigured,
        },
        dnsRecords: inspected.dnsRecords,
        domainVerification: inspected.verification,
      });
    } catch (error) {
      if (error instanceof DomainActionError) {
        return respond(
          {
            error: error.message,
            code: error.code,
            ...(error.suggestions?.length
              ? { suggestions: error.suggestions }
              : {}),
            correlationId: requestId,
          },
          error.status,
        );
      }

      const message =
        error instanceof Error ? error.message : "Provisioning failed";
      if (!existing || existing.status !== "connected") {
        await admin
          .from("site_integrations")
          .update({ status: "failed", last_error: message })
          .eq("site_id", siteId);
      }
      await writeAudit(admin, {
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
    if (error instanceof DomainActionError) {
      return respond(
        {
          error: error.message,
          code: error.code,
          ...(error.suggestions?.length
            ? { suggestions: error.suggestions }
            : {}),
          correlationId: requestId,
        },
        error.status,
      );
    }

    console.error("provision-site-vercel", error);
    const missingEnv =
      error instanceof Error &&
      error.message.startsWith("Server configuration is missing ")
        ? error.message
        : null;
    return respond(
      {
        error:
          missingEnv ||
          "Provisioning failed. Verify VERCEL_ACCESS_TOKEN is configured or contact support with the correlation ID.",
        code: missingEnv ? "vercel_config_missing" : "vercel_provision_failed",
        correlationId: requestId,
      },
      500,
    );
  }
});
