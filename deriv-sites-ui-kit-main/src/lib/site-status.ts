/**
 * Single source of truth for "what state is this site actually in?"
 *
 * The database records site state across three places that can disagree:
 *   - sites.status                the editorial lifecycle (draft → pending → active)
 *   - site_integrations.status    the Vercel/GitHub provisioning outcome
 *   - site_domains.status         the hostname state
 *
 * The dashboard used to read all three ad hoc, which is how a site can look
 * "active" in one card and broken in another. Everything that renders a status
 * now goes through these helpers.
 */

export type OperationalStatus =
  | "deployed"
  | "draft"
  | "provisioning"
  | "stalled"
  | "failed";

export type SiteIntegrationSummary = {
  status: string | null;
  netlify_site_url: string | null;
  netlify_site_name: string | null;
  last_error: string | null;
  /** Heartbeat: bumped by a DB trigger on every write. Used to detect stalls. */
  updated_at?: string | null;
} | null;

/**
 * How long a "provisioning" row may sit untouched before we call it stalled.
 *
 * Must match the interval used by the `fail_stale_site_provisioning()` sweeper so
 * the UI and the database agree on when a claim is dead. The provisioning
 * function typically returns in a few seconds; 10 minutes is far beyond any
 * healthy run, including a slow Vercel attach.
 */
export const PROVISIONING_STALL_MINUTES = 10;

export type OperationalState = {
  key: OperationalStatus;
  label: string;
  /** Tailwind class fragment for the pill background + text. */
  tone: string;
  /** True when the site is serving traffic on a reachable hostname. */
  isLive: boolean;
};

const STATES: Record<OperationalStatus, Omit<OperationalState, "key">> = {
  deployed: {
    label: "Deployed",
    tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    isLive: true,
  },
  provisioning: {
    label: "Provisioning",
    tone: "bg-sky-500/10 text-sky-400 border-sky-500/20",
    isLive: false,
  },
  failed: {
    label: "Needs attention",
    tone: "bg-red-500/10 text-red-400 border-red-500/20",
    isLive: false,
  },
  draft: {
    label: "Draft",
    tone: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    isLive: false,
  },
  stalled: {
    label: "Stalled — retry",
    tone: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    isLive: false,
  },
};

/**
 * True when a `provisioning` integration has not been touched recently enough.
 *
 * Returns false when the timestamp is missing: an unknown age is not evidence of
 * a stall, and guessing would flap the UI on older rows.
 */
export function isProvisioningStalled(
  updatedAt?: string | null,
  now: number = Date.now(),
): boolean {
  if (!updatedAt) return false;
  const touched = new Date(updatedAt).getTime();
  if (Number.isNaN(touched)) return false;
  return now - touched > PROVISIONING_STALL_MINUTES * 60_000;
}

/**
 * Resolve the state shown to the operator.
 *
 * Order matters and is deliberate: the provider is the authority on whether a
 * site is actually serving. A site marked `active` in Postgres whose Vercel
 * attach failed is NOT live, and pretending otherwise is what makes operators
 * stop trusting the dashboard.
 */
export function resolveOperationalState(input: {
  siteStatus?: string | null;
  integration?: SiteIntegrationSummary;
  hostname?: string | null;
}): OperationalState {
  const integrationStatus = input.integration?.status ?? null;

  if (integrationStatus === "failed") {
    return { key: "failed", ...STATES.failed };
  }
  if (integrationStatus === "provisioning") {
    // A killed invocation never reaches the catch block that writes `failed`, so
    // the row sits at `provisioning` forever. Treat an untouched row as stalled
    // once the heartbeat is older than the sweeper interval.
    return isProvisioningStalled(input.integration?.updated_at)
      ? { key: "stalled", ...STATES.stalled }
      : { key: "provisioning", ...STATES.provisioning };
  }
  if (integrationStatus === "connected") {
    // Connected alone isn't enough — we need somewhere to point the browser.
    return input.hostname
      ? { key: "deployed", ...STATES.deployed }
      : { key: "provisioning", ...STATES.provisioning };
  }
  if (input.siteStatus === "active") {
    return { key: "deployed", ...STATES.deployed };
  }
  if (input.siteStatus === "pending") {
    return { key: "provisioning", ...STATES.provisioning };
  }
  return { key: "draft", ...STATES.draft };
}

/* ------------------------------------------------------------------ */
/* Readiness checklist                                                 */
/* ------------------------------------------------------------------ */

export type ReadinessStep = {
  key: string;
  label: string;
  /** Where the operator goes to finish this step. */
  href?: string;
  detail?: string;
};

export type ReadinessInput = {
  siteId: string;
  hostname?: string | null;
  domainVerified?: boolean | null;
  configurationStatus?: string | null;
  publishedAt?: string | null;
  integration?: SiteIntegrationSummary;
  hasDerivApp?: boolean;
};

