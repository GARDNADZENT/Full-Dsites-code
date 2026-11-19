import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import ReadinessPanel from "@/components/sites/ReadinessPanel";
import StatusPill from "@/components/sites/StatusPill";
import { getSitePrimaryHostname } from "@/lib/domain-utils";
import { resolveOperationalState } from "@/lib/site-status";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  attachHostnameToSite,
  buildDerivCallbackUrl,
  buildVercelHostname,
  type DomainVerificationRecord,
  extractVercelSlug,
  getRequiredDnsRecords,
  isVercelAppHostname,
  normalizeHostnameInput,
  normalizeVercelSlug,
  validateCustomHostname,
  VERCEL_SUFFIX,
} from "@/lib/domain-utils";
import {
  assignPlatformDerivAppToSite,
  CENTRAL_DERIV_CALLBACK_URL,
  clampMarkupRate,
  DEFAULT_MARKUP_RATE,
  formatMarkupRate,
  getPlatformDerivPoolStatus,
  getSiteCommissions,
  MARKUP_PRESETS,
  ownerShareRate,
  type PlatformDerivPoolStatus,
  type SiteCommissionsResponse,
} from "@/lib/platform-deriv";
import { Slider } from "@/components/ui/slider";
import {
  createDraftSiteConfigSnapshot,
  getDefaultSitePages,
  getSiteDeployments,
  getSiteIntegration,
  getSiteRuntimeConfigAdmin,
  getSiteTools,
  ProvisionDomainError,
  provisionSite,
  provisionSiteDomain,
  publishSiteToGitHub,
  retryDeployment,
  rollbackSite,
  setSiteTool,
  type SiteBotsManifestInput,
  type SiteDerivAppInput,
  type SiteDomainInput,
  type SiteFeaturesInput,
  type SitePageInput,
  type SiteSettingsInput,
  syncSiteBotsManifestFromXmlBots,
  upsertSiteBotsManifest,
  upsertSiteDerivApp,
  upsertSiteDomain,
  upsertSiteFeatures,
  upsertSitePages,
  upsertSiteSettings,
} from "@/lib/site-runtime-config";

const emptySettings: SiteSettingsInput = {
  site_name: "",
  logo_url: "",
  favicon_url: "",
  primary_color: "",
  secondary_color: "",
  accent_color: "",
  header_bg_color: "",
  header_text_color: "",
  dark_mode_default: true,
  custom_css_vars_json: {},
};

const emptyFeatures: SiteFeaturesInput = {
  bot_ideas: true,
  print_popups: false,
  auto_trades: true,
  manual_trading: true,
  scanner: true,
  chart: false,
  best_bots: true,
  copy_trading: false,
  percentage_tool: false,
};

const emptyDerivApp: SiteDerivAppInput = {
  oauth_client_id: "",
  deriv_app_id: "",
  redirect_uri: "",
  use_legacy_oauth_login: false,
  include_legacy_app_id_in_oauth: false,
};

const emptyDomain: SiteDomainInput = {
  hostname: "",
  is_primary: true,
  status: "pending",
  is_verified: false,
  ssl_status: "",
};

