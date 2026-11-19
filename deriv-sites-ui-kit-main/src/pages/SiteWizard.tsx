import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  Globe,
  Link2,
  Loader2,
  Palette,
  RefreshCw,
  Save,
  ShoppingCart,
  Sparkles,
  Upload,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminRole } from "@/hooks/useAdminRole";
import { requiredScopesForFeatures, SCOPE_REGISTRY } from "@reef-sites/deriv-auth";
import { TEMPLATE_REGISTRY } from "@reef-sites/template-registry";
import type { DerivFeature, ValidationIssue } from "@reef-sites/shared-types";
import { toast } from "sonner";
import AdminMarkupStats from "@/components/AdminMarkupStats";
import BuyDomainDialog from "@/components/BuyDomainDialog";
import {
  attachHostnameToSite,
  buildDerivCallbackUrl,
  buildVercelHostname,
  type DomainMode,
  type DomainVerificationRecord,
  extractVercelSlug,
  getRequiredDnsRecords,
  isVercelAppHostname,
  isValidPolicyUrl,
  normalizeHostnameInput,
  normalizeVercelSlug,
  validateCustomHostname,
  validateVercelSlug,
  VERCEL_SUFFIX,
} from "@/lib/domain-utils";
import {
  ProvisionDomainError,
  provisionSiteDomain,
} from "@/lib/site-runtime-config";
import {
  assignPlatformDerivAppToSite,
  assignSiteOwner,
  CENTRAL_DERIV_CALLBACK_URL,
  clampMarkupRate,
  DEFAULT_MARKUP_RATE,
  DEFAULT_RISK_DISCLAIMER,
  formatMarkupRate,
  decimalString,
  getPlatformDerivPoolStatus,
  listPlatformUsers,
  MARKUP_PRESETS,
  ownerShareRate,
  suggestedVercelSlug,
  type AssignPoolAppResult,
  type PlatformDerivPoolStatus,
  type PlatformUserOption,
} from "@/lib/platform-deriv";
import { Slider } from "@/components/ui/slider";

type CommercialPlan = "partnership_monthly" | "one_time";

type ImportedBot = {
  id: string;
  name: string;
  description: string;
  fileName: string;
  filePath: string;
  xmlContent?: string;
  category: "free";
  displayOrder: number;
  isActive: boolean;
};

type WizardDraft = {
  commercial: {
    plan: CommercialPlan;
    paymentPhone: string;
    paymentEmail: string;
    acceptedTerms: boolean;
  };
  project: {
    siteName: string;
    internalName: string;
    description: string;
    organisationName: string;
    supportEmail: string;
    supportContact: string;
    language: string;
    region: string;
  };
  deployment: {
    domainMode: DomainMode;
    subdomain: string;
    customDomain: string;
    provider: "vercel" | "netlify";
    branch: string;
    buildCommand: string;
    outputDirectory: string;
  };
  branding: {
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    backgroundColor: string;
    surfaceColor: string;
    textColor: string;
    logoUrl: string;
    faviconUrl: string;
    siteTitle: string;
    typography: string;
    borderRadius: string;
    poweredByDeriv: boolean;
  };
  template: { id: string; version: string };
  deriv: {
    mode: "platform_managed" | "custom";
    appId: string;
    oauthClientId: string;
    callbackUri: string;
    environment: "staging" | "production";
    markupRate: string;
    ownerDerivLoginId: string;
    affiliateId: string;
  };
  features: Record<DerivFeature, boolean>;
  bots: ImportedBot[];
  navigation: Array<{ key: string; label: string; slug: string; enabled: boolean; order: number }>;
  legal: { privacyUrl: string; termsUrl: string; riskDisclaimer: string; disclaimerText: string };
};

const featureChoices: Array<{ key: DerivFeature; label: string; status: "ready" | "experimental" }> = [
  { key: "public_market_data", label: "Public market data", status: "ready" },
  { key: "account_list", label: "Options account selection", status: "ready" },
  { key: "options_trading", label: "Options trading", status: "ready" },
  { key: "markup_statistics", label: "Markup statistics", status: "ready" },
  { key: "account_creation", label: "Options account creation", status: "experimental" },
  { key: "wallet_balances", label: "Wallet balances", status: "experimental" },
  { key: "wallet_transactions", label: "Wallet transactions", status: "experimental" },
  { key: "application_management", label: "Application management", status: "experimental" },
];

const steps = [
  { label: "Plan", icon: CreditCard },
  { label: "Identity", icon: Wand2 },
  { label: "Colors", icon: Palette },
  { label: "Template", icon: Eye },
  { label: "Free bots", icon: Bot },
  { label: "Deriv tools", icon: CheckCircle2 },
  { label: "Domain", icon: Globe },
  { label: "Legal", icon: AlertCircle },
  { label: "Review", icon: Check },
  { label: "Payment", icon: CreditCard },
];

const initialDraft = (): WizardDraft => ({
  commercial: { plan: "partnership_monthly", paymentPhone: "", paymentEmail: "", acceptedTerms: false },
  project: { siteName: "", internalName: "", description: "", organisationName: "", supportEmail: "", supportContact: "", language: "en", region: "" },
  deployment: { domainMode: "vercel_subdomain", subdomain: "", customDomain: "", provider: "vercel", branch: "main", buildCommand: "npm run build", outputDirectory: "dist" },
  branding: {
    primaryColor: "#0ea5e9",
    secondaryColor: "#111827",
    accentColor: "#22c55e",
    backgroundColor: "#f8fafc",
    surfaceColor: "#ffffff",
    textColor: "#0f172a",
    logoUrl: "",
    faviconUrl: "",
    siteTitle: "",
    typography: "Inter",
    borderRadius: "8px",
    poweredByDeriv: true,
  },
  template: { id: "deriv-bot", version: "1.0.0" },
  deriv: {
    mode: "platform_managed",
    appId: "",
    oauthClientId: "",
    callbackUri: CENTRAL_DERIV_CALLBACK_URL,
    environment: "production",
    markupRate: "2.5",
    ownerDerivLoginId: "",
    affiliateId: "",
  },
  features: { public_market_data: true, account_list: true, options_trading: true, account_creation: false, wallet_balances: false, wallet_transactions: false, markup_statistics: false, application_management: false },
  bots: [],
  navigation: [
    { key: "home", label: "Home", slug: "/", enabled: true, order: 0 },
    { key: "free_bots", label: "Free Bots", slug: "/free-bots", enabled: true, order: 1 },
    { key: "bot", label: "Bot Builder", slug: "/bot", enabled: true, order: 2 },
    { key: "charts", label: "Charts", slug: "/charts", enabled: true, order: 3 },
    { key: "support", label: "Support", slug: "/support", enabled: true, order: 4 },
    { key: "privacy", label: "Privacy", slug: "/privacy", enabled: true, order: 5 },
    { key: "terms", label: "Terms", slug: "/terms", enabled: true, order: 6 },
  ],
  legal: {
    privacyUrl: "/privacy",
    termsUrl: "/terms",
    riskDisclaimer: DEFAULT_RISK_DISCLAIMER,
    disclaimerText: "",
  },
});

const getEffectiveHostname = (deployment: WizardDraft["deployment"]): string => {
  if (deployment.domainMode === "vercel_subdomain") {
    return buildVercelHostname(deployment.subdomain || deployment.customDomain);
  }
  return normalizeHostnameInput(deployment.customDomain);
};