/**
 * The setup checklist. Each entry maps to something we genuinely store, so a
 * ticked box is a fact rather than a guess.
 */
export function buildReadinessChecklist(input: ReadinessInput): ReadinessStep[] {
  const editorHref = `/sites/${input.siteId}/wizard`;
  const isPublished =
    Boolean(input.publishedAt) || input.configurationStatus === "published";

  return [
    {
      key: "domain",
      label: "Domain chosen",
      href: editorHref,
      detail: input.hostname ?? "No hostname yet",
    },
    {
      key: "verified",
      label: "Domain verified",
      href: `/sites/${input.siteId}/deployments`,
      detail: input.domainVerified ? "Verified by provider" : "Pending verification",
    },
    {
      key: "deriv_app",
      label: "Deriv app linked",
      href: editorHref,
      detail: input.hasDerivApp ? "OAuth client attached" : "Assign an app to go live",
    },
    {
      key: "published",
      label: "Configuration published",
      href: editorHref,
      detail: isPublished ? "Published version exists" : "Still a draft",
    },
    {
      key: "deployed",
      label: "Deployed to Vercel",
      href: `/sites/${input.siteId}/deployments`,
      detail: input.integration?.status ?? "Not provisioned",
    },
  ];
}

export function isStepComplete(
  step: ReadinessStep,
  input: ReadinessInput,
): boolean {
  switch (step.key) {
    case "domain":
      return Boolean(input.hostname);
    case "verified":
      return Boolean(input.domainVerified);
    case "deriv_app":
      return Boolean(input.hasDerivApp);
    case "published":
      return (
        Boolean(input.publishedAt) || input.configurationStatus === "published"
      );
    case "deployed":
      return input.integration?.status === "connected";
    default:
      return false;
  }
}

/**
 * 0–100 readiness score, used by the score bar in the site editor.
 * Equal weight per step keeps it explainable: "you've done 3 of 5 things".
 */
export function computeReadinessScore(input: ReadinessInput): number {
  const steps = buildReadinessChecklist(input);
  const done = steps.filter((step) => isStepComplete(step, input)).length;
  return Math.round((done / steps.length) * 100);
}

/* ------------------------------------------------------------------ */
/* Platform types                                                      */
/* ------------------------------------------------------------------ */

export type PlatformType = {
  /** Matches site_configurations.template_id when the site has been configured. */
  id: string;
  label: string;
};

/**
 * Platform families, mirroring the tab row operators expect.
 *
 * `deriv-bot` is the only template we ship today, so it is the only tab that
 * will have sites in it. The rest are declared so that adding a template later
 * surfaces its tab automatically instead of requiring a UI change — the filter
 * row renders All plus whichever platforms are actually present in the data.
 */
export const PLATFORM_TYPES: PlatformType[] = [
  { id: "deriv-bot", label: "Bot Platform" },
  { id: "smart-trader", label: "SmartTrader" },
  { id: "air-run", label: "Air Run" },
  { id: "pulse", label: "Pulse" },
  { id: "digit-trader", label: "Digit Trader" },
  { id: "ai-builder", label: "AI Builder" },
];

export const UNASSIGNED_PLATFORM: PlatformType = {
  id: "unassigned",
  label: "Unassigned",
};

export function platformLabel(templateId?: string | null): string {
  if (!templateId) return UNASSIGNED_PLATFORM.label;
  return (
    PLATFORM_TYPES.find((type) => type.id === templateId)?.label ??
    UNASSIGNED_PLATFORM.label
  );
}

/** Tabs to render: All, then only the platforms with at least one site. */
export function buildPlatformTabs(
  presentTemplateIds: Array<string | null | undefined>,
): Array<PlatformType & { count: number }> {
  const counts = new Map<string, number>();
  for (const raw of presentTemplateIds) {
    const id = raw && PLATFORM_TYPES.some((t) => t.id === raw)
      ? raw
      : UNASSIGNED_PLATFORM.id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tabs: Array<PlatformType & { count: number }> = [
    {
      id: "all",
      label: "All",
      count: presentTemplateIds.length,
    },
  ];

  for (const type of PLATFORM_TYPES) {
    const count = counts.get(type.id);
    if (count) tabs.push({ ...type, count });
  }

  const unassigned = counts.get(UNASSIGNED_PLATFORM.id);
  if (unassigned) {
    tabs.push({ ...UNASSIGNED_PLATFORM, count: unassigned });
  }

  return tabs;
}

/** Short, human-readable environment label for a site card. */
export function environmentLabel(siteStatus?: string | null): string {
  if (siteStatus === "active") return "Production";
  if (siteStatus === "deleted") return "Deleted";
  return "Draft";
}