const isLikelyUrl = (value: string) => {
  if (!value.trim()) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const featureItems: Array<{ key: keyof SiteFeaturesInput; label: string }> = [
  { key: "bot_ideas", label: "Bot Ideas" },
  { key: "auto_trades", label: "Auto Trades" },
  { key: "manual_trading", label: "Manual Trading" },
  { key: "scanner", label: "Scanner" },
  { key: "chart", label: "Chart" },
  { key: "best_bots", label: "Best Bots" },
  { key: "copy_trading", label: "Copy Trading" },
  { key: "percentage_tool", label: "Percentage Tool" },
  { key: "print_popups", label: "Print Popups" },
];

const SiteRuntimeConfig = () => {
  const { siteId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [settingsForm, setSettingsForm] = useState<SiteSettingsInput>(emptySettings);
  const [featuresForm, setFeaturesForm] = useState<SiteFeaturesInput>(emptyFeatures);
  const [pagesForm, setPagesForm] = useState<SitePageInput[]>(getDefaultSitePages());
  const [derivAppForm, setDerivAppForm] = useState<SiteDerivAppInput>(emptyDerivApp);
  const [domainForm, setDomainForm] = useState<SiteDomainInput>(emptyDomain);
  const [customCssVarsText, setCustomCssVarsText] = useState("{}");
  const [manifestForm, setManifestForm] = useState<SiteBotsManifestInput>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [derivMode, setDerivMode] = useState<"platform_managed" | "custom">("platform_managed");
  const [derivMarkup, setDerivMarkup] = useState<number>(DEFAULT_MARKUP_RATE);
  const [platformFeeRate, setPlatformFeeRate] = useState<number>(17);
  const [poolStatus, setPoolStatus] = useState<PlatformDerivPoolStatus | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["site-runtime-config-admin", siteId],
    queryFn: () => getSiteRuntimeConfigAdmin(siteId),
    enabled: !!siteId,
  });

  const { data: deployments = [] } = useQuery({
    queryKey: ["site-deployments", siteId],
    queryFn: () => getSiteDeployments(siteId),
    enabled: !!siteId,
    refetchInterval: query => query.state.data?.some(item => ["queued", "generating", "committing", "committed", "building"].includes(item.status)) ? 4000 : false,
  });

  const { data: toolsData } = useQuery({
    queryKey: ["site-tools", siteId],
    queryFn: () => getSiteTools(siteId),
    enabled: !!siteId,
  });

  const { data: integration } = useQuery({
    queryKey: ["site-integration", siteId],
    queryFn: () => getSiteIntegration(siteId),
    enabled: !!siteId,
  });

  const commissionsQuery = useQuery({
    queryKey: ["site-commissions", siteId],
    queryFn: () => getSiteCommissions(siteId),
    enabled: !!siteId,
    retry: 0,
  });
  const commissions: SiteCommissionsResponse | undefined = commissionsQuery.data;

  useEffect(() => {
    getPlatformDerivPoolStatus()
      .then(setPoolStatus)
      .catch(() => {
        /* advisory only */
      });
  }, []);

  useEffect(() => {
    if (!data) return;
    const siteRecord = data.site as {
      deriv_mode?: string | null;
      requested_markup_rate?: number | null;
      platform_fee_rate?: number | null;
    };
    setDerivMode(siteRecord.deriv_mode === "custom" ? "custom" : "platform_managed");
    setDerivMarkup(clampMarkupRate(siteRecord.requested_markup_rate ?? DEFAULT_MARKUP_RATE));
    setPlatformFeeRate(Number(siteRecord.platform_fee_rate ?? poolStatus?.defaultPlatformFeeRate ?? 17));
  }, [data, poolStatus?.defaultPlatformFeeRate]);

  const setDerivModeState = (nextMode: "platform_managed" | "custom") => {
    setDerivMode(nextMode);
    setDerivAppForm(prev => ({
      ...prev,
      redirect_uri:
        nextMode === "platform_managed"
          ? CENTRAL_DERIV_CALLBACK_URL
          : prev.redirect_uri || (domainForm.hostname ? buildDerivCallbackUrl(domainForm.hostname) : ""),
    }));
  };

  const poolAssignMutation = useMutation({
    mutationFn: async () => {
      if (domainForm.hostname) {
        const check = validateCustomHostname(domainForm.hostname);
        if (check.valid) await attachHostnameToSite(siteId, check.hostname);
      }
      return assignPlatformDerivAppToSite({
        siteId,
        markupPercentage: derivMarkup,
        scopes: ["trade"],
      });
    },
    onSuccess: async result => {
      setDerivAppForm(prev => ({
        ...prev,
        deriv_app_id: result.appId || "",
        oauth_client_id: result.oauthClientId || "",
        redirect_uri: result.callbackUri || CENTRAL_DERIV_CALLBACK_URL,
      }));
      if (result.status === "queued_for_pool") {
        toast.info("Markup saved — this site binds automatically once the Deriv pool has an app.");
      } else {
        toast.success(`Bound ${formatMarkupRate(result.requestedMarkupRate)} pool app ${result.appId}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["site-commissions", siteId] });
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to bind the platform Deriv app"),
  });

  const derivOwnMutation = useMutation({
    mutationFn: async () => {
      // Generated database types lag the superuser pool migration; cast for the new columns.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const { error: siteError } = await db
        .from("sites")
        .update({
          deriv_mode: derivMode,
          requested_markup_rate: clampMarkupRate(derivMarkup),
        })
        .eq("id", siteId);
      if (siteError) throw siteError;
      const { error: appError } = await db
        .from("site_deriv_apps")
        .update({
          deriv_mode: derivMode,
          markup_percentage: clampMarkupRate(derivMarkup),
        })
        .eq("site_id", siteId);
      if (appError) throw appError;
    },
    onSuccess: async () => {
      toast.success(`Deriv mode saved as ${derivMode === "custom" ? "custom app" : "platform managed"}`);
      await queryClient.invalidateQueries({ queryKey: ["site-commissions", siteId] });
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save Deriv mode"),
  });

  useEffect(() => {
    if (!data) return;

    setSettingsForm({
      site_name: data.settings?.site_name || data.site?.name || "",
      logo_url: data.settings?.logo_url || "",
      favicon_url: data.settings?.favicon_url || "",
      primary_color: data.settings?.primary_color || "",
      secondary_color: data.settings?.secondary_color || "",
      accent_color: data.settings?.accent_color || "",
      header_bg_color: data.settings?.header_bg_color || "",
      header_text_color: data.settings?.header_text_color || "",
      dark_mode_default: data.settings?.dark_mode_default ?? true,
      custom_css_vars_json: data.settings?.custom_css_vars_json || {},
      brand_name: data.settings?.brand_name || data.settings?.site_name || data.site?.name || "",
    });

    setCustomCssVarsText(JSON.stringify(data.settings?.custom_css_vars_json || {}, null, 2));

    setFeaturesForm({
      bot_ideas: data.features?.bot_ideas ?? true,
      print_popups: data.features?.print_popups ?? false,
      auto_trades: data.features?.auto_trades ?? true,
      manual_trading: data.features?.manual_trading ?? true,
      scanner: data.features?.scanner ?? true,
      chart: data.features?.chart ?? false,
      best_bots: data.features?.best_bots ?? true,
      copy_trading: data.features?.copy_trading ?? false,
      percentage_tool: data.features?.percentage_tool ?? false,
    });

    setPagesForm(
      data.pages.length > 0
        ? data.pages.map(page => ({
            id: page.id,
            page_key: page.page_key,
            label: page.label || "",
            enabled: page.enabled,
            sort_order: page.sort_order,
          }))
        : getDefaultSitePages(),
    );

    const loadedMode = ((data.site as { deriv_mode?: string | null }).deriv_mode === "custom")
      ? "custom"
      : "platform_managed";
    setDerivAppForm({
      oauth_client_id: data.derivApp?.oauth_client_id || "",
      deriv_app_id: data.derivApp?.deriv_app_id || "",
      redirect_uri:
        data.derivApp?.redirect_uri ||
        (loadedMode === "platform_managed" ? CENTRAL_DERIV_CALLBACK_URL : ""),
      use_legacy_oauth_login: data.derivApp?.use_legacy_oauth_login ?? false,
      include_legacy_app_id_in_oauth: data.derivApp?.include_legacy_app_id_in_oauth ?? false,
    });

    setDomainForm({
      id: data.domain?.id,
      hostname: data.domain?.hostname || "",
      is_primary: data.domain?.is_primary ?? true,
      status: (data.domain?.status as SiteDomainInput["status"]) || "pending",
      is_verified: data.domain?.is_verified ?? false,
      ssl_status: data.domain?.ssl_status || "",
    });

    setManifestForm(
      data.botsManifest.map(bot => ({
        id: bot.id,
        bot_id: bot.bot_id || "",
        display_name: bot.display_name,
        description: bot.description || "",
        file_path: bot.file_path || "",
        thumbnail_url: bot.thumbnail_url || "",
        category: bot.category || "",
        display_order: bot.display_order,
        is_active: bot.is_active,
      })),
    );
  }, [data]);

  const refreshConfig = async () => {
    await queryClient.invalidateQueries({ queryKey: ["site-runtime-config-admin", siteId] });
  };

  const settingsMutation = useMutation({
    mutationFn: async () => {
      let parsedCssVars: Record<string, string> = {};
      if (customCssVarsText.trim()) {
        const parsed = JSON.parse(customCssVarsText);
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
          throw new Error("Custom CSS vars must be a JSON object");
        }
        parsedCssVars = parsed as Record<string, string>;
      }

      return upsertSiteSettings(siteId, {
        ...settingsForm,
        custom_css_vars_json: parsedCssVars,
      });
    },
    onSuccess: async () => {
      toast.success("Branding settings saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save settings"),
  });

  const featuresMutation = useMutation({
    mutationFn: () => upsertSiteFeatures(siteId, featuresForm),
    onSuccess: async () => {
      toast.success("Feature flags saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save features"),
  });

  const pagesMutation = useMutation({
    mutationFn: () => upsertSitePages(siteId, pagesForm),
    onSuccess: async () => {
      toast.success("Page settings saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save pages"),
  });

  const derivMutation = useMutation({
    mutationFn: async () => {
      if (!isLikelyUrl(derivAppForm.redirect_uri || "")) {
        throw new Error("Redirect URI must be a valid URL");
      }
      return upsertSiteDerivApp(siteId, derivAppForm);
    },
    onSuccess: async () => {
      toast.success("Public Deriv app settings saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save Deriv app settings"),
  });

  const domainMutation = useMutation({
    mutationFn: async () => {
      if (!domainForm.hostname.trim()) {
        throw new Error("Hostname is required");
      }
      return upsertSiteDomain(siteId, {
        ...domainForm,
        hostname: domainForm.hostname,
      });
    },
    onSuccess: async result => {
      setDomainForm(prev => ({ ...prev, id: result.id }));
      toast.success("Domain settings saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save domain"),
  });

  const draftMutation = useMutation({
    mutationFn: () => createDraftSiteConfigSnapshot(siteId),
    onSuccess: async version => {
      toast.success(`Draft snapshot v${version.version_number} created`);
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to create draft snapshot"),
  });

  const publishMutation = useMutation({
    mutationFn: () => publishSiteToGitHub(siteId),
    onSuccess: async result => {
      toast.success(`Website update v${result.version} committed to GitHub`);
      await Promise.all([
        refreshConfig(),
        queryClient.invalidateQueries({ queryKey: ["site-deployments", siteId] }),
      ]);
    },
    onError: async err => {
      toast.error(err instanceof Error ? err.message : "Website update failed");
      await queryClient.invalidateQueries({ queryKey: ["site-deployments", siteId] });
    },
  });

  const toolMutation = useMutation({
    mutationFn: ({ toolId, enabled }: { toolId: string; enabled: boolean }) => {
      const tool = toolsData?.catalogue.find(item => item.id === toolId);
      if (!tool) throw new Error("Tool was not found");
      const installed = toolsData?.installed.find(item => item.tool_id === toolId);
      return setSiteTool(siteId, tool, enabled, installed?.display_order ?? (toolsData?.installed.length || 0));
    },
    onSuccess: async () => {
      toast.success("Tool selection saved");
      await queryClient.invalidateQueries({ queryKey: ["site-tools", siteId] });
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save tool"),
  });

  const [domainVerification, setDomainVerification] = useState<DomainVerificationRecord[]>([]);
  const [domainSuggestions, setDomainSuggestions] = useState<string[]>([]);

  const verifyDomainMutation = useMutation({
    mutationFn: async (action: "attach" | "verify") => {
      const normalized = normalizeHostnameInput(domainForm.hostname);
      if (!normalized) throw new Error("Enter a domain or free .vercel.app subdomain first");
      const saved = await upsertSiteDomain(siteId, {
        ...domainForm,
        hostname: normalized,
      });
      setDomainForm(prev => ({
        ...prev,
        id: saved.id,
        hostname: saved.hostname,
        status: saved.status as SiteDomainInput["status"],
        is_verified: saved.is_verified,
        ssl_status: saved.ssl_status,
      }));
      return provisionSiteDomain(siteId, { action, hostname: normalized });
    },
    onSuccess: async result => {
      setDomainSuggestions([]);
      setDomainVerification(result.domainVerification || []);
      if (result.domain?.isVerified) {
        toast.success(
          result.domain.isVercelSubdomain
            ? `https://${result.domain.hostname} is live on Vercel!`
            : `${result.domain.hostname} is verified and SSL is active!`,
        );
      } else {
        toast.info(
          "Domain attached on Vercel. Configure the DNS records shown below, wait a few minutes, and click Verify DNS.",
        );
      }
      await Promise.all([
        refreshConfig(),
        queryClient.invalidateQueries({ queryKey: ["site-integration", siteId] }),
      ]);
    },
    onError: err => {
      if (err instanceof ProvisionDomainError && err.suggestions.length) {
        setDomainSuggestions(err.suggestions);
      }
      toast.error(err instanceof Error ? err.message : "Domain verification failed");
    },
  });

  const provisionMutation = useMutation({
    mutationFn: () => provisionSite(siteId),
    onSuccess: async result => {
      toast.success(`Vercel project ${result.netlify_site_name || "connected"}`);
      await Promise.all([
        refreshConfig(),
        queryClient.invalidateQueries({ queryKey: ["site-integration", siteId] }),
      ]);
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Provisioning failed"),
  });

  const retryMutation = useMutation({
    mutationFn: retryDeployment,
    onSuccess: async () => {
      toast.success("Website update retried");
      await Promise.all([refreshConfig(), queryClient.invalidateQueries({ queryKey: ["site-deployments", siteId] })]);
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Retry failed"),
  });

  const rollbackMutation = useMutation({
    mutationFn: (publishVersionId: string) => rollbackSite(siteId, publishVersionId),
    onSuccess: async () => {
      toast.success("Previous website version restored and committed");
      await Promise.all([refreshConfig(), queryClient.invalidateQueries({ queryKey: ["site-deployments", siteId] })]);
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Rollback failed"),
  });

  const syncManifestMutation = useMutation({
    mutationFn: () => syncSiteBotsManifestFromXmlBots(siteId),
    onSuccess: async manifestRows => {
      setManifestForm(
        manifestRows.map(bot => ({
          id: bot.id,
          bot_id: bot.bot_id || "",
          display_name: bot.display_name,
          description: bot.description || "",
          file_path: bot.file_path || "",
          thumbnail_url: bot.thumbnail_url || "",
          category: bot.category || "",
          display_order: bot.display_order,
          is_active: bot.is_active,
        })),
      );
      toast.success("Bot manifest synced from XML bots");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to sync bot manifest"),
  });

  const saveManifestMutation = useMutation({
    mutationFn: () => upsertSiteBotsManifest(siteId, manifestForm),
    onSuccess: async manifestRows => {
      setManifestForm(
        manifestRows.map(bot => ({
          id: bot.id,
          bot_id: bot.bot_id || "",
          display_name: bot.display_name,
          description: bot.description || "",
          file_path: bot.file_path || "",
          thumbnail_url: bot.thumbnail_url || "",
          category: bot.category || "",
          display_order: bot.display_order,
          is_active: bot.is_active,
        })),
      );
      toast.success("Bot manifest saved");
      await refreshConfig();
    },
    onError: err => toast.error(err instanceof Error ? err.message : "Failed to save bot manifest"),
  });

  const lastPublished = useMemo(
    () => data?.publishVersions.find(version => version.status === "published") || null,
    [data],
  );
  const latestSnapshot = data?.publishVersions[0] || null;
  const testUrl = domainForm.hostname
    ? `/functions/v1/public-site-config?hostname=${encodeURIComponent(domainForm.hostname)}`
    : null;
  const hasPublicDerivApp = Boolean(derivAppForm.deriv_app_id?.trim() || derivAppForm.oauth_client_id?.trim());
  const derivNeedsAttention = derivMode === "custom" && !hasPublicDerivApp;
  const domainIsResolvable = domainForm.status === "active" || domainForm.status === "verified";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const siteHostname = data?.site ? getSitePrimaryHostname(data as any) : null;
  const operationalState = resolveOperationalState({
    siteStatus: data?.site?.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    integration: (integration as any) ?? null,
    hostname: siteHostname,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p className="text-muted-foreground">Loading site runtime config...</p>
        </div>
      </div>
    );
  }

  if (error || !data?.site) {
    return (
      <div className="flex-1 p-6">
        <Button variant="outline" onClick={() => navigate(-1)} className="mb-4">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        <Card className="bg-panel-bg border-white/10">
          <CardHeader>
            <CardTitle className="text-foreground text-xl">Site config unavailable</CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "We couldn't load this site's runtime config."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button variant="ghost" onClick={() => navigate(-1)} className="mb-2 -ml-3">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{data.site.name}</h1>
            <StatusPill state={operationalState} />
          </div>
          <p className="text-sm text-muted-foreground">
            {siteHostname ? `${siteHostname} · ` : ""}
            Manage branding, features, navigation, public Deriv settings, and publish snapshots.
          </p>
        </div>

        <Card className="bg-white/5 border-white/10 shadow-none">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Publish status</p>
            {latestSnapshot ? (
              <>
                <p className="text-sm text-foreground font-medium">
                  Latest snapshot: v{latestSnapshot.version_number} ({latestSnapshot.status})
                </p>
                <p className="text-xs text-muted-foreground">
                  Created {new Date(latestSnapshot.created_at).toLocaleString()}
                </p>
                {lastPublished?.published_at ? (
                  <p className="text-xs text-muted-foreground">
                    Last published {new Date(lastPublished.published_at).toLocaleString()}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No snapshot yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      <ReadinessPanel
        input={{
          siteId,
          hostname: siteHostname,
          domainVerified: Boolean(data?.domain?.is_verified),
          configurationStatus: data?.site?.configuration_status ?? null,
          publishedAt: lastPublished?.published_at ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          integration: (integration as any) ?? null,
          hasDerivApp: hasPublicDerivApp || Boolean(poolStatus?.defaultAppId),
        }}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {!domainForm.hostname || !domainIsResolvable ? (
          <Card className="bg-amber-500/10 border-amber-500/20 shadow-none">
            <CardContent className="p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Public config will not resolve yet</p>
                <p className="text-xs text-muted-foreground">
                  Add a hostname and mark it verified or active before relying on the public runtime config API.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {derivNeedsAttention ? (
          <Card className="bg-amber-500/10 border-amber-500/20 shadow-none">
            <CardContent className="p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Public Deriv app settings missing</p>
                <p className="text-xs text-muted-foreground">
                  This site uses a custom Deriv app, so the App ID and OAuth client ID must be filled in before traders can log in.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {derivMode === "platform_managed" && !poolStatus?.poolReady ? (
          <Card className="bg-blue-500/10 border-blue-500/20 shadow-none">
            <CardContent className="p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-blue-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Waiting for the Deriv App pool</p>
                <p className="text-xs text-muted-foreground">
                  This site is stored as platform managed with a {formatMarkupRate(derivMarkup)} markup and binds automatically once a superuser pool app exists.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {!lastPublished ? (
          <Card className="bg-blue-500/10 border-blue-500/20 shadow-none">
            <CardContent className="p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-blue-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">No published snapshot yet</p>
                <p className="text-xs text-muted-foreground">
                  The public function will currently fall back to live normalized rows until a published snapshot exists.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {testUrl ? (
        <Card className="bg-white/5 border-white/10 shadow-none">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Public config test path</p>
            <p className="text-sm text-foreground break-all">{testUrl}</p>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="branding" className="space-y-4">
        <TabsList className="bg-white/5 border border-white/10 h-auto flex-wrap justify-start">
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="pages">Pages</TabsTrigger>
          <TabsTrigger value="domain">Domain</TabsTrigger>
          <TabsTrigger value="deriv">Deriv App</TabsTrigger>
          <TabsTrigger value="bots">Bots</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="publish">Publish</TabsTrigger>
        </TabsList>

        <TabsContent value="branding">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Branding & Theme
              </CardTitle>
              <CardDescription>These values feed the public runtime branding payload.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Site Name">
                  <Input value={settingsForm.site_name || ""} onChange={e => setSettingsForm(prev => ({ ...prev, site_name: e.target.value }))} />
                </Field>
                <Field label="Logo URL">
                  <Input value={settingsForm.logo_url || ""} onChange={e => setSettingsForm(prev => ({ ...prev, logo_url: e.target.value }))} />
                </Field>
                <Field label="Favicon URL">
                  <Input value={settingsForm.favicon_url || ""} onChange={e => setSettingsForm(prev => ({ ...prev, favicon_url: e.target.value }))} />
                </Field>
                <Field label="Primary Color">
                  <Input value={settingsForm.primary_color || ""} onChange={e => setSettingsForm(prev => ({ ...prev, primary_color: e.target.value }))} placeholder="#00c2ff" />
                </Field>
                <Field label="Secondary Color">
                  <Input value={settingsForm.secondary_color || ""} onChange={e => setSettingsForm(prev => ({ ...prev, secondary_color: e.target.value }))} />
                </Field>
                <Field label="Accent Color">
                  <Input value={settingsForm.accent_color || ""} onChange={e => setSettingsForm(prev => ({ ...prev, accent_color: e.target.value }))} />
                </Field>
                <Field label="Header Background Color">
                  <Input value={settingsForm.header_bg_color || ""} onChange={e => setSettingsForm(prev => ({ ...prev, header_bg_color: e.target.value }))} />
                </Field>
                <Field label="Header Text Color">
                  <Input value={settingsForm.header_text_color || ""} onChange={e => setSettingsForm(prev => ({ ...prev, header_text_color: e.target.value }))} />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Dark mode default</p>
                  <p className="text-xs text-muted-foreground">Controls the default site appearance for future runtime consumers.</p>
                </div>
                <Switch checked={settingsForm.dark_mode_default ?? true} onCheckedChange={checked => setSettingsForm(prev => ({ ...prev, dark_mode_default: checked }))} />
              </div>

              <Field label="Custom CSS Vars JSON">
                <Textarea value={customCssVarsText} onChange={e => setCustomCssVarsText(e.target.value)} className="min-h-[160px]" />
              </Field>

              <div className="flex justify-end">
                <Button onClick={() => settingsMutation.mutate()} disabled={settingsMutation.isPending}>
                  <Save className="w-4 h-4 mr-2" />
                  {settingsMutation.isPending ? "Saving..." : "Save Branding"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="features">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-primary" />
                Feature Flags
              </CardTitle>
              <CardDescription>These booleans map into the public runtime feature payload.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {featureItems.map(item => (
                <div key={item.key} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.key}</p>
                  </div>
                  <Switch
                    checked={featuresForm[item.key]}
                    onCheckedChange={checked => setFeaturesForm(prev => ({ ...prev, [item.key]: checked }))}
                  />
                </div>
              ))}

              <div className="flex justify-end">
                <Button onClick={() => featuresMutation.mutate()} disabled={featuresMutation.isPending}>
                  <Save className="w-4 h-4 mr-2" />
                  {featuresMutation.isPending ? "Saving..." : "Save Features"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pages">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg">Page Metadata</CardTitle>
              <CardDescription>Controls labels, order, and visibility for runtime navigation.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {pagesForm.map((page, index) => (
                <div key={page.page_key} className="grid gap-3 rounded-lg border border-white/10 bg-white/5 p-4 md:grid-cols-[1.2fr_1.5fr_120px_auto] md:items-end">
                  <Field label="Page Key">
                    <Input value={page.page_key} readOnly className="opacity-80" />
                  </Field>
                  <Field label="Label">
                    <Input
                      value={page.label || ""}
                      onChange={e => {
                        const next = [...pagesForm];
                        next[index] = { ...next[index], label: e.target.value };
                        setPagesForm(next);
                      }}
                    />
                  </Field>
                  <Field label="Sort Order">
                    <Input
                      type="number"
                      value={page.sort_order}
                      onChange={e => {
                        const next = [...pagesForm];
                        next[index] = { ...next[index], sort_order: Number(e.target.value) || 0 };
                        setPagesForm(next);
                      }}
                    />
                  </Field>
                  <div className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2">
                    <span className="text-sm text-foreground">Enabled</span>
                    <Switch
                      checked={page.enabled}
                      onCheckedChange={checked => {
                        const next = [...pagesForm];
                        next[index] = { ...next[index], enabled: checked };
                        setPagesForm(next);
                      }}
                    />
                  </div>
                </div>
              ))}

              <div className="flex justify-between gap-3">
                <Button variant="outline" onClick={() => setPagesForm(getDefaultSitePages())}>
                  Reset To Defaults
                </Button>
                <Button onClick={() => pagesMutation.mutate()} disabled={pagesMutation.isPending}>
                  <Save className="w-4 h-4 mr-2" />
                  {pagesMutation.isPending ? "Saving..." : "Save Pages"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="domain">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <Globe className="w-5 h-5 text-primary" />
                Primary Domain
              </CardTitle>
              <CardDescription>
                Use a free <code className="text-foreground">.vercel.app</code> subdomain (zero DNS setup) or connect a custom domain you own. You can upgrade from a free Vercel URL to a custom domain anytime.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Quick mode switch */}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={isVercelAppHostname(domainForm.hostname) || !domainForm.hostname ? "default" : "outline"}
                  onClick={() => {
                    setDomainSuggestions([]);
                    const slug =
                      extractVercelSlug(domainForm.hostname) ||
                      normalizeVercelSlug(settingsForm.brand_name || data.site?.name || "my-site");
                    setDomainForm(prev => ({
                      ...prev,
                      hostname: buildVercelHostname(slug),
                    }));
                  }}
                >
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  Free Vercel Subdomain
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={domainForm.hostname && !isVercelAppHostname(domainForm.hostname) ? "default" : "outline"}
                  onClick={() => {
                    setDomainSuggestions([]);
                    if (isVercelAppHostname(domainForm.hostname)) {
                      setDomainForm(prev => ({ ...prev, hostname: "" }));
                    }
                  }}
                >
                  <Link2 className="w-3.5 h-3.5 mr-1.5" />
                  Custom Domain I Own
                </Button>
              </div>

              <Field
                label="Hostname"
                description={
                  isVercelAppHostname(domainForm.hostname)
                    ? "Free single-level Vercel alias (e.g. my-brand.vercel.app) attached directly to the shared Vercel runtime."
                    : "Enter a root domain (e.g. mybrand.com, mybrand.co.ke) or subdomain (e.g. trade.mybrand.com)."
                }
              >
                <Input
                  value={domainForm.hostname}
                  onChange={e =>
                    setDomainForm(prev => ({
                      ...prev,
                      hostname: e.target.value.toLowerCase(),
                    }))
                  }
                  onBlur={e =>
                    setDomainForm(prev => ({
                      ...prev,
                      hostname: normalizeHostnameInput(e.target.value),
                    }))
                  }
                  placeholder="my-brand.vercel.app or mybrand.com"
                />
              </Field>

              {domainSuggestions.length > 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-xs text-amber-300">
                    That Vercel subdomain is taken. Try one of these alternatives:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {domainSuggestions.map(item => {
                      const candidate = `${item}${VERCEL_SUFFIX}`;
                      return (
                        <button
                          key={candidate}
                          type="button"
                          onClick={() => {
                            setDomainForm(prev => ({ ...prev, hostname: candidate }));
                            setDomainSuggestions([]);
                          }}
                          className="rounded-md border border-amber-400/30 bg-background/60 px-2.5 py-1 text-xs text-foreground hover:border-primary"
                        >
                          {candidate}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-muted-foreground">Verification status</p>
                  <p className="mt-1 text-sm font-medium text-foreground flex items-center gap-1.5">
                    {domainForm.is_verified && domainForm.status === "active" ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-400" />
                        Active & verified
                      </>
                    ) : (
                      <span className="text-amber-400 capitalize">
                        {domainForm.status || "pending"} (verify on Vercel below)
                      </span>
                    )}
                  </p>
                </div>

                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-muted-foreground">SSL certificate</p>
                  <p className="mt-1 text-sm font-medium text-foreground capitalize">
                    {(domainForm.ssl_status || "pending").replace(/_/g, " ")}
                  </p>
                </div>
              </div>

              {/* DNS instructions for external custom domains */}
              {domainForm.hostname && !isVercelAppHostname(domainForm.hostname) ? (
                <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Required DNS records
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Add these records in your domain registrar's DNS settings, then click Verify DNS.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {getRequiredDnsRecords(domainForm.hostname, domainVerification).map(record => (
                      <div
                        key={`${record.type}:${record.name}:${record.value}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/10 bg-background/60 px-3 py-2 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2 font-mono text-foreground">
                            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                              {record.type}
                            </span>
                            <span>Host: {record.name}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-emerald-400 break-all">{record.value}</span>
                            {!record.required ? (
                              <span className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">
                                Optional
                              </span>
                            ) : null}
                          </div>
                          <p className="text-[11px] text-muted-foreground">{record.purpose}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            navigator.clipboard
                              .writeText(record.value)
                              .then(() => toast.success(`${record.type} value copied`))
                              .catch(() => toast.error("Unable to copy"));
                          }}
                        >
                          <Copy className="w-3.5 h-3.5 mr-1" />
                          Copy
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {domainForm.hostname ? (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Deriv App redirect URL:{" "}
                    <code className="text-foreground">
                      {buildDerivCallbackUrl(domainForm.hostname)}
                    </code>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const cb = buildDerivCallbackUrl(domainForm.hostname);
                      setDerivAppForm(prev => ({ ...prev, redirect_uri: cb }));
                      navigator.clipboard.writeText(cb).catch(() => {});
                      toast.success("Callback URL copied & filled in Deriv tab");
                    }}
                  >
                    <Copy className="w-3.5 h-3.5 mr-1" />
                    Copy & sync
                  </Button>
                </div>
              ) : null}

              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Primary domain</p>
                  <p className="text-xs text-muted-foreground">Use this when the hostname should resolve as the main tenant domain.</p>
                </div>
                <Switch checked={domainForm.is_primary ?? true} onCheckedChange={checked => setDomainForm(prev => ({ ...prev, is_primary: checked }))} />
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => domainMutation.mutate()}
                  disabled={domainMutation.isPending || verifyDomainMutation.isPending}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {domainMutation.isPending ? "Saving..." : "Save Hostname"}
                </Button>
                <Button
                  onClick={() =>
                    verifyDomainMutation.mutate(
                      isVercelAppHostname(domainForm.hostname) ? "attach" : "verify",
                    )
                  }
                  disabled={
                    !domainForm.hostname.trim() ||
                    domainMutation.isPending ||
                    verifyDomainMutation.isPending
                  }
                >
                  {verifyDomainMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  {isVercelAppHostname(domainForm.hostname)
                    ? "Attach & Activate on Vercel"
                    : "Attach & Verify DNS"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deriv">
          <div className="space-y-4">
            <Card className="bg-panel-bg border-white/10">
              <CardHeader>
                <CardTitle className="text-foreground text-lg">Deriv App & Markup</CardTitle>
                <CardDescription>
                  Run on the superuser v2 DevHub App pool (recommended) or bring your own Deriv app. Deriv allows a 0%–3% markup.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-xs font-medium">
                    <button
                      type="button"
                      onClick={() => setDerivModeState("platform_managed")}
                      className={`rounded-md px-3 py-1.5 transition ${derivMode === "platform_managed" ? "bg-primary/20 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Platform managed
                    </button>
                    <button
                      type="button"
                      onClick={() => setDerivModeState("custom")}
                      className={`rounded-md px-3 py-1.5 transition ${derivMode === "custom" ? "bg-primary/20 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Custom Deriv app
                    </button>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${poolStatus?.poolReady ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>
                    {poolStatus?.poolReady
                      ? `${poolStatus.activeAppCount} pool app${poolStatus.activeAppCount === 1 ? "" : "s"} ready`
                      : "Pool not populated yet"}
                  </span>
                </div>

                {derivMode === "platform_managed" ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                        <p className="text-xs text-muted-foreground">Assigned app ID</p>
                        <p className="text-sm font-semibold text-foreground break-all">{derivAppForm.deriv_app_id || "Queued for pool"}</p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                        <p className="text-xs text-muted-foreground">Applied markup</p>
                        <p className="text-sm font-semibold text-foreground">{formatMarkupRate(commissions?.site.appliedMarkupRate ?? derivMarkup)}</p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                        <p className="text-xs text-muted-foreground">Owner / platform split</p>
                        <p className="text-sm font-semibold text-foreground">
                          {ownerShareRate(platformFeeRate)}% / {platformFeeRate}%
                        </p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Requested commission markup</span>
                        <span className="font-semibold text-foreground">{formatMarkupRate(derivMarkup)}</span>
                      </div>
                      <Slider value={[derivMarkup]} min={0} max={3} step={0.5} onValueChange={values => setDerivMarkup(clampMarkupRate(values[0] ?? DEFAULT_MARKUP_RATE))} />
                      <div className="flex flex-wrap gap-1.5">
                        {MARKUP_PRESETS.map(preset => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setDerivMarkup(preset)}
                            className={`rounded-full border px-2.5 py-1 text-xs transition ${Math.abs(derivMarkup - preset) < 0.001 ? "border-primary/60 bg-primary/20 text-foreground" : "border-white/10 bg-white/5 text-muted-foreground hover:text-foreground"}`}
                          >
                            {formatMarkupRate(preset)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-muted-foreground space-y-1">
                      <p>Central callback: <code className="text-foreground break-all">{CENTRAL_DERIV_CALLBACK_URL}</code></p>
                      <p>Traders are attributed to this site even on a custom domain, via a single-use 60 second handoff.</p>
                    </div>

                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="outline" onClick={() => poolAssignMutation.mutate()} disabled={poolAssignMutation.isPending}>
                        {poolAssignMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                        {poolAssignMutation.isPending ? "Binding..." : "Save markup & bind pool app"}
                      </Button>
                      <Button onClick={() => derivOwnMutation.mutate()} disabled={derivOwnMutation.isPending}>
                        <Save className="w-4 h-4 mr-2" />
                        {derivOwnMutation.isPending ? "Saving..." : "Save Deriv settings"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="OAuth Client ID">
                        <Input value={derivAppForm.oauth_client_id || ""} onChange={e => setDerivAppForm(prev => ({ ...prev, oauth_client_id: e.target.value }))} />
                      </Field>
                      <Field label="Deriv App ID">
                        <Input value={derivAppForm.deriv_app_id || ""} onChange={e => setDerivAppForm(prev => ({ ...prev, deriv_app_id: e.target.value }))} />
                      </Field>
                    </div>

                    <Field label="Redirect URI">
                      <Input value={derivAppForm.redirect_uri || ""} onChange={e => setDerivAppForm(prev => ({ ...prev, redirect_uri: e.target.value }))} placeholder="https://example.com/api/deriv-oauth-callback" />
                    </Field>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4">
                        <div>
                          <p className="text-sm font-medium text-foreground">Use legacy OAuth login</p>
                          <p className="text-xs text-muted-foreground">Keeps compatibility with older login expectations.</p>
                        </div>
                        <Switch checked={derivAppForm.use_legacy_oauth_login ?? false} onCheckedChange={checked => setDerivAppForm(prev => ({ ...prev, use_legacy_oauth_login: checked }))} />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4">
                        <div>
                          <p className="text-sm font-medium text-foreground">Include legacy app ID in OAuth</p>
                          <p className="text-xs text-muted-foreground">Only use this if an existing frontend requires it.</p>
                        </div>
                        <Switch checked={derivAppForm.include_legacy_app_id_in_oauth ?? false} onCheckedChange={checked => setDerivAppForm(prev => ({ ...prev, include_legacy_app_id_in_oauth: checked }))} />
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button onClick={() => derivMutation.mutate()} disabled={derivMutation.isPending}>
                        <Save className="w-4 h-4 mr-2" />
                        {derivMutation.isPending ? "Saving..." : "Save Deriv Settings"}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-panel-bg border-white/10">
              <CardHeader>
                <CardTitle className="text-foreground text-lg flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  Commission split
                </CardTitle>
                <CardDescription>Gross Deriv markup, the platform fee withheld, and the site owner's net share.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {commissionsQuery.isLoading ? (
                  <div className="h-24 rounded-xl bg-white/5 animate-pulse" />
                ) : commissionsQuery.error ? (
                  <p className="text-sm text-amber-400">{commissionsQuery.error instanceof Error ? commissionsQuery.error.message : "Commission summary unavailable"}</p>
                ) : !commissions?.currencies?.length ? (
                  <p className="text-sm text-muted-foreground">
                    No attributed trades yet. Figures appear after the superuser runs a Deriv commission sync.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-3 md:grid-cols-2">
                      {commissions.currencies.map(row => (
                        <div key={row.currency} className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
                          <p className="text-xs text-muted-foreground">{row.currency} · {row.tradeCount} trades</p>
                          <p className="text-lg font-semibold text-foreground">Gross {row.grossMarkup.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                          <p className="text-xs text-muted-foreground">Platform fee {row.platformFee.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                          <p className="text-xs text-emerald-400">Owner net {row.ownerNet.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                          <p className="text-xs text-muted-foreground">Pending {row.pendingAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} · Paid {row.paidAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Attributed traders: {commissions.traders.real} real · {commissions.traders.demo} demo
                    </p>
                    {commissions.recentTrades.length > 0 ? (
                      <div className="space-y-2">
                        {commissions.recentTrades.slice(0, 8).map(trade => (
                          <div key={trade.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs">
                            <span className="text-muted-foreground">{new Date(trade.tradedAt).toLocaleString()} · {trade.trader}</span>
                            <span className="text-foreground">
                              {trade.currency} {trade.grossMarkup.toFixed(4)} gross · owner {trade.ownerNet.toFixed(4)} · {trade.payoutStatus}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="bots">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <Bot className="w-5 h-5 text-primary" />
                Bot Manifest
              </CardTitle>
              <CardDescription>
                `xml_bots` remains the main upload source. This page only syncs and edits frontend-safe manifest metadata.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={() => syncManifestMutation.mutate()} disabled={syncManifestMutation.isPending}>
                  {syncManifestMutation.isPending ? "Syncing..." : "Sync Bot Manifest From XML Bots"}
                </Button>
                <Button onClick={() => saveManifestMutation.mutate()} disabled={saveManifestMutation.isPending || manifestForm.length === 0}>
                  <Save className="w-4 h-4 mr-2" />
                  {saveManifestMutation.isPending ? "Saving..." : "Save Bot Manifest"}
                </Button>
              </div>

              <div>
                <h3 className="text-sm font-medium text-foreground mb-3">XML Bots Source</h3>
                {data.xmlBots.length > 0 ? (
                  <div className="space-y-2">
                    {data.xmlBots.map(bot => (
                      <div key={bot.id} className="rounded-lg border border-white/10 bg-white/5 p-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-foreground">{bot.file_name}</p>
                          <p className="text-xs text-muted-foreground">{bot.file_path}</p>
                        </div>
                        <span className="text-xs text-muted-foreground">Order {bot.display_order}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No XML bots uploaded for this site yet.</p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium text-foreground mb-3">Public Manifest Rows</h3>
                {manifestForm.length > 0 ? (
                  <div className="space-y-3">
                    {manifestForm.map((bot, index) => (
                      <div key={bot.id || `${bot.file_path}-${index}`} className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-3">
                        <div className="grid gap-3 md:grid-cols-4">
                          <Field label="Display Name">
                            <Input
                              value={bot.display_name}
                              onChange={e => {
                                const next = [...manifestForm];
                                next[index] = { ...next[index], display_name: e.target.value };
                                setManifestForm(next);
                              }}
                            />
                          </Field>
                          <Field label="Category">
                            <Input
                              value={bot.category || ""}
                              onChange={e => {
                                const next = [...manifestForm];
                                next[index] = { ...next[index], category: e.target.value };
                                setManifestForm(next);
                              }}
                            />
                          </Field>
                          <Field label="Display Order">
                            <Input
                              type="number"
                              value={bot.display_order}
                              onChange={e => {
                                const next = [...manifestForm];
                                next[index] = { ...next[index], display_order: Number(e.target.value) || 0 };
                                setManifestForm(next);
                              }}
                            />
                          </Field>
                          <div className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2 md:self-end">
                            <span className="text-sm text-foreground">Active</span>
                            <Switch
                              checked={bot.is_active ?? true}
                              onCheckedChange={checked => {
                                const next = [...manifestForm];
                                next[index] = { ...next[index], is_active: checked };
                                setManifestForm(next);
                              }}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{bot.file_path || "No file path"}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No public manifest rows yet. Sync from XML bots to create them.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-primary" />
                Tool Catalogue
              </CardTitle>
              <CardDescription>
                Install or remove tools for this website. Changes remain private until Update Website is clicked.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {toolsData?.catalogue.length ? toolsData.catalogue.map(tool => {
                const installed = toolsData.installed.find(item => item.tool_id === tool.id);
                const enabled = installed?.enabled ?? false;
                return (
                  <div key={tool.id} className="flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{tool.name}</p>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{tool.category}</span>
                        <span className="text-[10px] text-muted-foreground">v{tool.current_version}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{tool.description || "No description"}</p>
                      <p className="text-[11px] text-muted-foreground mt-1">Plan: {tool.minimum_plan}</p>
                    </div>
                    <Switch
                      checked={enabled}
                      disabled={toolMutation.isPending}
                      onCheckedChange={checked => toolMutation.mutate({ toolId: tool.id, enabled: checked })}
                    />
                  </div>
                );
              }) : <p className="text-sm text-muted-foreground">No active tools are available.</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="publish">
          <Card className="bg-panel-bg border-white/10">
            <CardHeader>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <UploadCloud className="w-5 h-5 text-primary" />
                Update Website
              </CardTitle>
              <CardDescription>
                Create a versioned configuration and commit it to the shared GitHub repository. The connected Vercel project serves updated tenant configurations automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setShowPreview(value => !value)}>
                  {showPreview ? "Hide Preview" : "Preview Draft"}
                </Button>
              </div>
              {showPreview ? (
                <div className="overflow-hidden rounded-xl border border-white/10" style={{ background: settingsForm.secondary_color || "#111827" }}>
                  <div className="flex items-center justify-between p-4" style={{ background: settingsForm.header_bg_color || settingsForm.secondary_color || "#1f2937", color: settingsForm.header_text_color || "#ffffff" }}>
                    <div className="flex items-center gap-3">
                      {settingsForm.logo_url ? <img src={settingsForm.logo_url} alt="Draft logo" className="h-8 w-8 rounded object-contain" /> : null}
                      <span className="font-semibold">{settingsForm.brand_name || settingsForm.site_name || data.site.name}</span>
                    </div>
                    <span className="text-xs opacity-70">Draft preview</span>
                  </div>
                  <div className="grid gap-3 p-4 sm:grid-cols-3">
                    {(toolsData?.installed.filter(item => item.enabled) || []).slice(0, 6).map(item => (
                      <div key={item.id} className="rounded-lg border border-white/10 p-3 text-sm text-white" style={{ background: settingsForm.primary_color ? `${settingsForm.primary_color}22` : "#ffffff0d" }}>
                        {item.tool.name}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">GitHub and Vercel</p>
                    <p className="text-xs text-muted-foreground">
                      {integration?.status === "connected"
                        ? `Connected to ${integration.netlify_site_name}`
                        : integration?.last_error || "Provision this website before its first production update."}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => provisionMutation.mutate()} disabled={provisionMutation.isPending || integration?.status === "connected"}>
                    <Globe className="w-4 h-4 mr-2" />
                    {provisionMutation.isPending ? "Provisioning..." : integration?.status === "connected" ? "Connected" : "Provision Website"}
                  </Button>
                </div>
                {integration?.netlify_site_url ? (
                  <a href={integration.netlify_site_url} target="_blank" rel="noreferrer" className="inline-flex items-center text-xs text-primary hover:underline">
                    Open production website <ExternalLink className="w-3 h-3 ml-1" />
                  </a>
                ) : null}
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                {latestSnapshot ? (
                  <>
                    <p className="text-sm font-medium text-foreground">
                      Latest snapshot: v{latestSnapshot.version_number}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Status: {latestSnapshot.status} • Created {new Date(latestSnapshot.created_at).toLocaleString()}
                    </p>
                    {lastPublished?.published_at ? (
                      <p className="text-xs text-muted-foreground">
                        Last published: {new Date(lastPublished.published_at).toLocaleString()}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No snapshots created yet.</p>
                )}
              </div>

              {deployments.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Recent updates</p>
                  {deployments.slice(0, 5).map(deployment => (
                    <div key={deployment.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm capitalize text-foreground">{deployment.status}</span>
                        <span className="text-xs text-muted-foreground">{new Date(deployment.created_at).toLocaleString()}</span>
                      </div>
                      {deployment.commit_url ? (
                        <a href={deployment.commit_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                          Commit {deployment.commit_sha?.slice(0, 7)}
                        </a>
                      ) : null}
                      {deployment.netlify_log_url ? (
                        <a href={deployment.netlify_log_url} target="_blank" rel="noreferrer" className="ml-3 text-xs text-primary hover:underline">
                          Vercel deploy log
                        </a>
                      ) : null}
                      {deployment.netlify_deploy_url ? (
                        <a href={deployment.netlify_deploy_url} target="_blank" rel="noreferrer" className="ml-3 text-xs text-primary hover:underline">
                          Deployed website
                        </a>
                      ) : null}
                      {deployment.error_message ? <p className="text-xs text-red-400 mt-1">{deployment.error_message}</p> : null}
                      <div className="flex flex-wrap gap-2 mt-2">
                        {(deployment.status.includes("failed") || deployment.status === "failed") ? (
                          <Button size="sm" variant="outline" onClick={() => retryMutation.mutate(deployment.id)} disabled={retryMutation.isPending}>
                            <RefreshCw className="w-3 h-3 mr-1" /> Retry
                          </Button>
                        ) : null}
                        {deployment.publish_version_id && deployment.status === "deployed" ? (
                          <Button size="sm" variant="outline" onClick={() => rollbackMutation.mutate(deployment.publish_version_id!)} disabled={rollbackMutation.isPending}>
                            <RotateCcw className="w-3 h-3 mr-1" /> Restore this version
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={() => draftMutation.mutate()} disabled={draftMutation.isPending}>
                  <UploadCloud className="w-4 h-4 mr-2" />
                  {draftMutation.isPending ? "Creating..." : "Create Draft Snapshot"}
                </Button>
                <Button onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending}>
                  <UploadCloud className="w-4 h-4 mr-2" />
                  {publishMutation.isPending ? "Updating website..." : "Update Website"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

const Field = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <label className="space-y-2 block">
    <span className="text-sm font-medium text-foreground">{label}</span>
    {children}
    {description ? (
      <span className="block text-xs text-muted-foreground">{description}</span>
    ) : null}
  </label>
);

export default SiteRuntimeConfig;