const normalizeDraft = (value: Partial<WizardDraft>): WizardDraft => {
  const fallback = initialDraft();
  const navigation = Array.isArray(value.navigation) ? [...value.navigation] : [...fallback.navigation];
  for (const mandatory of fallback.navigation.filter(item => ["privacy", "terms", "free_bots"].includes(item.key))) {
    if (!navigation.some(item => item.key === mandatory.key)) navigation.push(mandatory);
  }
  const rawDeployment = {
    ...fallback.deployment,
    ...value.deployment,
    provider: "vercel" as const,
  };
  const normalizedCustom = normalizeHostnameInput(rawDeployment.customDomain || "");
  const inferredMode: DomainMode =
    value.deployment?.domainMode ||
    (normalizedCustom
      ? isVercelAppHostname(normalizedCustom)
        ? "vercel_subdomain"
        : "custom_domain"
      : "vercel_subdomain");
  const nameForSlug =
    value.project?.siteName?.trim() || value.project?.internalName?.trim() || "";
  const inferredSlug =
    inferredMode === "vercel_subdomain"
      ? normalizeVercelSlug(rawDeployment.subdomain || normalizedCustom) ||
        suggestedVercelSlug(nameForSlug)
      : rawDeployment.subdomain || "";
  const syncedCustomDomain =
    inferredMode === "vercel_subdomain"
      ? buildVercelHostname(inferredSlug)
      : normalizedCustom;

  const resolvedDeriv = { ...fallback.deriv, ...value.deriv };
  if (resolvedDeriv.mode !== "custom") resolvedDeriv.mode = "platform_managed";
  if (!Number.isFinite(Number(resolvedDeriv.markupRate)) || resolvedDeriv.markupRate === "") {
    resolvedDeriv.markupRate = String(DEFAULT_MARKUP_RATE);
  } else {
    resolvedDeriv.markupRate = decimalString(resolvedDeriv.markupRate);
  }
  if (resolvedDeriv.mode === "platform_managed") {
    resolvedDeriv.callbackUri = resolvedDeriv.callbackUri?.trim() || CENTRAL_DERIV_CALLBACK_URL;
  }
  if (!resolvedDeriv.ownerDerivLoginId) resolvedDeriv.ownerDerivLoginId = "";
  if (!resolvedDeriv.affiliateId) resolvedDeriv.affiliateId = "";

  const resolvedLegal = { ...fallback.legal, ...value.legal };
  if (!resolvedLegal.privacyUrl?.trim()) resolvedLegal.privacyUrl = fallback.legal.privacyUrl;
  if (!resolvedLegal.termsUrl?.trim()) resolvedLegal.termsUrl = fallback.legal.termsUrl;
  if (!resolvedLegal.riskDisclaimer?.trim()) resolvedLegal.riskDisclaimer = DEFAULT_RISK_DISCLAIMER;

  return {
    ...fallback,
    ...value,
    commercial: { ...fallback.commercial, ...value.commercial },
    project: { ...fallback.project, ...value.project },
    deployment: {
      ...rawDeployment,
      domainMode: inferredMode,
      subdomain: inferredSlug,
      customDomain: syncedCustomDomain,
    },
    branding: { ...fallback.branding, ...value.branding },
    template: { ...fallback.template, ...value.template },
    deriv: resolvedDeriv,
    features: { ...fallback.features, ...value.features },
    bots: Array.isArray(value.bots) ? value.bots.map((bot, index) => ({ ...bot, category: "free", displayOrder: bot.displayOrder ?? index, isActive: bot.isActive ?? true })) : fallback.bots,
    legal: resolvedLegal,
    navigation,
  };
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^(\+?254|0)?[17]\d{8}$/;

const validateDraft = (draft: WizardDraft): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const block = (code: string, message: string, field?: string) => issues.push({ code, message, field, severity: "blocking" });

  if (draft.project.siteName.trim().length < 2) block("site_name_missing", "Site name is required.", "project.siteName");
  if (!emailPattern.test(draft.project.supportEmail)) block("support_email_invalid", "A valid support email is required.", "project.supportEmail");

  const effectiveDomain = getEffectiveHostname(draft.deployment);
  if (draft.deployment.domainMode === "vercel_subdomain") {
    const check = validateVercelSlug(draft.deployment.subdomain || draft.deployment.customDomain);
    if (!check.valid) {
      block("domain_invalid", check.error || "Choose a valid free .vercel.app subdomain.", "deployment.subdomain");
    }
  } else if (draft.deployment.domainMode === "buy_domain") {
    const check = validateCustomHostname(draft.deployment.customDomain);
    if (!check.valid) {
      block(
        "domain_invalid",
        "Purchase a domain in Step 7, or switch to Free Vercel URL / Connect Existing Domain.",
        "deployment.customDomain",
      );
    }
  } else {
    const check = validateCustomHostname(draft.deployment.customDomain);
    if (!check.valid) {
      block("domain_invalid", check.error || "Enter a valid domain you own.", "deployment.customDomain");
    }
  }

  const platformManaged = draft.deriv.mode !== "custom";
  if (platformManaged) {
    // The superuser pool supplies the v2 DevHub App; the site only needs a markup tier.
    const markup = Number(draft.deriv.markupRate);
    if (!Number.isFinite(markup) || markup < 0 || markup > 3) {
      block("markup_invalid", "Commission markup must be between 0% and 3%.", "deriv.markupRate");
    }
    const ownerLoginId = draft.deriv.ownerDerivLoginId.trim();
    if (ownerLoginId && !/^(CR|MF|VRTC|VR|MLT|MX|SVG)\d{3,20}$/i.test(ownerLoginId)) {
      block("owner_loginid_invalid", "Owner Deriv account must look like CR1234567 (or leave it blank).", "deriv.ownerDerivLoginId");
    }
  } else {
    if (!draft.deriv.appId.trim()) block("deriv_app_id_missing", "Deriv App ID is required.", "deriv.appId");
    if (!draft.deriv.oauthClientId.trim()) block("oauth_client_missing", "Deriv OAuth client ID is required.", "deriv.oauthClientId");
    try {
      const callback = new URL(draft.deriv.callbackUri);
      const expected = effectiveDomain ? buildDerivCallbackUrl(effectiveDomain) : "";
      if (callback.protocol !== "https:" || (expected && callback.toString() !== expected)) {
        block("callback_invalid", `Register and enter the exact callback URL: ${expected || "https://your-domain/api/deriv-oauth-callback"}`, "deriv.callbackUri");
      }
    } catch {
      block("callback_invalid", "The exact registered HTTPS callback URL is required.", "deriv.callbackUri");
    }
  }
  if (!draft.legal.privacyUrl.trim()) block("privacy_missing", "Privacy policy URL is required.", "legal.privacyUrl");
  else if (!isValidPolicyUrl(draft.legal.privacyUrl)) block("privacy_invalid", "Privacy policy must be a /path on this site or a full https:// URL.", "legal.privacyUrl");
  if (!draft.legal.termsUrl.trim()) block("terms_missing", "Terms URL is required.", "legal.termsUrl");
  else if (!isValidPolicyUrl(draft.legal.termsUrl)) block("terms_invalid", "Terms must be a /path on this site or a full https:// URL.", "legal.termsUrl");
  if (!draft.legal.riskDisclaimer.trim()) block("risk_missing", "A risk disclaimer is required.", "legal.riskDisclaimer");
  if (!emailPattern.test(draft.commercial.paymentEmail)) block("payment_email_missing", "Payment email is required at the final step.", "commercial.paymentEmail");
  if (!phonePattern.test(draft.commercial.paymentPhone.replace(/\s+/g, "").replace(/-/g, ""))) block("payment_phone_missing", "A valid M-Pesa phone number is required at the final step.", "commercial.paymentPhone");
  if (!draft.commercial.acceptedTerms) block("payment_terms_missing", "Accept the selected payment terms before publishing.", "commercial.acceptedTerms");

  for (const item of draft.navigation) {
    if (item.enabled && !item.slug.startsWith("/")) block("route_invalid", `${item.label} needs a route beginning with /.`, "navigation");
  }
  for (const requiredKey of ["privacy", "terms", "free_bots"]) {
    if (!draft.navigation.some(item => item.key === requiredKey && item.enabled)) block("mandatory_route_missing", `${requiredKey} must remain enabled.`, "navigation");
  }
  for (const feature of featureChoices.filter(item => item.status !== "ready")) {
    if (draft.features[feature.key]) block("feature_unavailable", `${feature.label} is not production-ready in this template.`, `features.${feature.key}`);
  }
  return issues;
};

const formatColorLabel = (key: string) =>
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, char => char.toUpperCase());

const DerivMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
    <path d="M3 12.2 8.4 6.6h6.2c3.1 0 5.4 2.3 5.4 5.4s-2.3 5.4-5.4 5.4H8.4L3 12.2Z" fill="currentColor" opacity="0.28" />
    <path d="M7.4 12.2 10.6 9h4c1.9 0 3.2 1.4 3.2 3.2s-1.3 3.2-3.2 3.2h-4l-3.2-3.2Z" fill="currentColor" />
  </svg>
);

