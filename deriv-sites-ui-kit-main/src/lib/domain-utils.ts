import { supabase } from "@/integrations/supabase/client";

export type DomainMode = "vercel_subdomain" | "custom_domain" | "buy_domain";

export type DomainVerificationRecord = {
  type: string;
  domain: string;
  value: string;
  reason?: string;
};

export type DnsInstruction = {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
  purpose: string;
  required: boolean;
};

export type SiteDomainSummary = {
  id?: string;
  hostname: string;
  is_primary?: boolean;
  status?: string;
  is_verified?: boolean;
  ssl_status?: string | null;
};

export type SiteWithDomains = {
  id: string;
  name: string;
  domain_id?: string | null;
  domain_purchases?: { domain_name: string } | null;
  site_domains?: SiteDomainSummary[] | null;
};

export const VERCEL_SUFFIX = ".vercel.app";

export const RESERVED_HOSTNAMES = new Set([
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

export function normalizeHostnameInput(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";

  const withoutProtocol = trimmed.replace(/^[a-z]+:\/\//i, "");
  const hostOnly = withoutProtocol
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .split(":")[0]
    .replace(/\.+$/, "")
    .trim();

  return hostOnly;
}

export function normalizeVercelSlug(raw: string): string {
  const cleaned = normalizeHostnameInput(raw);
  const withoutSuffix = cleaned.endsWith(VERCEL_SUFFIX)
    ? cleaned.slice(0, -VERCEL_SUFFIX.length)
    : cleaned;

  return withoutSuffix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function buildVercelHostname(slugOrHostname: string): string {
  const slug = normalizeVercelSlug(slugOrHostname);
  return slug ? `${slug}${VERCEL_SUFFIX}` : "";
}

export function isVercelAppHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const normalized = normalizeHostnameInput(hostname);
  return normalized.endsWith(VERCEL_SUFFIX);
}

export function extractVercelSlug(hostname: string | null | undefined): string {
  if (!hostname) return "";
  const normalized = normalizeHostnameInput(hostname);
  if (!normalized.endsWith(VERCEL_SUFFIX)) return "";
  const prefix = normalized.slice(0, -VERCEL_SUFFIX.length);
  return prefix.includes(".") ? "" : prefix;
}

export function validateVercelSlug(raw: string): {
  valid: boolean;
  slug: string;
  hostname: string;
  error?: string;
} {
  const cleaned = normalizeHostnameInput(raw);
  if (cleaned.endsWith(VERCEL_SUFFIX)) {
    const prefix = cleaned.slice(0, -VERCEL_SUFFIX.length);
    if (prefix.includes(".")) {
      return {
        valid: false,
        slug: normalizeVercelSlug(prefix),
        hostname: "",
        error:
          "Vercel only supports single-level names like my-brand.vercel.app (not sub.project.vercel.app).",
      };
    }
  }

  const slug = normalizeVercelSlug(raw);
  if (!slug) {
    return {
      valid: false,
      slug: "",
      hostname: "",
      error: "Enter a free Vercel subdomain name (for example: alpha-traders).",
    };
  }

  if (slug.length < 3) {
    return {
      valid: false,
      slug,
      hostname: `${slug}${VERCEL_SUFFIX}`,
      error: "Subdomain must be at least 3 characters long.",
    };
  }

  if (!VERCEL_SLUG_REGEX.test(slug)) {
    return {
      valid: false,
      slug,
      hostname: `${slug}${VERCEL_SUFFIX}`,
      error: "Use only lowercase letters, numbers, and single hyphens.",
    };
  }

  if (slug.includes("--") || slug.includes("-git-")) {
    return {
      valid: false,
      slug,
      hostname: `${slug}${VERCEL_SUFFIX}`,
      error: "Avoid '--' or '-git-' in Vercel subdomains (reserved by Vercel preview URLs).",
    };
  }

  const hostname = `${slug}${VERCEL_SUFFIX}`;
  if (RESERVED_VERCEL_SLUGS.has(slug) || RESERVED_HOSTNAMES.has(hostname)) {
    return {
      valid: false,
      slug,
      hostname,
      error: `"${hostname}" is reserved by the platform. Choose a different subdomain.`,
    };
  }

  return { valid: true, slug, hostname };
}

export function validateCustomHostname(raw: string): {
  valid: boolean;
  hostname: string;
  isVercelSubdomain: boolean;
  error?: string;
} {
  const hostname = normalizeHostnameInput(raw);
  if (!hostname) {
    return {
      valid: false,
      hostname: "",
      isVercelSubdomain: false,
      error: "Enter a domain name (for example: mybrand.com or trade.mybrand.com).",
    };
  }

  if (RESERVED_HOSTNAMES.has(hostname)) {
    return {
      valid: false,
      hostname,
      isVercelSubdomain: hostname.endsWith(VERCEL_SUFFIX),
      error: `"${hostname}" is reserved by the platform. Enter your own domain.`,
    };
  }

  if (hostname.endsWith(VERCEL_SUFFIX)) {
    const check = validateVercelSlug(hostname);
    return {
      valid: check.valid,
      hostname: check.hostname || hostname,
      isVercelSubdomain: true,
      error: check.error,
    };
  }

  if (!HOSTNAME_REGEX.test(hostname)) {
    return {
      valid: false,
      hostname,
      isVercelSubdomain: false,
      error: "Enter a valid domain name (for example: mybrand.com or app.mybrand.com).",
    };
  }

  return { valid: true, hostname, isVercelSubdomain: false };
}

export function suggestVercelSlugs(base: string): string[] {
  const core = normalizeVercelSlug(base).slice(0, 48) || "my-trading";
  return [`${core}-fx`, `${core}-trade`, `${core}-hub`].filter(
    candidate => !RESERVED_VERCEL_SLUGS.has(candidate),
  );
}

export function isApexDomain(hostname: string): boolean {
  const normalized = normalizeHostnameInput(hostname);
  if (!normalized || normalized.endsWith(VERCEL_SUFFIX)) return false;

  const labels = normalized.split(".");
  if (labels.length <= 2) return true;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return labels.length === 3;
  }

  return false;
}

export function extractSubdomainLabel(hostname: string): string {
  const normalized = normalizeHostnameInput(hostname);
  const labels = normalized.split(".");
  if (labels.length <= 2) return "@";

  const lastTwo = labels.slice(-2).join(".");
  const rootLabelCount = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
  if (labels.length <= rootLabelCount) return "@";

  return labels.slice(0, labels.length - rootLabelCount).join(".");
}

export function getRequiredDnsRecords(
  hostname: string,
  verification: DomainVerificationRecord[] = [],
): DnsInstruction[] {
  const normalized = normalizeHostnameInput(hostname);
  if (!normalized || isVercelAppHostname(normalized)) {
    return [];
  }

  const instructions: DnsInstruction[] = [];

  for (const record of verification) {
    if (record.domain && record.value) {
      instructions.push({
        type: (record.type?.toUpperCase() as "TXT" | "A" | "CNAME") || "TXT",
        name: record.domain,
        value: record.value,
        purpose: "Confirms domain ownership with Vercel before activation",
        required: true,
      });
    }
  }

  if (isApexDomain(normalized)) {
    instructions.push({
      type: "A",
      name: "@",
      value: "76.76.21.21",
      purpose: "Points your root domain to Vercel (SSL is issued automatically)",
      required: true,
    });
    instructions.push({
      type: "CNAME",
      name: "www",
      value: "cname.vercel-dns.com",
      purpose: "Optional: points www to Vercel if you also want www redirects",
      required: false,
    });
  } else {
    instructions.push({
      type: "CNAME",
      name: extractSubdomainLabel(normalized),
      value: "cname.vercel-dns.com",
      purpose: "Points your subdomain to Vercel (SSL is issued automatically)",
      required: true,
    });
  }

  return instructions;
}

export function buildDerivCallbackUrl(hostname: string): string {
  const normalized = normalizeHostnameInput(hostname);
  return normalized ? `https://${normalized}/api/deriv-oauth-callback` : "";
}

export function getSitePrimaryDomainRecord(
  site: SiteWithDomains | null | undefined,
): SiteDomainSummary | null {
  if (!site?.site_domains?.length) return null;
  return site.site_domains.find(d => d.is_primary) || site.site_domains[0] || null;
}

export function getSitePrimaryHostname(
  site: SiteWithDomains | null | undefined,
): string | null {
  if (!site) return null;
  const primary = getSitePrimaryDomainRecord(site);
  if (primary?.hostname) return primary.hostname;
  if (site.domain_purchases?.domain_name) return site.domain_purchases.domain_name;
  return null;
}

export function getDomainKindLabel(
  site: SiteWithDomains,
  hostname: string | null,
): "Free Vercel" | "Purchased" | "Custom Domain" | "Unassigned" {
  if (!hostname) return "Unassigned";
  if (isVercelAppHostname(hostname)) return "Free Vercel";
  if (
    site.domain_id &&
    site.domain_purchases?.domain_name?.toLowerCase() === hostname.toLowerCase()
  ) {
    return "Purchased";
  }
  return "Custom Domain";
}

export function friendlyDomainSaveError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : "Failed to save domain";

  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  if (
    code === "23505" ||
    code === "42501" ||
    /site_domains_hostname_unique|duplicate key|row-level security/i.test(raw)
  ) {
    return "This domain is already connected to another site. Choose a different domain or remove it from the other site first.";
  }

  return raw;
}

export async function ensureUserOrganisationId(
  userId: string,
  email?: string | null,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data: memberships, error: membershipError } = await db
    .from("organisation_members")
    .select("organisation_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("role", ["tenant_owner", "tenant_developer"])
    .limit(1);

  if (membershipError) throw new Error(membershipError.message);

  const existing = memberships?.[0]?.organisation_id;
  if (existing) return existing;

  const fallbackName = `${email?.split("@")[0] || "My"} sites`;
  const created = await db.rpc("create_personal_organisation", {
    _name: fallbackName,
  });
  if (created.error) throw new Error(created.error.message);
  return created.data as string;
}

export async function attachHostnameToSite(
  siteId: string,
  rawHostname: string,
): Promise<{ hostname: string; status: string; is_verified: boolean }> {
  const check = validateCustomHostname(rawHostname);
  if (!check.valid) {
    throw new Error(check.error || "Invalid domain name");
  }

  const hostname = check.hostname;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  // Check if this site already has this exact hostname so we preserve verified status.
  const { data: existingForSite } = await db
    .from("site_domains")
    .select("id, hostname, status, is_verified, ssl_status")
    .eq("site_id", siteId)
    .eq("hostname", hostname)
    .maybeSingle();

  if (existingForSite) {
    const { error: promoteError } = await db
      .from("site_domains")
      .update({ is_primary: true })
      .eq("id", existingForSite.id);
    if (promoteError) throw new Error(friendlyDomainSaveError(promoteError));

    await db
      .from("site_domains")
      .update({ is_primary: false })
      .eq("site_id", siteId)
      .neq("id", existingForSite.id);

    return {
      hostname: existingForSite.hostname,
      status: existingForSite.status,
      is_verified: existingForSite.is_verified,
    };
  }

  const { data: inserted, error: insertError } = await db
    .from("site_domains")
    .insert({
      site_id: siteId,
      hostname,
      is_primary: true,
      status: "pending",
      is_verified: false,
      ssl_status: "pending",
    })
    .select("id, hostname, status, is_verified")
    .single();

  if (insertError) {
    throw new Error(friendlyDomainSaveError(insertError));
  }

  await db
    .from("site_domains")
    .update({ is_primary: false })
    .eq("site_id", siteId)
    .neq("id", inserted.id);

  return {
    hostname: inserted.hostname,
    status: inserted.status,
    is_verified: inserted.is_verified,
  };
}

export async function createDraftSite(options: {
  userId: string;
  email?: string | null;
  name?: string;
  plan?: "partnership_monthly" | "one_time";
  domainMode?: DomainMode;
  hostname?: string;
  domainId?: string | null;
}): Promise<{ siteId: string; organisationId: string; hostname: string }> {
  const normalizedHostname = options.hostname
    ? normalizeHostnameInput(options.hostname)
    : "";

  if (normalizedHostname) {
    const check = validateCustomHostname(normalizedHostname);
    if (!check.valid) {
      throw new Error(check.error || "Invalid domain name");
    }
  }

  const organisationId = await ensureUserOrganisationId(
    options.userId,
    options.email,
  );

  const inferredName =
    options.name?.trim() ||
    (normalizedHostname
      ? extractVercelSlug(normalizedHostname) || normalizedHostname.split(".")[0]
      : "") ||
    "Untitled site";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data: site, error: siteError } = await db
    .from("sites")
    .insert({
      user_id: options.userId,
      organisation_id: organisationId,
      domain_id: options.domainId ?? null,
      name: inferredName,
      internal_name: inferredName,
      status: "draft",
    })
    .select("id")
    .single();

  if (siteError || !site?.id) {
    throw new Error(siteError?.message || "Failed to create draft site");
  }

  const siteId = site.id as string;

  if (normalizedHostname) {
    try {
      await attachHostnameToSite(siteId, normalizedHostname);
    } catch (domainErr) {
      // Soft-delete the empty draft site so failed domain conflicts never leave orphan drafts.
      await db.from("sites").update({ status: "deleted" }).eq("id", siteId);
      throw domainErr;
    }
  }

  if (options.plan || normalizedHostname || options.domainMode) {
    const resolvedMode: DomainMode =
      options.domainMode ||
      (normalizedHostname
        ? isVercelAppHostname(normalizedHostname)
          ? "vercel_subdomain"
          : options.domainId
            ? "buy_domain"
            : "custom_domain"
        : "vercel_subdomain");

    const callbackUri = normalizedHostname
      ? buildDerivCallbackUrl(normalizedHostname)
      : "";

    await db.from("site_configurations").insert({
      organisation_id: organisationId,
      site_id: siteId,
      version: 1,
      schema_version: 1,
      template_id: "deriv-bot",
      template_version: "1.0.0",
      status: "draft",
      wizard_step: options.plan ? 2 : 1,
      created_by: options.userId,
      configuration: {
        commercial: {
          plan: options.plan || "partnership_monthly",
          paymentPhone: "",
          paymentEmail: options.email || "",
          acceptedTerms: false,
        },
        project: {
          siteName: inferredName === "Untitled site" ? "" : inferredName,
          internalName: inferredName === "Untitled site" ? "" : inferredName,
          description: "",
          organisationName: "",
          supportEmail: options.email || "",
          supportContact: "",
          language: "en",
          region: "",
        },
        deployment: {
          domainMode: resolvedMode,
          subdomain: extractVercelSlug(normalizedHostname),
          customDomain: normalizedHostname,
          provider: "vercel",
          branch: "main",
          buildCommand: "npm run build",
          outputDirectory: "dist",
        },
        deriv: {
          appId: "",
          oauthClientId: "",
          callbackUri,
          environment: "production",
          markupRate: "",
        },
      },
      validation_result: {
        blocking: [],
        warnings: [],
        checkedAt: new Date().toISOString(),
      },
    });

    if (callbackUri) {
      await db.from("site_deriv_apps").upsert(
        {
          site_id: siteId,
          redirect_uri: callbackUri,
          use_legacy_oauth_login: false,
          include_legacy_app_id_in_oauth: false,
        },
        { onConflict: "site_id" },
      );
    }
  }

  return { siteId, organisationId, hostname: normalizedHostname };
}