const Field = ({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) => (
  <label className="block space-y-1.5">
    <span className="block text-sm font-medium text-slate-800">{label}</span>
    {children}
    {help ? <span className="block text-xs leading-5 text-slate-600">{help}</span> : null}
  </label>
);

const SiteWizard = () => {
  const { siteId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isAdmin, canManageSites } = useAdminRole();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<WizardDraft>(initialDraft);
  const [organisationId, setOrganisationId] = useState("");
  const [configurationId, setConfigurationId] = useState<string | null>(null);
  const [configurationVersion, setConfigurationVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [buyDialogOpen, setBuyDialogOpen] = useState(false);
  const [savedDomainState, setSavedDomainState] = useState<{
    hostname: string;
    status: string;
    isVerified: boolean;
  } | null>(null);
  const [domainActionPending, setDomainActionPending] = useState<false | "attach" | "verify">(false);
  const [vercelVerification, setVercelVerification] = useState<DomainVerificationRecord[]>([]);
  const [slugSuggestions, setSlugSuggestions] = useState<string[]>([]);
  const [poolStatus, setPoolStatus] = useState<PlatformDerivPoolStatus | null>(null);
  const [platformUsers, setPlatformUsers] = useState<PlatformUserOption[]>([]);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [ownerAssignPending, setOwnerAssignPending] = useState(false);
  const [derivAssignPending, setDerivAssignPending] = useState(false);
  const replayingPublish = useRef(false);
  const effectiveHostname = useMemo(() => getEffectiveHostname(draft.deployment), [draft.deployment]);
  const expectedCallbackUri = useMemo(
    () => (effectiveHostname ? buildDerivCallbackUrl(effectiveHostname) : ""),
    [effectiveHostname],
  );
  const dnsInstructions = useMemo(
    () =>
      draft.deployment.domainMode !== "vercel_subdomain" && effectiveHostname
        ? getRequiredDnsRecords(effectiveHostname, vercelVerification)
        : [],
    [draft.deployment.domainMode, effectiveHostname, vercelVerification],
  );
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const displayIssues = step < 10 ? issues.filter(issue => !issue.field?.startsWith("commercial.")) : issues;
  const requiredScopes = useMemo(() => requiredScopesForFeatures(
    Object.entries(draft.features).filter(([, enabled]) => enabled).map(([key]) => key as DerivFeature)
  ), [draft.features]);
  const traderScopes = requiredScopes.filter(scope => scope !== "application_read");
  const ownerScopes = requiredScopes.filter(scope => scope === "application_read");
  const selectedPlan = draft.commercial.plan === "partnership_monthly"
    ? { title: "Partnership monthly", price: "17%", detail: "Monthly platform share after the site is live." }
    : { title: "One-time setup", price: "KES 25,000", detail: "Single setup payment collected at the final step." };

  const platformManaged = draft.deriv.mode !== "custom";
  const markupValue = clampMarkupRate(draft.deriv.markupRate);
  const platformFeeRate = draft.commercial.plan === "one_time"
    ? 0
    : Number(((poolStatus?.defaultPlatformFeeRate ?? 17) as number).toFixed(2));
  const siteOwnerShare = ownerShareRate(platformFeeRate);
  const showOwnerSelector = Boolean(isAdmin || canManageSites);

  const setDerivMode = (mode: "platform_managed" | "custom") => {
    setDraft(current => ({
      ...current,
      deriv: {
        ...current.deriv,
        mode,
        callbackUri:
          mode === "platform_managed"
            ? CENTRAL_DERIV_CALLBACK_URL
            : current.deriv.callbackUri?.trim() || (effectiveHostname ? buildDerivCallbackUrl(effectiveHostname) : ""),
      },
    }));
  };

  const setMarkupRate = (value: number) => {
    const next = clampMarkupRate(value);
    setDraft(current => ({ ...current, deriv: { ...current.deriv, markupRate: decimalString(next) } }));
  };

  useEffect(() => {
    if (!user) return;
    let active = true;
    getPlatformDerivPoolStatus()
      .then(status => {
        if (active) setPoolStatus(status);
      })
      .catch(() => {
        /* pool status is advisory only */
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!showOwnerSelector) return;
    let active = true;
    listPlatformUsers()
      .then(users => {
        if (active) setPlatformUsers(users);
      })
      .catch(() => {
        /* owner picker stays hidden when the admin API is unavailable */
      });
    return () => {
      active = false;
    };
  }, [showOwnerSelector]);

  const handleAssignOwner = async (nextUserId: string) => {
    setOwnerUserId(nextUserId);
    if (!nextUserId || !siteId) return;
    setOwnerAssignPending(true);
    try {
      const result = await assignSiteOwner(siteId, { userId: nextUserId });
      if (result.organisationId) setOrganisationId(result.organisationId);
      toast.success(`Site assigned to ${result.assignedOwner?.email || "the selected user"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to assign the site owner");
      setOwnerUserId("");
    } finally {
      setOwnerAssignPending(false);
    }
  };

  const syncPlatformDerivApp = async (draftToSave: WizardDraft) => {
    if (!siteId || draftToSave.deriv.mode === "custom") return null;
    setDerivAssignPending(true);
    try {
      const result = await assignPlatformDerivAppToSite({
        siteId,
        markupPercentage: clampMarkupRate(draftToSave.deriv.markupRate),
        environment: draftToSave.deriv.environment,
        scopes: ["trade"],
        plan: draftToSave.commercial.plan,
        ownerDerivLoginId: draftToSave.deriv.ownerDerivLoginId,
        derivAffiliateId: draftToSave.deriv.affiliateId,
      });
      setDraft(current => ({
        ...current,
        deriv: {
          ...current.deriv,
          appId: result.appId || "",
          oauthClientId: result.oauthClientId || "",
          callbackUri: result.callbackUri || CENTRAL_DERIV_CALLBACK_URL,
        },
      }));
      if (result.status === "queued_for_pool") {
        toast.info("Markup saved. The platform Deriv App pool is being provisioned — this site binds automatically.", { id: "pool-queued" });
      }
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to bind the platform Deriv app");
      return null;
    } finally {
      setDerivAssignPending(false);
    }
  };

  useEffect(() => {
    if (!siteId || !user) return;
    (async () => {
      try {
        // Generated database types are refreshed only after the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabase as any;
        const { data: site, error } = await db.from("sites").select("*").eq("id", siteId).single();
        if (error) throw error;
        setOrganisationId(site.organisation_id);
        const [{ data: configuration }, { data: primaryDomain }] = await Promise.all([
          db.from("site_configurations").select("*").eq("site_id", siteId).in("status", ["draft", "invalid", "valid"]).order("version", { ascending: false }).limit(1).maybeSingle(),
          db.from("site_domains").select("*").eq("site_id", siteId).order("is_primary", { ascending: false }).limit(1).maybeSingle(),
        ]);

        if (primaryDomain?.hostname) {
          setSavedDomainState({
            hostname: primaryDomain.hostname.toLowerCase(),
            status: primaryDomain.status || "pending",
            isVerified: Boolean(primaryDomain.is_verified),
          });
        }

        if (configuration?.configuration) {
          const loaded = normalizeDraft(configuration.configuration);
          // Keep wizard in sync if the user updated their domain from the Domains page.
          if (primaryDomain?.hostname) {
            const dbHost = primaryDomain.hostname.toLowerCase();
            if (isVercelAppHostname(dbHost)) {
              loaded.deployment.domainMode = "vercel_subdomain";
              loaded.deployment.subdomain = extractVercelSlug(dbHost);
              loaded.deployment.customDomain = dbHost;
            } else {
              loaded.deployment.domainMode = site.domain_id ? "buy_domain" : "custom_domain";
              loaded.deployment.customDomain = dbHost;
            }
            if (loaded.deriv.mode === "custom" && !loaded.deriv.callbackUri) {
              loaded.deriv.callbackUri = buildDerivCallbackUrl(dbHost);
            }
          }
          // Heal drafts created before the platform pool existed.
          loaded.deriv.mode = site.deriv_mode === "custom" ? "custom" : "platform_managed";
          loaded.deriv.markupRate = decimalString(site.requested_markup_rate ?? loaded.deriv.markupRate);
          loaded.deriv.ownerDerivLoginId = site.owner_deriv_loginid || loaded.deriv.ownerDerivLoginId || "";
          loaded.deriv.affiliateId = site.deriv_affiliate_id || loaded.deriv.affiliateId || "";
          if (loaded.deriv.mode === "platform_managed") {
            loaded.deriv.callbackUri = loaded.deriv.callbackUri || CENTRAL_DERIV_CALLBACK_URL;
          }
          if (!loaded.project.supportEmail) loaded.project.supportEmail = user.email || "";
          if (!loaded.commercial.paymentEmail) loaded.commercial.paymentEmail = loaded.project.supportEmail || user.email || "";
          if (!loaded.commercial.paymentPhone) loaded.commercial.paymentPhone = loaded.project.supportContact || "";
          setDraft(loaded);
          setConfigurationId(configuration.id);
          setConfigurationVersion(configuration.version);
          setStep(Math.min(configuration.wizard_step || 1, steps.length));
        } else {
          const [settings, derivApp, bots, latestConfiguration] = await Promise.all([
            db.from("site_settings").select("*").eq("site_id", siteId).maybeSingle(),
            db.from("site_deriv_apps").select("*").eq("site_id", siteId).maybeSingle(),
            db.from("site_bots_manifest").select("*").eq("site_id", siteId).order("display_order", { ascending: true }),
            db.from("site_configurations").select("version").eq("site_id", siteId).order("version", { ascending: false }).limit(1).maybeSingle(),
          ]);
          const dbHost = (primaryDomain?.hostname || "").toLowerCase();
          const initialMode: DomainMode = dbHost
            ? isVercelAppHostname(dbHost)
              ? "vercel_subdomain"
              : site.domain_id
                ? "buy_domain"
                : "custom_domain"
            : "vercel_subdomain";
          setConfigurationVersion((latestConfiguration.data?.version || 0) + 1);
          setDraft(current => ({
            ...current,
            project: {
              ...current.project,
              siteName: settings.data?.site_name || (site.name === "Untitled site" ? "" : site.name),
              internalName: site.internal_name || (site.name === "Untitled site" ? "" : site.name),
              supportEmail: current.project.supportEmail || user.email || "",
              description: site.description || "",
              language: site.default_language || "en",
              region: site.target_region || "",
            },
            deployment: {
              ...current.deployment,
              domainMode: initialMode,
              subdomain:
                (isVercelAppHostname(dbHost) ? extractVercelSlug(dbHost) : "") ||
                suggestedVercelSlug(
                  settings.data?.site_name || (site.name === "Untitled site" ? "" : site.name),
                  site.internal_name,
                ),
              customDomain:
                dbHost ||
                buildVercelHostname(
                  suggestedVercelSlug(
                    settings.data?.site_name || (site.name === "Untitled site" ? "" : site.name),
                    site.internal_name,
                  ),
                ),
            },
            branding: {
              ...current.branding,
              siteTitle: settings.data?.site_name || (site.name === "Untitled site" ? "" : site.name),
              primaryColor: settings.data?.primary_color || current.branding.primaryColor,
              secondaryColor: settings.data?.secondary_color || current.branding.secondaryColor,
              accentColor: settings.data?.accent_color || current.branding.accentColor,
              logoUrl: settings.data?.logo_url || "",
              faviconUrl: settings.data?.favicon_url || "",
              surfaceColor: settings.data?.custom_css_vars_json?.["--site-surface"] || current.branding.surfaceColor,
              backgroundColor: settings.data?.custom_css_vars_json?.["--site-background"] || current.branding.backgroundColor,
              textColor: settings.data?.custom_css_vars_json?.["--site-text"] || current.branding.textColor,
            },
            deriv: {
              ...current.deriv,
              mode: site.deriv_mode === "custom" ? "custom" : "platform_managed",
              markupRate: decimalString(site.requested_markup_rate ?? current.deriv.markupRate),
              ownerDerivLoginId: site.owner_deriv_loginid || "",
              affiliateId: site.deriv_affiliate_id || "",
              appId: derivApp.data?.deriv_app_id || "",
              oauthClientId: derivApp.data?.oauth_client_id || "",
              callbackUri:
                site.deriv_mode === "custom"
                  ? derivApp.data?.redirect_uri || (dbHost ? buildDerivCallbackUrl(dbHost) : "")
                  : derivApp.data?.redirect_uri || CENTRAL_DERIV_CALLBACK_URL,
            },
            commercial: {
              ...current.commercial,
              paymentEmail: current.commercial.paymentEmail || current.project.supportEmail || user.email || "",
            },
            bots: (bots.data || []).map((bot: { id: string; bot_id?: string | null; display_name: string; description?: string | null; file_path?: string | null; category?: string | null; display_order?: number | null; is_active?: boolean | null }, index: number) => ({
              id: bot.bot_id || bot.id,
              name: bot.display_name,
              description: bot.description || "",
              fileName: bot.file_path?.split("/").pop() || `${bot.display_name}.xml`,
              filePath: bot.file_path || `free-bots/${bot.display_name}.xml`,
              category: "free",
              displayOrder: bot.display_order ?? index,
              isActive: bot.is_active ?? true,
            })),
          }));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to load the site wizard");
      } finally {
        setLoading(false);
      }
    })();
  }, [siteId, user]);

  const updateProject = (key: keyof WizardDraft["project"], value: string) => setDraft(current => {
    const nextProject = { ...current.project, [key]: value };
    // Auto-derive the free .vercel.app slug until the operator edits it manually.
    if (
      (key === "siteName" || key === "internalName") &&
      current.deployment.domainMode === "vercel_subdomain"
    ) {
      const previousSuggestion = normalizeVercelSlug(
        suggestedVercelSlug(current.project.siteName, current.project.internalName),
      );
      const slugIsAuto =
        !current.deployment.subdomain || current.deployment.subdomain === previousSuggestion;
      if (slugIsAuto) {
        const nextSlug = suggestedVercelSlug(nextProject.siteName, nextProject.internalName);
        const prevHost = getEffectiveHostname(current.deployment);
        const nextHost = nextSlug ? buildVercelHostname(nextSlug) : "";
        const nextDeployment = {
          ...current.deployment,
          subdomain: nextSlug,
          customDomain: nextHost,
        };
        return {
          ...current,
          project: nextProject,
          deployment: nextDeployment,
          branding: {
            ...current.branding,
            siteTitle:
              current.branding.siteTitle && current.branding.siteTitle !== current.project.siteName
                ? current.branding.siteTitle
                : nextProject.siteName,
          },
          deriv: {
            ...current.deriv,
            callbackUri: syncCallbackForNextHost(prevHost, nextHost, current.deriv.callbackUri, current.deriv.mode),
          },
        };
      }
    }
    return { ...current, project: nextProject };
  });
  const updateDeployment = (key: keyof WizardDraft["deployment"], value: string) => setDraft(current => ({ ...current, deployment: { ...current.deployment, [key]: value } }));
  const updateBranding = (key: keyof WizardDraft["branding"], value: string | boolean) => setDraft(current => ({ ...current, branding: { ...current.branding, [key]: value } }));
  const updateDeriv = (key: keyof WizardDraft["deriv"], value: string) => setDraft(current => ({ ...current, deriv: { ...current.deriv, [key]: value } }));
  const updateCommercial = (key: keyof WizardDraft["commercial"], value: string | boolean) => setDraft(current => {
    const nextCommercial = { ...current.commercial, [key]: value };
    // Keep payment details pre-filled from the support identity unless the operator typed them.
    if (key === "paymentEmail" && !String(value).trim()) {
      nextCommercial.paymentEmail = current.project.supportEmail || "";
    }
    if (key === "paymentPhone" && !String(value).trim()) {
      nextCommercial.paymentPhone = current.project.supportContact || "";
    }
    return { ...current, commercial: nextCommercial };
  });

  const syncCallbackForNextHost = (
    prevHost: string,
    nextHost: string,
    currentCallback: string,
    mode: "platform_managed" | "custom" = "custom",
  ) => {
    if (mode !== "custom") return CENTRAL_DERIV_CALLBACK_URL;
    const prevExpected = prevHost ? buildDerivCallbackUrl(prevHost) : "";
    const nextExpected = nextHost ? buildDerivCallbackUrl(nextHost) : "";
    if (!currentCallback.trim() || currentCallback.trim() === prevExpected) {
      return nextExpected;
    }
    return currentCallback;
  };

  const selectDomainMode = (mode: DomainMode) => {
    setSlugSuggestions([]);
    setVercelVerification([]);
    setDraft(current => {
      const prevHost = getEffectiveHostname(current.deployment);
      if (mode === "vercel_subdomain") {
        const nextSlug =
          current.deployment.subdomain ||
          extractVercelSlug(current.deployment.customDomain) ||
          normalizeVercelSlug(current.project.siteName);
        const nextHost = buildVercelHostname(nextSlug);
        return {
          ...current,
          deployment: {
            ...current.deployment,
            domainMode: mode,
            subdomain: nextSlug,
            customDomain: nextHost,
          },
          deriv: {
            ...current.deriv,
            callbackUri: syncCallbackForNextHost(prevHost, nextHost, current.deriv.callbackUri, current.deriv.mode),
          },
        };
      }
      const nextCustom = isVercelAppHostname(current.deployment.customDomain)
        ? ""
        : current.deployment.customDomain;
      return {
        ...current,
        deployment: {
          ...current.deployment,
          domainMode: mode,
          customDomain: nextCustom,
        },
        deriv: {
          ...current.deriv,
          callbackUri: nextCustom
            ? syncCallbackForNextHost(prevHost, nextCustom, current.deriv.callbackUri, current.deriv.mode)
            : current.deriv.callbackUri,
        },
      };
    });
  };

  const handleVercelSlugChange = (rawValue: string) => {
    const cleanedSlug = rawValue
      .toLowerCase()
      .replace(/\.vercel\.app$/i, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .slice(0, 63);
    setSlugSuggestions([]);
    setDraft(current => {
      const prevHost = getEffectiveHostname(current.deployment);
      const nextHost = buildVercelHostname(cleanedSlug);
      return {
        ...current,
        deployment: {
          ...current.deployment,
          domainMode: "vercel_subdomain",
          subdomain: cleanedSlug,
          customDomain: nextHost,
        },
        deriv: {
          ...current.deriv,
          callbackUri: syncCallbackForNextHost(prevHost, nextHost, current.deriv.callbackUri, current.deriv.mode),
        },
      };
    });
  };

  const handleCustomDomainChange = (rawValue: string, normalize = false) => {
    const nextValue = normalize ? normalizeHostnameInput(rawValue) : rawValue.toLowerCase();
    setVercelVerification([]);
    setDraft(current => {
      const prevHost = getEffectiveHostname(current.deployment);
      const nextNormalized = normalizeHostnameInput(nextValue);
      return {
        ...current,
        deployment: {
          ...current.deployment,
          customDomain: nextValue,
        },
        deriv: {
          ...current.deriv,
          callbackUri: syncCallbackForNextHost(
            prevHost,
            nextNormalized,
            current.deriv.callbackUri,
            current.deriv.mode,
          ),
        },
      };
    });
  };

  const handleVerifyOrAttachDomain = async (action: "attach" | "verify") => {
    const mode = draft.deployment.domainMode;
    const validation =
      mode === "vercel_subdomain"
        ? validateVercelSlug(draft.deployment.subdomain || draft.deployment.customDomain)
        : validateCustomHostname(draft.deployment.customDomain);

    if (!validation.valid || !validation.hostname) {
      toast.error(validation.error || "Enter a valid domain first");
      return;
    }

    setDomainActionPending(action);
    setSlugSuggestions([]);

    try {
      const attachedLocal = await attachHostnameToSite(siteId, validation.hostname);
      setSavedDomainState({
        hostname: attachedLocal.hostname,
        status: attachedLocal.status,
        isVerified: attachedLocal.is_verified,
      });

      const result = await provisionSiteDomain(siteId, {
        action,
        hostname: validation.hostname,
      });

      if (result.domainVerification.length) {
        setVercelVerification(result.domainVerification);
      } else {
        setVercelVerification([]);
      }

      if (result.domain) {
        setSavedDomainState({
          hostname: result.domain.hostname,
          status: result.domain.status,
          isVerified: result.domain.isVerified,
        });
      }

      if (result.domain?.isVerified) {
        toast.success(
          result.domain.isVercelSubdomain
            ? `https://${result.domain.hostname} is claimed and active on Vercel!`
            : `${result.domain.hostname} DNS is verified and SSL is ready!`,
        );
      } else if (result.domainVerification.length > 0) {
        toast.info(
          "Add the TXT verification record and DNS record shown below at your registrar, then click Verify DNS.",
        );
      } else {
        toast.info(
          "Domain attached on Vercel. Add the DNS record below at your registrar, wait a few minutes, then click Verify DNS.",
        );
      }
    } catch (error) {
      if (error instanceof ProvisionDomainError && error.suggestions.length) {
        setSlugSuggestions(error.suggestions);
      }
      toast.error(
        error instanceof Error ? error.message : "Unable to verify domain on Vercel",
      );
    } finally {
      setDomainActionPending(false);
    }
  };

  const copyToClipboard = async (value: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(label);
    } catch {
      toast.error("Unable to copy");
    }
  };

  const input = (
    value: string,
    onChange: (value: string) => void,
    type = "text",
    placeholder?: string,
  ) => (
    <Input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={event => onChange(event.target.value)}
      className="border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:border-sky-600 focus-visible:ring-sky-600/20"
    />
  );

  const importBots = async (files: FileList | null) => {
    if (!files?.length) return;
    const imported = await Promise.all(Array.from(files).map(async (file, index) => {
      const xmlContent = await file.text();
      const name = file.name.replace(/\.(xml|txt)$/i, "").replace(/[-_]+/g, " ").trim() || file.name;
      return {
        id: `free-${crypto.randomUUID()}`,
        name,
        description: "Imported free bot",
        fileName: file.name,
        filePath: `free-bots/${file.name}`,
        xmlContent,
        category: "free" as const,
        displayOrder: draft.bots.length + index,
        isActive: true,
      };
    }));
    setDraft(current => ({
      ...current,
      bots: [...current.bots, ...imported],
      navigation: current.navigation.map(item => item.key === "free_bots" ? { ...item, enabled: true } : item),
    }));
    toast.success(`${imported.length} bot${imported.length === 1 ? "" : "s"} imported for Free Bots`);
  };

  const saveDraft = async (nextStep = step, draftToSave = draft) => {
    if (!user || !organisationId) throw new Error("Site access is not available");
    setSaving(true);
    try {
      // Generated database types are refreshed only after the migration is applied.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const resolvedDomain = getEffectiveHostname(draftToSave.deployment);
      const syncedDraft: WizardDraft = {
        ...draftToSave,
        deployment: {
          ...draftToSave.deployment,
          customDomain: resolvedDomain,
        },
      };
      let platformAssign: AssignPoolAppResult | null = null;
      if (syncedDraft.deriv.mode !== "custom") {
        platformAssign = await syncPlatformDerivApp(syncedDraft);
        if (platformAssign?.appId) {
          syncedDraft.deriv.appId = platformAssign.appId;
          syncedDraft.deriv.oauthClientId = platformAssign.oauthClientId || platformAssign.appId;
          syncedDraft.deriv.callbackUri = platformAssign.callbackUri;
        }
      }
      const draftIssues = validateDraft(syncedDraft);
      const draftScopes = requiredScopesForFeatures(Object.entries(syncedDraft.features).filter(([, enabled]) => enabled).map(([key]) => key as DerivFeature));
      const payload = {
        organisation_id: organisationId,
        site_id: siteId,
        version: configurationVersion,
        schema_version: 1,
        template_id: syncedDraft.template.id,
        template_version: syncedDraft.template.version,
        status: draftIssues.some(issue => issue.severity === "blocking") ? "invalid" : "valid",
        wizard_step: nextStep,
        configuration: syncedDraft,
        validation_result: { blocking: draftIssues.filter(issue => issue.severity === "blocking"), warnings: draftIssues.filter(issue => issue.severity === "warning"), checkedAt: new Date().toISOString() },
        created_by: user.id,
      };
      const query = configurationId
        ? db.from("site_configurations").update(payload).eq("id", configurationId)
        : db.from("site_configurations").insert(payload);
      const { data, error } = await query.select("id, version").single();
      if (error) throw error;
      setConfigurationId(data.id);
      setConfigurationVersion(data.version);
      const nextSiteName = syncedDraft.project.siteName.trim() || "Untitled site";
      const writes = [
        db.from("sites").update({
          name: nextSiteName,
          internal_name: syncedDraft.project.internalName.trim() || nextSiteName,
          description: syncedDraft.project.description.trim(),
          default_language: syncedDraft.project.language,
          target_region: syncedDraft.project.region || null,
          configuration_status: payload.status,
          deriv_mode: syncedDraft.deriv.mode,
          requested_markup_rate: clampMarkupRate(syncedDraft.deriv.markupRate),
          platform_fee_rate: syncedDraft.commercial.plan === "one_time" ? 0 : platformFeeRate,
          owner_deriv_loginid: syncedDraft.deriv.ownerDerivLoginId.trim() || null,
          deriv_affiliate_id: syncedDraft.deriv.affiliateId.trim() || null,
        }).eq("id", siteId),
        db.from("site_settings").upsert({
          site_id: siteId,
          site_name: syncedDraft.branding.siteTitle || nextSiteName,
          brand_name: syncedDraft.project.siteName.trim() || nextSiteName,
          logo_url: syncedDraft.branding.logoUrl || null,
          favicon_url: syncedDraft.branding.faviconUrl || null,
          primary_color: syncedDraft.branding.primaryColor,
          secondary_color: syncedDraft.branding.secondaryColor,
          accent_color: syncedDraft.branding.accentColor,
          custom_css_vars_json: {
            "--site-background": syncedDraft.branding.backgroundColor,
            "--site-surface": syncedDraft.branding.surfaceColor,
            "--site-text": syncedDraft.branding.textColor,
            "--site-radius": syncedDraft.branding.borderRadius,
          },
        }, { onConflict: "site_id" }),
        db.from("site_deriv_apps").upsert({
          site_id: siteId,
          deriv_app_id: syncedDraft.deriv.appId || null,
          oauth_client_id: syncedDraft.deriv.oauthClientId || null,
          redirect_uri: syncedDraft.deriv.callbackUri || CENTRAL_DERIV_CALLBACK_URL,
          deriv_mode: syncedDraft.deriv.mode,
          markup_percentage: clampMarkupRate(syncedDraft.deriv.markupRate),
          platform_deriv_app_id: platformAssign?.status === "assigned" ? platformAssign.platformDerivAppId : null,
        }, { onConflict: "site_id" }),
      ];
      if (syncedDraft.deriv.mode === "custom" && syncedDraft.deriv.appId.trim() && syncedDraft.deriv.oauthClientId.trim() && syncedDraft.deriv.callbackUri.trim()) {
        writes.push(db.from("deriv_applications").upsert({ organisation_id: organisationId, site_id: siteId, app_id: syncedDraft.deriv.appId.trim(), oauth_client_id: syncedDraft.deriv.oauthClientId.trim(), callback_uri: syncedDraft.deriv.callbackUri.trim(), environment: syncedDraft.deriv.environment, configured_scopes: draftScopes, markup_rate: syncedDraft.deriv.markupRate ? Number(syncedDraft.deriv.markupRate) : null, verification_status: "configured", source_type: "custom", platform_deriv_app_id: null }, { onConflict: "site_id" }));
      }
      const results = await Promise.all(writes);
      const failedWrite = results.find(result => result.error);
      if (failedWrite?.error) throw failedWrite.error;
      if (resolvedDomain && validateCustomHostname(resolvedDomain).valid) {
        const domainState = await attachHostnameToSite(siteId, resolvedDomain);
        setSavedDomainState({
          hostname: domainState.hostname,
          status: domainState.status,
          isVerified: domainState.is_verified,
        });
      }
      await db.from("site_bots_manifest").delete().eq("site_id", siteId);
      if (syncedDraft.bots.length) {
        const botRows = syncedDraft.bots.map((bot, index) => ({
          site_id: siteId,
          bot_id: bot.id,
          display_name: bot.name,
          description: bot.description || null,
          file_path: bot.filePath,
          category: "free",
          display_order: index,
          is_active: bot.isActive,
        }));
        const { error: botsError } = await db.from("site_bots_manifest").insert(botRows);
        if (botsError) throw botsError;
      }
      setDraft(syncedDraft);
      toast.success(
        platformAssign?.status === "queued_for_pool" ? "Draft saved · queued for the platform Deriv app pool" : "Draft saved",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save draft");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const publishQueueKey = `reef:queued-publish:${siteId}`;
  const invokePublish = async () => {
    const { data, error } = await supabase.functions.invoke("publish-site-to-github", { body: { siteId } });
    if (error || data?.error) throw new Error(data?.error || error?.message || "Publishing failed");
  };

  const publish = async () => {
    const blocking = issues.filter(issue => issue.severity === "blocking");
    if (blocking.length) {
      toast.error(`Resolve ${blocking.length} blocking validation issue${blocking.length === 1 ? "" : "s"}.`);
      setStep(9);
      return;
    }
    try {
      await saveDraft(10);
      if (effectiveHostname) {
        try {
          const provisioned = await provisionSiteDomain(siteId, {
            action: "provision",
            hostname: effectiveHostname,
          });
          if (provisioned.domain) {
            setSavedDomainState({
              hostname: provisioned.domain.hostname,
              status: provisioned.domain.status,
              isVerified: provisioned.domain.isVerified,
            });
          }
          if (provisioned.domainVerification.length) {
            setVercelVerification(provisioned.domainVerification);
          }
        } catch (domainError) {
          // A missing server-side Vercel token must not block the GitHub commit/publish flow.
          const message = domainError instanceof Error ? domainError.message : "";
          if (domainError instanceof ProvisionDomainError && domainError.suggestions.length) throw domainError;
          if (!/VERCEL_ACCESS_TOKEN|vercel.*token|not configured/i.test(message)) throw domainError;
          toast.info("Domain attach skipped — Vercel token is not configured. Publishing the site anyway.");
        }
      }
      await invokePublish();
      localStorage.removeItem(publishQueueKey);
      toast.success(
        isVercelAppHostname(effectiveHostname)
          ? `Site published and live at https://${effectiveHostname}!`
          : "Configuration committed. If DNS is still propagating, verify your domain in Deployment status.",
      );
      navigate(`/sites/${siteId}/config`);
    } catch (error) {
      if (error instanceof ProvisionDomainError && error.suggestions.length) {
        setSlugSuggestions(error.suggestions);
        setStep(7);
        toast.error(error.message);
        return;
      }
      if (!navigator.onLine || (error instanceof Error && /fetch|network|offline/i.test(`${error.name} ${error.message}`))) {
        localStorage.setItem(publishQueueKey, JSON.stringify({ draft, queuedAt: new Date().toISOString() }));
        toast.info("Update queued on this device. Reopen Site Manager after reconnecting and it will publish automatically.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Publishing failed");
    }
  };

  useEffect(() => {
    if (loading || !user || !organisationId || !siteId) return;
    const replay = async () => {
      if (replayingPublish.current || !navigator.onLine) return;
      const raw = localStorage.getItem(publishQueueKey);
      if (!raw) return;
      replayingPublish.current = true;
      try {
        const queued = JSON.parse(raw) as { draft?: Partial<WizardDraft> };
        const queuedDraft = normalizeDraft(queued.draft || {});
        if (validateDraft(queuedDraft).some(issue => issue.severity === "blocking")) {
          localStorage.removeItem(publishQueueKey);
          setDraft(queuedDraft);
          setStep(9);
          toast.error("The queued update needs review before it can be published.");
          return;
        }
        setDraft(queuedDraft);
        await saveDraft(10, queuedDraft);
        await invokePublish();
        localStorage.removeItem(publishQueueKey);
        toast.success("Queued update committed after connectivity returned.");
        navigate(`/sites/${siteId}/config`);
      } catch (error) {
        if (navigator.onLine) toast.error(error instanceof Error ? error.message : "Queued publishing failed");
      } finally {
        replayingPublish.current = false;
      }
    };
    window.addEventListener("online", replay);
    if (navigator.onLine) void replay();
    return () => window.removeEventListener("online", replay);
    // Replay is intentionally bound after the remote draft and tenant context load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, organisationId, siteId, configurationId]);

  const connectOwnerDeriv = async () => {
    try {
      if (!draft.features.markup_statistics) {
        toast.error("Enable Markup statistics before connecting reporting.");
        setStep(6);
        return;
      }
      await saveDraft(step);
      const { data, error } = await supabase.functions.invoke("deriv-owner-oauth-start", {
        body: { siteId, scopes: ["application_read"], returnPath: `/sites/${siteId}/wizard` },
      });
      if (error || !data?.authorizationUrl) throw new Error(data?.error?.message || error?.message || "Unable to start Deriv connection");
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to connect Deriv");
    }
  };

  if (loading) {
    return (
      <div className="light-surface flex-1 grid place-items-center bg-slate-50 text-slate-700">
        <Loader2 className="w-7 h-7 animate-spin text-sky-700" />
      </div>
    );
  }

  return (
    <div className="light-surface flex-1 bg-slate-50 text-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mt-1 text-slate-700 hover:bg-slate-200/70 hover:text-slate-950">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold tracking-normal text-slate-950">Customer site wizard</h1>
              <p className="mt-1 text-sm text-slate-600">Version {configurationVersion}. Build the site first, collect payment at the end, then publish to GitHub and Vercel.</p>
            </div>
          </div>
          <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
            <span className="text-slate-600">Selected plan</span>
            <div className="font-semibold text-slate-950">{selectedPlan.title} · {selectedPlan.price}</div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[250px_1fr]">
          <aside className="space-y-2">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const active = step === index + 1;
              return (
                <button
                  key={item.label}
                  onClick={() => setStep(index + 1)}
                  className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition ${active ? "border-sky-600 bg-sky-50/70 text-slate-950 shadow-sm ring-1 ring-sky-600/20" : index + 1 < step ? "border-emerald-200 bg-emerald-50 text-emerald-900 hover:border-emerald-300" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950"}`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? "text-sky-700" : index + 1 < step ? "text-emerald-700" : "text-slate-500"}`} />
                  <span className="font-medium">{item.label}</span>
                </button>
              );
            })}
          </aside>

          <main className="min-h-[620px] rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            {step === 1 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Choose how this site pays</h2>
                  <p className="mt-1 text-sm text-slate-600">Every customer chooses one of these two models, and payment is handled after configuration review.</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {[
                    { key: "partnership_monthly" as const, title: "Partnership monthly", price: "17%", caption: "Monthly platform share", points: ["Lower entry cost", "Good for testing a new community", "Pay after the website setup is ready"] },
                    { key: "one_time" as const, title: "One-time setup", price: "KES 25,000", caption: "Single payment", points: ["No monthly platform percentage", "Best for established traders", "Payment still happens at the final step"] },
                  ].map(plan => (
                    <button
                      key={plan.key}
                      onClick={() => updateCommercial("plan", plan.key)}
                      className={`rounded-lg border p-5 text-left transition ${draft.commercial.plan === plan.key ? "border-sky-500 bg-sky-50" : "border-slate-200 hover:border-slate-300"}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="font-semibold text-slate-950">{plan.title}</h3>
                          <p className="mt-1 text-sm text-slate-500">{plan.caption}</p>
                        </div>
                        <div className="text-2xl font-semibold text-slate-950">{plan.price}</div>
                      </div>
                      <ul className="mt-5 space-y-2">
                        {plan.points.map(point => (
                          <li key={point} className="flex items-center gap-2 text-sm text-slate-600"><Check className="h-4 w-4 text-emerald-600" />{point}</li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {step === 2 ? (
              <section className="space-y-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">Who is this site for?</h2>
                    <p className="mt-1 text-sm text-slate-600">Give it a name, a free public URL, and set the Deriv commission markup before anything else.</p>
                  </div>
                  <div className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${poolStatus?.poolReady ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                    <DerivMark className="h-3.5 w-3.5" />
                    {poolStatus?.poolReady
                      ? `${poolStatus.activeAppCount} v2 DevHub App${poolStatus.activeAppCount === 1 ? "" : "s"} ready`
                      : "Deriv App pool warming up"}
                  </div>
                </div>

                {showOwnerSelector ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">Create for another user</p>
                        <p className="text-xs text-slate-600">Assign the site, its organisation and Deriv attribution to an existing account.</p>
                      </div>
                      <select
                        className="h-9 min-w-[240px] rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900"
                        value={ownerUserId}
                        disabled={ownerAssignPending}
                        onChange={event => void handleAssignOwner(event.target.value)}
                      >
                        <option value="">Keep current owner</option>
                        {platformUsers.map(option => (
                          <option key={option.id} value={option.id}>{option.email}{option.display_name ? ` · ${option.display_name}` : ""}</option>
                        ))}
                      </select>
                    </div>
                    {ownerAssignPending ? (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600"><Loader2 className="h-3 w-3 animate-spin" />Reassigning owner…</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid gap-4">
                  <Field label="Site name">{input(draft.project.siteName, value => updateProject("siteName", value), "text", "e.g. Apex Traders Hub")}</Field>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Internal project name">{input(draft.project.internalName, value => updateProject("internalName", value), "text", "e.g. apex-traders")}</Field>
                    <Field label="Owner or organisation">{input(draft.project.organisationName, value => updateProject("organisationName", value), "text", "e.g. Apex Trading Group")}</Field>
                  </div>
                  <Field label="Site title" help="Shown in the browser tab and the public header.">{input(draft.branding.siteTitle, value => updateBranding("siteTitle", value), "text", draft.project.siteName || "e.g. Apex Traders — Automated Bots")}</Field>
                  <Field label="Description">
                    <textarea
                      className="min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                      placeholder="Briefly describe your trading community, bots, and education offering..."
                      value={draft.project.description}
                      onChange={event => updateProject("description", event.target.value)}
                    />
                  </Field>
                </div>

                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">Domain</p>
                      <p className="text-xs text-slate-600">Launch free on <code>.vercel.app</code>, connect a domain you own, or buy a new one.</p>
                    </div>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">No setup required</span>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {([
                      { mode: "vercel_subdomain" as const, label: "Free Vercel URL", hint: "Instant SSL" },
                      { mode: "custom_domain" as const, label: "Connect own", hint: "Point DNS" },
                      { mode: "buy_domain" as const, label: "Buy domain", hint: "M-Pesa" },
                    ]).map(option => (
                      <button
                        key={option.mode}
                        type="button"
                        onClick={() => selectDomainMode(option.mode)}
                        className={`rounded-md border px-3 py-2 text-left text-xs transition ${draft.deployment.domainMode === option.mode ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500/30" : "border-slate-200 bg-white hover:border-slate-300"}`}
                      >
                        <span className="block font-semibold text-slate-950">{option.label}</span>
                        <span className="text-slate-500">{option.hint}</span>
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 space-y-1.5">
                    {draft.deployment.domainMode === "vercel_subdomain" ? (
                      <div className="flex items-center rounded-md border border-slate-300 bg-white focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/20">
                        <span className="pl-3 text-sm text-slate-400 select-none">https://</span>
                        <input
                          type="text"
                          value={draft.deployment.subdomain}
                          onChange={event => handleVercelSlugChange(event.target.value)}
                          placeholder="alpha-traders"
                          className="flex-1 bg-transparent px-1.5 py-2 text-sm text-slate-950 outline-none"
                        />
                        <span className="pr-3 text-sm font-medium text-slate-500 select-none">{VERCEL_SUFFIX}</span>
                      </div>
                    ) : (
                      <Input
                        value={draft.deployment.customDomain}
                        onChange={event => handleCustomDomainChange(event.target.value, false)}
                        onBlur={event => handleCustomDomainChange(event.target.value, true)}
                        placeholder="mybrand.com or trade.mybrand.com"
                        className="bg-white"
                      />
                    )}
                    {(() => {
                      if (draft.deployment.domainMode === "vercel_subdomain" && !draft.deployment.subdomain) {
                        return <p className="text-xs text-slate-500">Type a site name above and the free URL fills in automatically.</p>;
                      }
                      const check = draft.deployment.domainMode === "vercel_subdomain"
                        ? validateVercelSlug(draft.deployment.subdomain)
                        : validateCustomHostname(draft.deployment.customDomain);
                      if (!check.valid) return <p className="text-xs text-red-600">{check.error}</p>;
                      return (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-slate-600">Public URL: <strong className="text-slate-950">https://{check.hostname}</strong></span>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={Boolean(domainActionPending)}
                              onClick={() => handleVerifyOrAttachDomain("attach")}
                            >
                              {domainActionPending === "attach" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5 text-sky-600" />}
                              Claim on Vercel
                            </Button>
                            {draft.deployment.domainMode === "buy_domain" ? (
                              <Button type="button" size="sm" onClick={() => setBuyDialogOpen(true)}>
                                <ShoppingCart className="mr-1.5 h-3.5 w-3.5" />Buy domain
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">Commission Markup</p>
                      <p className="text-xs text-slate-600">You keep {siteOwnerShare}% of the Deriv markup generated here. Deriv allows 0%–3%.</p>
                    </div>
                    <span className="rounded-md bg-slate-950 px-2.5 py-1 text-sm font-semibold text-white">{formatMarkupRate(markupValue)}</span>
                  </div>
                  <div className="mt-4 px-1">
                    <Slider
                      value={[markupValue]}
                      min={0}
                      max={3}
                      step={0.5}
                      onValueChange={values => setMarkupRate(values[0] ?? DEFAULT_MARKUP_RATE)}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {MARKUP_PRESETS.map(preset => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setMarkupRate(preset)}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${Math.abs(markupValue - preset) < 0.001 ? "border-sky-500 bg-sky-50 text-sky-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}
                      >
                        {formatMarkupRate(preset)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                    <DerivMark className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                    <span>
                      <strong>Automatic v2 DevHub App.</strong>{" "}
                      {poolStatus?.poolReady
                        ? `This site binds the ${formatMarkupRate(markupValue)} tier app automatically — no Deriv dashboard work needed.`
                        : "The superuser Deriv App pool is being provisioned. The site saves now and binds the moment a pool app exists."}
                      {draft.deriv.appId ? <> Current app ID: <code className="text-slate-900">{draft.deriv.appId}</code>.</> : null}
                    </span>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Support email">{input(draft.project.supportEmail, value => updateProject("supportEmail", value), "email", "support@yourdomain.com")}</Field>
                  <Field label="Support contact">{input(draft.project.supportContact, value => updateProject("supportContact", value), "text", "+254 712 345 678 or @telegram")}</Field>
                  <Field label="Owner Deriv account" help="Optional. CR/MF account used for commission payouts.">{input(draft.deriv.ownerDerivLoginId, value => updateDeriv("ownerDerivLoginId", value.toUpperCase()), "text", "CR1234567")}</Field>
                  <Field label="Deriv affiliate ID" help="Optional. Credited alongside the platform markup.">{input(draft.deriv.affiliateId, value => updateDeriv("affiliateId", value), "text", "e.g. 12345")}</Field>
                  <Field label="Default language">{input(draft.project.language, value => updateProject("language", value), "text", "en")}</Field>
                  <Field label="Target region">{input(draft.project.region, value => updateProject("region", value), "text", "e.g. Kenya / Global")}</Field>
                </div>
              </section>
            ) : null}

            {step === 3 ? (
              <section className="grid gap-6 xl:grid-cols-[1fr_420px]">
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">Set colors and preview</h2>
                    <p className="mt-1 text-sm text-slate-600">Pick the public theme before domain setup so the user sees the brand taking shape early.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    {(["primaryColor", "secondaryColor", "accentColor", "backgroundColor", "surfaceColor", "textColor"] as const).map(key => (
                      <Field key={key} label={formatColorLabel(key)}>
                        <div className="flex gap-2">
                          <Input type="color" className="h-10 w-14 cursor-pointer border-slate-300 bg-white p-1" value={draft.branding[key]} onChange={event => updateBranding(key, event.target.value)} />
                          {input(draft.branding[key], value => updateBranding(key, value), "text", "#0ea5e9")}
                        </div>
                      </Field>
                    ))}
                    <Field label="Site title">{input(draft.branding.siteTitle, value => updateBranding("siteTitle", value), "text", "e.g. Apex Traders — Automated Bots")}</Field>
                    <Field label="Logo URL">{input(draft.branding.logoUrl, value => updateBranding("logoUrl", value), "text", "https://example.com/logo.png")}</Field>
                    <Field label="Typography">{input(draft.branding.typography, value => updateBranding("typography", value), "text", "Inter")}</Field>
                    <Field label="Border radius">{input(draft.branding.borderRadius, value => updateBranding("borderRadius", value), "text", "12px")}</Field>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50/70 p-3">
                    <span className="text-sm font-medium text-slate-800">Show Powered by Deriv attribution</span>
                    <Switch checked={draft.branding.poweredByDeriv} onCheckedChange={value => updateBranding("poweredByDeriv", value)} />
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-4">
                  <div
                    className="overflow-hidden rounded-md border"
                    style={{ backgroundColor: draft.branding.backgroundColor, color: draft.branding.textColor, borderRadius: draft.branding.borderRadius }}
                  >
                    <div className="flex items-center justify-between px-4 py-3" style={{ backgroundColor: draft.branding.surfaceColor }}>
                      <div className="flex items-center gap-2">
                        <div className="grid h-8 w-8 place-items-center rounded-md text-sm font-semibold text-white" style={{ backgroundColor: draft.branding.primaryColor }}>
                          {(draft.project.siteName || "S").slice(0, 1)}
                        </div>
                        <span className="font-semibold">{draft.branding.siteTitle || draft.project.siteName || "Trader site"}</span>
                      </div>
                      <span className="rounded px-2 py-1 text-xs text-white" style={{ backgroundColor: draft.branding.accentColor }}>Live</span>
                    </div>
                    <div className="space-y-4 p-5">
                      <h3 className="text-2xl font-semibold">Free bots for your traders</h3>
                      <p className="text-sm opacity-75">Imported bots appear here, with your colors applied across buttons, badges and panels.</p>
                      <div className="grid gap-3">
                        {(draft.bots.length ? draft.bots.slice(0, 2) : [{ name: "Rise Fall Starter", description: "Example free bot" }, { name: "Volatility Scout", description: "Example free bot" }]).map(bot => (
                          <div key={bot.name} className="rounded-md border p-3" style={{ backgroundColor: draft.branding.surfaceColor }}>
                            <p className="font-medium">{bot.name}</p>
                            <p className="text-xs opacity-70">{bot.description}</p>
                          </div>
                        ))}
                      </div>
                      <button className="rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: draft.branding.primaryColor }}>Open bot builder</button>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {step === 4 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold">Choose the trading template</h2>
                  <p className="mt-1 text-sm text-slate-500">Templates decide which runtime and public pages the customer site receives.</p>
                </div>
                <div className="grid gap-4">
                  {TEMPLATE_REGISTRY.map(template => (
                    <button key={`${template.id}:${template.version}`} onClick={() => setDraft(current => ({ ...current, template: { id: template.id, version: template.version } }))} className={`rounded-lg border p-5 text-left ${draft.template.id === template.id ? "border-sky-500 bg-sky-50" : "border-slate-200"}`}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <strong>{template.name}</strong>
                        <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium uppercase text-emerald-700">{template.releaseStatus}</span>
                      </div>
                      <p className="mt-2 text-sm text-slate-500">{template.description}</p>
                      <p className="mt-3 text-xs text-slate-500">Version {template.version} · {template.supportedTradeTypes.join(", ")}</p>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {step === 5 ? (
              <section className="space-y-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">Import free bots</h2>
                    <p className="mt-1 text-sm text-slate-500">Upload XML bot files here. They are added to the Free Bots page in the customer site configuration.</p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white">
                    <Upload className="h-4 w-4" />
                    Import XML
                    <input type="file" accept=".xml,.txt" multiple className="hidden" onChange={event => void importBots(event.target.files)} />
                  </label>
                </div>
                <div className="grid gap-3">
                  {draft.bots.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No bots imported yet. Import XML files to populate the Free Bots page.</div>
                  ) : draft.bots.map((bot, index) => (
                    <div key={bot.id} className="grid gap-3 rounded-lg border border-slate-200 p-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-center">
                      <Switch checked={bot.isActive} onCheckedChange={isActive => setDraft(current => ({ ...current, bots: current.bots.map(row => row.id === bot.id ? { ...row, isActive } : row) }))} />
                      <Input className="border-slate-300 bg-white text-slate-900 placeholder:text-slate-400" placeholder="Bot name" value={bot.name} onChange={event => setDraft(current => ({ ...current, bots: current.bots.map(row => row.id === bot.id ? { ...row, name: event.target.value } : row) }))} />
                      <Input className="border-slate-300 bg-white text-slate-900 placeholder:text-slate-400" placeholder="Bot description" value={bot.description} onChange={event => setDraft(current => ({ ...current, bots: current.bots.map(row => row.id === bot.id ? { ...row, description: event.target.value } : row) }))} />
                      <Button variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setDraft(current => ({ ...current, bots: current.bots.filter(row => row.id !== bot.id).map((row, rowIndex) => ({ ...row, displayOrder: rowIndex })) }))}>Remove</Button>
                      <span className="text-xs text-slate-500 md:col-start-2">Free Bots position {index + 1} · {bot.fileName}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {step === 6 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold">Deriv app and trading tools</h2>
                  <p className="mt-1 text-sm text-slate-500">Select only the tools the site needs. Required Deriv scopes update automatically.</p>
                </div>

                <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">Deriv application</p>
                      <p className="text-xs text-slate-600">
                        Use the platform pool (recommended) or bring your own v2 DevHub App.
                      </p>
                    </div>
                    <div className="inline-flex rounded-md border border-slate-300 bg-slate-50 p-0.5 text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => setDerivMode("platform_managed")}
                        className={`rounded px-2.5 py-1.5 transition ${platformManaged ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                      >
                        Platform managed
                      </button>
                      <button
                        type="button"
                        onClick={() => setDerivMode("custom")}
                        className={`rounded px-2.5 py-1.5 transition ${!platformManaged ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                      >
                        Custom Deriv app
                      </button>
                    </div>
                  </div>

                  {platformManaged ? (
                    <div className="space-y-3">
                      <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                        <DerivMark className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                        <span>
                          {poolStatus?.poolReady
                            ? "Assigned automatically from the superuser v2 DevHub App pool. The callback stays on the central DSites endpoint, so traders are attributed to this site even on a custom domain."
                            : "No pool app is active yet. This site is saved with the requested markup and binds automatically once the superuser pool is populated."}
                        </span>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Assigned app</p>
                          <p className="text-sm font-semibold text-slate-950">{draft.deriv.appId || "Queued for pool"}</p>
                          <p className="mt-1 text-xs text-slate-500 break-all">OAuth client: {draft.deriv.oauthClientId || "auto"}</p>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Central callback</p>
                          <p className="text-xs font-medium text-slate-950 break-all">{CENTRAL_DERIV_CALLBACK_URL}</p>
                          <p className="mt-1 text-xs text-slate-500">Single-use 60s handoff completes login on this site.</p>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-800">Commission markup</span>
                          <span className="font-semibold text-slate-950">{formatMarkupRate(markupValue)}</span>
                        </div>
                        <Slider value={[markupValue]} min={0} max={3} step={0.5} onValueChange={values => setMarkupRate(values[0] ?? DEFAULT_MARKUP_RATE)} />
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Field label="Environment">
                          <select className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20" value={draft.deriv.environment} onChange={event => updateDeriv("environment", event.target.value)}>
                            <option value="production">Production</option>
                            <option value="staging">Staging</option>
                          </select>
                        </Field>
                        <Field label="Owner Deriv account" help="Optional. Paid the owner share of the markup.">{input(draft.deriv.ownerDerivLoginId, value => updateDeriv("ownerDerivLoginId", value.toUpperCase()), "text", "CR1234567")}</Field>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-3">
                        <p className="text-xs text-slate-600">
                          Markup split: <strong className="text-slate-950">{siteOwnerShare}%</strong> site owner · <strong className="text-slate-950">{platformFeeRate}%</strong> platform
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={derivAssignPending}
                          onClick={() => void syncPlatformDerivApp(draft)}
                        >
                          {derivAssignPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                          Re-sync pool app
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Deriv App ID">{input(draft.deriv.appId, value => updateDeriv("appId", value), "text", "e.g. 68001")}</Field>
                      <Field label="OAuth client ID">{input(draft.deriv.oauthClientId, value => updateDeriv("oauthClientId", value), "text", "Your v2 OAuth client ID")}</Field>
                      <Field label="Environment">
                        <select className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20" value={draft.deriv.environment} onChange={event => updateDeriv("environment", event.target.value)}>
                          <option value="production">Production</option>
                          <option value="staging">Staging</option>
                        </select>
                      </Field>
                      <Field label="Trade markup">{input(draft.deriv.markupRate, value => updateDeriv("markupRate", value), "number", "e.g. 1.5")}</Field>
                      <div className="md:col-span-2">
                        <Field label="Registered callback URL">{input(draft.deriv.callbackUri, value => updateDeriv("callbackUri", value), "text", "https://your-site/api/deriv-oauth-callback")}</Field>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  {featureChoices.map(feature => (
                    <div key={feature.key} className="flex justify-between gap-3 rounded-lg border border-slate-200 p-4">
                      <div>
                        <div className="font-medium text-slate-950">{feature.label} <span className={`ml-2 text-[10px] uppercase ${feature.status === "ready" ? "text-emerald-600" : "text-amber-600"}`}>{feature.status}</span></div>
                        <p className="mt-1 text-xs text-slate-500">{SCOPE_REGISTRY[feature.key].reason}</p>
                        <p className="mt-2 text-xs text-slate-500">Scope: {SCOPE_REGISTRY[feature.key].requiredScopes.join(", ") || "none"}</p>
                      </div>
                      <Switch checked={draft.features[feature.key]} disabled={feature.status !== "ready"} onCheckedChange={enabled => setDraft(current => ({ ...current, features: { ...current.features, [feature.key]: enabled } }))} />
                    </div>
                  ))}
                </div>
                <div className="rounded-md border border-slate-200 p-4 text-sm">
                  <p>Trader login scopes: <span className="font-medium text-slate-950">{traderScopes.join(" ") || "none"}</span></p>
                  <p className="mt-1">Owner reporting scopes: <span className="font-medium text-slate-950">{ownerScopes.join(" ") || "not required"}</span></p>
                </div>
                <div className="rounded-md border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">Markup reporting identity</p>
                      <p className="text-xs text-slate-500">Connect with application_read. The token is encrypted server-side.</p>
                    </div>
                    <Button type="button" variant="outline" onClick={connectOwnerDeriv}>Connect Deriv reporting</Button>
                  </div>
                  {draft.features.markup_statistics ? <AdminMarkupStats enabled={step === 6} siteId={siteId} adminMode={false} title="Your site markup" /> : null}
                </div>
              </section>
            ) : null}

            {step === 7 ? (
              <section className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold">Domain and callback</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    No domain purchase required — launch free on a <code>.vercel.app</code> subdomain, connect a domain you already own, or buy a new domain.
                  </p>
                </div>

                {/* 3 Domain Mode Cards */}
                <div className="grid gap-3 md:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => selectDomainMode("vercel_subdomain")}
                    className={`rounded-lg border p-4 text-left transition ${
                      draft.deployment.domainMode === "vercel_subdomain"
                        ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500/30"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Sparkles className="h-4 w-4 text-sky-600" />
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                        Free · Instant
                      </span>
                    </div>
                    <h3 className="mt-2.5 text-sm font-semibold text-slate-950">
                      Free Vercel Subdomain
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Get <code>your-brand.vercel.app</code> with automatic SSL and zero DNS setup.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => selectDomainMode("custom_domain")}
                    className={`rounded-lg border p-4 text-left transition ${
                      draft.deployment.domainMode === "custom_domain"
                        ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500/30"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Link2 className="h-4 w-4 text-sky-600" />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                        BYO Domain
                      </span>
                    </div>
                    <h3 className="mt-2.5 text-sm font-semibold text-slate-950">
                      Connect Own Domain
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Already own a domain? Point its DNS record to Vercel and verify ownership.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => selectDomainMode("buy_domain")}
                    className={`rounded-lg border p-4 text-left transition ${
                      draft.deployment.domainMode === "buy_domain"
                        ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500/30"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <ShoppingCart className="h-4 w-4 text-sky-600" />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                        M-Pesa
                      </span>
                    </div>
                    <h3 className="mt-2.5 text-sm font-semibold text-slate-950">
                      Buy a New Domain
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Search available <code>.com</code>, <code>.site</code>, and other domains and register here.
                    </p>
                  </button>
                </div>

                {/* Mode 1: Free Vercel Subdomain */}
                {draft.deployment.domainMode === "vercel_subdomain" ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          Free Vercel Subdomain
                        </p>
                        <p className="text-xs text-slate-500">
                          No domain or Vercel account required. You can upgrade this site to a custom domain anytime later.
                        </p>
                      </div>
                      {draft.project.siteName.trim() ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleVercelSlugChange(
                              normalizeVercelSlug(draft.project.siteName),
                            )
                          }
                        >
                          Use "{normalizeVercelSlug(draft.project.siteName)}"
                        </Button>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center rounded-md border border-slate-300 bg-white focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/20">
                        <span className="pl-3 text-sm text-slate-400 select-none">
                          https://
                        </span>
                        <input
                          type="text"
                          value={draft.deployment.subdomain}
                          onChange={event => handleVercelSlugChange(event.target.value)}
                          placeholder="alpha-traders"
                          className="flex-1 bg-transparent px-1.5 py-2 text-sm text-slate-950 outline-none"
                        />
                        <span className="pr-3 text-sm font-medium text-slate-500 select-none">
                          {VERCEL_SUFFIX}
                        </span>
                      </div>

                      {(() => {
                        const check = validateVercelSlug(draft.deployment.subdomain);
                        if (draft.deployment.subdomain && !check.valid) {
                          return <p className="text-xs text-red-600">{check.error}</p>;
                        }
                        if (check.valid) {
                          const isCurrentVerified =
                            savedDomainState?.hostname === check.hostname &&
                            savedDomainState.isVerified;
                          return (
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                              <span className="text-xs text-slate-600">
                                Public URL:{" "}
                                <strong className="text-slate-950">
                                  https://{check.hostname}
                                </strong>
                                {isCurrentVerified ? (
                                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                                    <Check className="h-3 w-3" /> Active + SSL on Vercel
                                  </span>
                                ) : null}
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={Boolean(domainActionPending)}
                                onClick={() => handleVerifyOrAttachDomain("attach")}
                              >
                                {domainActionPending === "attach" ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="mr-1.5 h-3.5 w-3.5 text-sky-600" />
                                )}
                                {isCurrentVerified ? "Re-check on Vercel" : "Claim on Vercel"}
                              </Button>
                            </div>
                          );
                        }
                        return (
                          <p className="text-xs text-slate-500">
                            Use 3–63 lowercase letters, numbers, or single hyphens (e.g. <code>nairobi-traders</code>).
                          </p>
                        );
                      })()}
                    </div>

                    {slugSuggestions.length > 0 ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                        <p className="text-xs font-medium text-amber-900">
                          That name is already taken on Vercel. Click a suggestion or type another:
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {slugSuggestions.map(suggestion => (
                            <button
                              key={suggestion}
                              type="button"
                              onClick={() => handleVercelSlugChange(suggestion)}
                              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:border-sky-500"
                            >
                              {suggestion}
                              {VERCEL_SUFFIX}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Mode 2: Connect Existing Custom Domain */}
                {draft.deployment.domainMode === "custom_domain" ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          Connect a Domain You Already Own
                        </p>
                        <p className="text-xs text-slate-500">
                          Enter your root domain (e.g. <code>mybrand.com</code>, <code>mybrand.co.ke</code>) or subdomain (e.g. <code>trade.mybrand.com</code>).
                        </p>
                      </div>
                      {effectiveHostname &&
                      savedDomainState?.hostname === effectiveHostname ? (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            savedDomainState.isVerified
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {savedDomainState.isVerified
                            ? "Verified + SSL"
                            : "Pending DNS verification"}
                        </span>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <Input
                        value={draft.deployment.customDomain}
                        onChange={event => handleCustomDomainChange(event.target.value, false)}
                        onBlur={event => handleCustomDomainChange(event.target.value, true)}
                        placeholder="mybrand.com or trade.mybrand.com"
                        className="bg-white"
                      />
                      {(() => {
                        const check = validateCustomHostname(draft.deployment.customDomain);
                        if (draft.deployment.customDomain && !check.valid) {
                          return <p className="text-xs text-red-600">{check.error}</p>;
                        }
                        if (check.valid && check.isVercelSubdomain) {
                          return (
                            <p className="text-xs text-amber-700">
                              Tip: <code>.vercel.app</code> domains hosted on another Vercel project must be removed there before attaching here, or choose a fresh name under <strong>Free Vercel Subdomain</strong>.
                            </p>
                          );
                        }
                        return null;
                      })()}
                    </div>

                    {dnsInstructions.length > 0 ? (
                      <div className="rounded-md border border-slate-200 bg-white p-3.5 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-slate-900">
                            DNS records to configure at your domain registrar
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={Boolean(domainActionPending)}
                              onClick={() => handleVerifyOrAttachDomain("attach")}
                            >
                              {domainActionPending === "attach" ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Globe className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Attach on Vercel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={Boolean(domainActionPending)}
                              onClick={() => handleVerifyOrAttachDomain("verify")}
                            >
                              {domainActionPending === "verify" ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Verify DNS
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-2">
                          {dnsInstructions.map(record => (
                            <div
                              key={`${record.type}:${record.name}:${record.value}`}
                              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                            >
                              <div className="space-y-0.5">
                                <div className="flex flex-wrap items-center gap-2 font-mono text-slate-900">
                                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-800">
                                    {record.type}
                                  </span>
                                  <span>Host: {record.name}</span>
                                  <span className="text-slate-400">→</span>
                                  <span className="font-semibold break-all">{record.value}</span>
                                  {!record.required ? (
                                    <span className="rounded bg-slate-200 px-1.5 py-0.5 font-sans text-[10px] text-slate-600">
                                      Optional
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-[11px] text-slate-500">{record.purpose}</p>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => copyToClipboard(record.value, `${record.type} value copied`)}
                              >
                                <Copy className="mr-1 h-3 w-3" />
                                Copy
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Mode 3: Buy a New Domain */}
                {draft.deployment.domainMode === "buy_domain" ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          Purchase a New Domain
                        </p>
                        <p className="text-xs text-slate-500">
                          {effectiveHostname
                            ? `Linked domain: ${effectiveHostname}`
                            : "Search available domains and complete payment via M-Pesa."}
                        </p>
                      </div>
                      <Button type="button" onClick={() => setBuyDialogOpen(true)}>
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        {effectiveHostname ? "Buy a Different Domain" : "Search & Buy Domain"}
                      </Button>
                    </div>

                    {effectiveHostname && dnsInstructions.length > 0 ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2.5 text-xs">
                        <span className="text-slate-700">
                          Domain: <strong className="text-slate-950">{effectiveHostname}</strong>
                          {savedDomainState?.hostname === effectiveHostname &&
                          savedDomainState.isVerified ? (
                            <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                              Verified
                            </span>
                          ) : null}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(domainActionPending)}
                          onClick={() => handleVerifyOrAttachDomain("verify")}
                        >
                          {domainActionPending ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Verify on Vercel
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Domain change / upgrade reminder */}
                {savedDomainState?.hostname &&
                effectiveHostname &&
                savedDomainState.hostname !== effectiveHostname ? (
                  <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                    <span>
                      {platformManaged ? (
                        <>
                          Switching domain from <strong>{savedDomainState.hostname}</strong> to{" "}
                          <strong>{effectiveHostname}</strong>. The platform callback{" "}
                          <code>{CENTRAL_DERIV_CALLBACK_URL}</code> never changes, so no Deriv dashboard edits are needed.
                        </>
                      ) : (
                        <>
                          Switching domain from <strong>{savedDomainState.hostname}</strong> to{" "}
                          <strong>{effectiveHostname}</strong>: remember to update the Redirect URL in your Deriv App settings to{" "}
                          <code>{expectedCallbackUri}</code>.
                        </>
                      )}
                    </span>
                  </div>
                ) : null}

                {platformManaged ? (
                  <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                    <DerivMark className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                    <span>
                      <strong>Platform callback in use.</strong> Traders log in through the central DSites endpoint and are
                      handed straight back to this site. You do not need to register{" "}
                      <code>{expectedCallbackUri || "a per-site callback"}</code> anywhere.
                    </span>
                  </div>
                ) : null}

                {/* Deriv Callback URL + Deployment metadata */}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className={`md:col-span-2 space-y-1.5 ${platformManaged ? "hidden" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900">
                        Exact registered Deriv callback URL
                      </span>
                      {expectedCallbackUri ? (
                        <div className="flex items-center gap-2">
                          {draft.deriv.callbackUri !== expectedCallbackUri ? (
                            <button
                              type="button"
                              onClick={() => updateDeriv("callbackUri", expectedCallbackUri)}
                              className="text-xs font-medium text-sky-600 hover:underline"
                            >
                              Use recommended URL
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(expectedCallbackUri, "Callback URL copied")
                            }
                            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-950"
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {input(draft.deriv.callbackUri, value => updateDeriv("callbackUri", value))}
                    <p className="text-xs text-slate-500">
                      Register{" "}
                      <code className="text-slate-800">
                        {expectedCallbackUri || "https://your-domain.vercel.app/api/deriv-oauth-callback"}
                      </code>{" "}
                      in your{" "}
                      <a
                        href="https://api.deriv.com/dashboard"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-sky-600 hover:underline"
                      >
                        Deriv API Dashboard <ExternalLink className="h-3 w-3" />
                      </a>
                      .
                    </p>
                  </div>

                  <Field label="Production branch">{input(draft.deployment.branch, value => updateDeployment("branch", value))}</Field>
                  <Field label="Output directory">{input(draft.deployment.outputDirectory, value => updateDeployment("outputDirectory", value))}</Field>
                </div>
              </section>
            ) : null}

            {step === 8 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold">Legal pages and navigation</h2>
                  <p className="mt-1 text-sm text-slate-500">Free Bots, privacy and terms stay enabled because they are part of the public site contract.</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Privacy policy URL">{input(draft.legal.privacyUrl, value => setDraft(current => ({ ...current, legal: { ...current.legal, privacyUrl: value } })), "text", "https://yourdomain.com/privacy")}</Field>
                  <Field label="Terms URL">{input(draft.legal.termsUrl, value => setDraft(current => ({ ...current, legal: { ...current.legal, termsUrl: value } })), "text", "https://yourdomain.com/terms")}</Field>
                </div>
                <Field label="Risk disclaimer">
                  <textarea
                    className="min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                    placeholder="Derivatives trading carries substantial risk of loss and may not be suitable for all investors..."
                    value={draft.legal.riskDisclaimer}
                    onChange={event => setDraft(current => ({ ...current, legal: { ...current.legal, riskDisclaimer: event.target.value } }))}
                  />
                </Field>
                <div className="grid gap-3">
                  {draft.navigation.map((item, index) => (
                    <div key={item.key} className="grid grid-cols-[auto_1fr_1fr] items-center gap-3 rounded-md border border-slate-200 bg-slate-50/50 p-3">
                      <Switch checked={item.enabled} disabled={["privacy", "terms", "free_bots"].includes(item.key)} onCheckedChange={enabled => setDraft(current => ({ ...current, navigation: current.navigation.map((row, rowIndex) => rowIndex === index ? { ...row, enabled } : row) }))} />
                      <Input className="border-slate-300 bg-white text-slate-900" value={item.label} onChange={event => setDraft(current => ({ ...current, navigation: current.navigation.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row) }))} />
                      <Input className="border-slate-300 bg-white text-slate-900" value={item.slug} onChange={event => setDraft(current => ({ ...current, navigation: current.navigation.map((row, rowIndex) => rowIndex === index ? { ...row, slug: event.target.value } : row) }))} />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {step === 9 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold">Review before payment</h2>
                  <p className="mt-1 text-sm text-slate-500">Everything is configured first. Payment comes next, then publish commits to GitHub.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-md border border-slate-200 p-4"><span className="text-xs text-slate-500">Plan</span><p className="font-medium">{selectedPlan.price}</p></div>
                  <div className="rounded-md border border-slate-200 p-4"><span className="text-xs text-slate-500">Bots</span><p className="font-medium">{draft.bots.filter(bot => bot.isActive).length} active</p></div>
                  <div className="rounded-md border border-slate-200 p-4"><span className="text-xs text-slate-500">Scopes</span><p className="font-medium">{requiredScopes.length || "None"}</p></div>
                  <div className="rounded-md border border-slate-200 p-4"><span className="text-xs text-slate-500">Domain</span><p className="font-medium break-all">{effectiveHostname || "Not set"}</p></div>
                </div>
                <div className="space-y-2">
                  {displayIssues.length === 0 ? <div className="flex gap-2 text-emerald-700"><Check className="h-4 w-4" />Configuration checks passed. Continue to payment.</div> : null}
                  {displayIssues.map(issue => <div key={`${issue.code}:${issue.field}`} className={`flex gap-2 rounded-md border p-3 text-sm ${issue.severity === "blocking" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}><AlertCircle className="h-4 w-4 shrink-0" />{issue.message}</div>)}
                </div>
              </section>
            ) : null}

            {step === 10 ? (
              <section className="space-y-5">
                <div>
                  <h2 className="text-xl font-semibold">Payment and publish</h2>
                  <p className="mt-1 text-sm text-slate-500">Collect the selected payment details now. After this, publishing creates the GitHub commit and Vercel deploy.</p>
                </div>
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{selectedPlan.title}</p>
                      <p className="text-sm text-slate-600">{selectedPlan.detail}</p>
                    </div>
                    <div className="text-3xl font-semibold text-slate-950">{selectedPlan.price}</div>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Payment email">{input(draft.commercial.paymentEmail, value => updateCommercial("paymentEmail", value), "email", "billing@yourdomain.com")}</Field>
                  <Field label="M-Pesa phone number">{input(draft.commercial.paymentPhone, value => updateCommercial("paymentPhone", value), "tel", "0712 345 678")}</Field>
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-slate-50/60 p-4 text-sm text-slate-800">
                  <input type="checkbox" checked={draft.commercial.acceptedTerms} onChange={event => updateCommercial("acceptedTerms", event.target.checked)} className="mt-1 h-4 w-4 accent-sky-700" />
                  <span>I confirm the customer has accepted the {selectedPlan.title.toLowerCase()} payment terms and the site should be published after payment confirmation.</span>
                </label>
                <div className="space-y-2">
                  {issues.map(issue => <div key={`${issue.code}:${issue.field}`} className={`flex gap-2 rounded-md border p-3 text-sm ${issue.severity === "blocking" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}><AlertCircle className="h-4 w-4 shrink-0" />{issue.message}</div>)}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => saveDraft(10)} variant="outline"><Save className="mr-2 h-4 w-4" />Save payment state</Button>
                  <Button onClick={publish} disabled={saving || issues.some(issue => issue.severity === "blocking")}><CreditCard className="mr-2 h-4 w-4" />Publish after payment</Button>
                  <Button variant="ghost" onClick={() => navigate(`/sites/${siteId}/config`)}>Deployment status</Button>
                </div>
              </section>
            ) : null}
          </main>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="outline"
            className="border-slate-300 bg-white text-slate-900 hover:bg-slate-100 hover:text-slate-950"
            disabled={step === 1}
            onClick={() => setStep(value => Math.max(1, value - 1))}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="border-slate-300 bg-white text-slate-800 hover:bg-slate-100 hover:text-slate-950"
              disabled={saving}
              onClick={() => saveDraft(step).catch(() => {})}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span className="ml-2">Save draft</span>
            </Button>
            {step < steps.length ? (
              <Button
                disabled={saving}
                onClick={async () => {
                  try {
                    await saveDraft(step + 1);
                    setStep(value => Math.min(steps.length, value + 1));
                  } catch {
                    /* toast already shown */
                  }
                }}
              >
                Continue
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <BuyDomainDialog
        open={buyDialogOpen}
        onOpenChange={setBuyDialogOpen}
        targetSiteId={siteId}
        onDomainPurchased={domain => {
          const normalized = normalizeHostnameInput(domain);
          setSavedDomainState({
            hostname: normalized,
            status: "pending",
            isVerified: false,
          });
          setDraft(current => ({
            ...current,
            deployment: {
              ...current.deployment,
              domainMode: "buy_domain",
              customDomain: normalized,
            },
            deriv: {
              ...current.deriv,
              callbackUri: buildDerivCallbackUrl(normalized),
            },
          }));
          toast.success(`${normalized} linked to this site`);
        }}
      />
    </div>
  );
};

export default SiteWizard;
