import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Copy,
  Globe,
  Link2,
  Loader2,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  attachHostnameToSite,
  buildDerivCallbackUrl,
  createDraftSite,
  getRequiredDnsRecords,
  getSitePrimaryHostname,
  normalizeHostnameInput,
  normalizeVercelSlug,
  type SiteWithDomains,
  validateCustomHostname,
  validateVercelSlug,
  VERCEL_SUFFIX,
} from "@/lib/domain-utils";
import {
  ProvisionDomainError,
  provisionSiteDomain,
} from "@/lib/site-runtime-config";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type ConnectMode = "vercel_subdomain" | "custom_domain";

interface ConnectDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: ConnectMode;
  targetSiteId?: string | null;
  sites?: SiteWithDomains[];
  onSwitchToBuy?: () => void;
  onConnected?: (payload: {
    siteId: string;
    hostname: string;
    mode: ConnectMode;
  }) => void;
}

const ConnectDomainDialog = ({
  open,
  onOpenChange,
  initialMode = "vercel_subdomain",
  targetSiteId = null,
  sites = [],
  onSwitchToBuy,
  onConnected,
}: ConnectDomainDialogProps) => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [mode, setMode] = useState<ConnectMode>(initialMode);
  const [selectedTarget, setSelectedTarget] = useState<string>(
    targetSiteId || "new",
  );
  const [siteName, setSiteName] = useState("");
  const [vercelSlug, setVercelSlug] = useState("");
  const [customHostname, setCustomHostname] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setSelectedTarget(targetSiteId || "new");
      setSuggestions([]);
    }
  }, [open, initialMode, targetSiteId]);

  const vercelCheck = useMemo(
    () => validateVercelSlug(vercelSlug),
    [vercelSlug],
  );
  const customCheck = useMemo(
    () => validateCustomHostname(customHostname),
    [customHostname],
  );

  const previewDnsRecords = useMemo(
    () =>
      mode === "custom_domain" && customCheck.valid && !customCheck.isVercelSubdomain
        ? getRequiredDnsRecords(customCheck.hostname)
        : [],
    [mode, customCheck],
  );

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(current => (current === value ? null : current)), 1800);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const resetForm = () => {
    setSiteName("");
    setVercelSlug("");
    setCustomHostname("");
    setSuggestions([]);
    setSubmitting(false);
  };

  const handleSubmit = async () => {
    if (!user) {
      toast.error("Please sign in first");
      return;
    }

    const activeCheck =
      mode === "vercel_subdomain"
        ? {
            valid: vercelCheck.valid,
            hostname: vercelCheck.hostname,
            error: vercelCheck.error,
          }
        : {
            valid: customCheck.valid,
            hostname: customCheck.hostname,
            error: customCheck.error,
          };

    if (!activeCheck.valid || !activeCheck.hostname) {
      toast.error(activeCheck.error || "Enter a valid domain");
      return;
    }

    setSubmitting(true);
    setSuggestions([]);

    try {
      let siteId = selectedTarget;

      if (selectedTarget === "new") {
        const created = await createDraftSite({
          userId: user.id,
          email: user.email,
          name: siteName.trim() || undefined,
          domainMode: mode,
          hostname: activeCheck.hostname,
        });
        siteId = created.siteId;
      } else {
        await attachHostnameToSite(siteId, activeCheck.hostname);
        const callbackUri = buildDerivCallbackUrl(activeCheck.hostname);
        await supabase.from("site_deriv_apps").upsert(
          {
            site_id: siteId,
            redirect_uri: callbackUri,
          },
          { onConflict: "site_id" },
        );
      }

      // Attempt immediate Vercel attach when provisioning credentials are live;
      // if Vercel rejects a taken .vercel.app slug, let the user pick another right here.
      try {
        const provisioned = await provisionSiteDomain(siteId, {
          action: "attach",
          hostname: activeCheck.hostname,
        });

        if (provisioned.domain?.isVerified) {
          toast.success(`${activeCheck.hostname} is live and verified on Vercel`);
        } else if (mode === "custom_domain") {
          toast.success(
            `${activeCheck.hostname} saved. Point your DNS records to Vercel and verify in the wizard.`,
          );
        } else {
          toast.success(`${activeCheck.hostname} saved to your site`);
        }
      } catch (provErr) {
        if (
          provErr instanceof ProvisionDomainError &&
          (provErr.code === "domain_taken" ||
            provErr.code === "domain_claimed" ||
            provErr.code === "domain_reserved")
        ) {
          // Keep selectedTarget pointing at the draft site so picking a suggestion retries cleanly.
          if (selectedTarget === "new") {
            setSelectedTarget(siteId);
          }
          if (provErr.suggestions.length) {
            setSuggestions(provErr.suggestions);
          }
          toast.error(provErr.message);
          setSubmitting(false);
          return;
        }
        // Non-conflict error (e.g. Vercel token not configured yet) — domain is still saved in DB,
        // user can proceed straight into the site wizard and verify/provision in Step 7 or Deployments.
        toast.success(
          mode === "vercel_subdomain"
            ? `${activeCheck.hostname} reserved for your site. Continue setup below.`
            : `${activeCheck.hostname} connected. Continue setup and verify DNS before launch.`,
        );
      }

      onConnected?.({ siteId, hostname: activeCheck.hostname, mode });
      resetForm();
      onOpenChange(false);
      navigate(`/sites/${siteId}/wizard`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to connect domain",
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!submitting) {
          if (!next) resetForm();
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-xl bg-panel-bg border-white/10 text-foreground max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
            <Globe className="w-5 h-5 text-primary" />
            Launch Without Buying a Domain
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Start instantly on a free <code className="text-foreground">.vercel.app</code>{" "}
            subdomain, or connect a custom domain you already own.
          </DialogDescription>
        </DialogHeader>

        {/* Mode selector */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setMode("vercel_subdomain");
              setSuggestions([]);
            }}
            className={`rounded-xl border p-3 text-left transition ${
              mode === "vercel_subdomain"
                ? "border-primary bg-primary/15 text-foreground"
                : "border-white/10 bg-white/5 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="w-4 h-4 text-primary" />
              Free Vercel URL
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Free <code className="text-foreground">name.vercel.app</code> · No DNS needed
            </p>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode("custom_domain");
              setSuggestions([]);
            }}
            className={`rounded-xl border p-3 text-left transition ${
              mode === "custom_domain"
                ? "border-primary bg-primary/15 text-foreground"
                : "border-white/10 bg-white/5 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="w-4 h-4 text-primary" />
              I Own a Domain
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect your existing <code className="text-foreground">.com</code>,{" "}
              <code className="text-foreground">.co.ke</code>, etc.
            </p>
          </button>
        </div>

        <div className="space-y-4 pt-2">
          {/* Site destination */}
          {!targetSiteId && sites.length > 0 ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Apply to
              </span>
              <select
                value={selectedTarget}
                onChange={event => setSelectedTarget(event.target.value)}
                className="w-full h-10 rounded-md border border-white/10 bg-background px-3 text-sm text-foreground"
              >
                <option value="new">+ Create a new site</option>
                {sites.map(site => {
                  const currentHost = getSitePrimaryHostname(site);
                  return (
                    <option key={site.id} value={site.id}>
                      {site.name}
                      {currentHost ? ` (${currentHost})` : " (no domain yet)"}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}

          {selectedTarget === "new" ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Site / brand name (optional)
              </span>
              <Input
                value={siteName}
                onChange={event => {
                  const next = event.target.value;
                  setSiteName(next);
                  if (mode === "vercel_subdomain" && !vercelSlug) {
                    // Leave slug editable; helper button below lets them auto-fill.
                  }
                }}
                placeholder="e.g. Alpha Traders"
              />
            </label>
          ) : null}

          {mode === "vercel_subdomain" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Choose your free Vercel subdomain
                  </span>
                  {siteName.trim() ? (
                    <button
                      type="button"
                      onClick={() => setVercelSlug(normalizeVercelSlug(siteName))}
                      className="text-xs text-primary hover:underline"
                    >
                      Use "{normalizeVercelSlug(siteName)}"
                    </button>
                  ) : null}
                </div>

                <div className="flex items-center rounded-md border border-white/10 bg-background focus-within:ring-2 focus-within:ring-primary/40">
                  <span className="pl-3 text-xs text-muted-foreground select-none">
                    https://
                  </span>
                  <input
                    type="text"
                    value={vercelSlug}
                    onChange={event =>
                      setVercelSlug(
                        event.target.value
                          .toLowerCase()
                          .replace(/\.vercel\.app$/i, "")
                          .replace(/[^a-z0-9-]/g, "-"),
                      )
                    }
                    placeholder="my-trading-brand"
                    className="flex-1 bg-transparent px-1.5 py-2 text-sm text-foreground outline-none"
                  />
                  <span className="pr-3 text-xs font-medium text-muted-foreground select-none">
                    {VERCEL_SUFFIX}
                  </span>
                </div>

                {vercelSlug && !vercelCheck.valid ? (
                  <p className="text-xs text-red-400">{vercelCheck.error}</p>
                ) : vercelCheck.valid ? (
                  <p className="text-xs text-emerald-400">
                    Your site URL: <strong>https://{vercelCheck.hostname}</strong>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    3–63 lowercase letters, numbers, or single hyphens.
                  </p>
                )}
              </div>

              {suggestions.length > 0 ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-xs text-amber-300">
                    Try one of these available-style alternatives:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map(item => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => {
                          setVercelSlug(item);
                          setSuggestions([]);
                        }}
                        className="rounded-md border border-amber-400/30 bg-background/60 px-2.5 py-1 text-xs text-foreground hover:border-primary"
                      >
                        {item}
                        {VERCEL_SUFFIX}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 text-xs text-muted-foreground space-y-1.5">
                <p className="text-foreground font-medium">How free Vercel domains work</p>
                <p>• Free HTTPS/SSL on Vercel — no domain purchase or DNS configuration needed.</p>
                <p>• You can upgrade this same site to your own custom domain anytime later.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Your existing domain
                </span>
                <Input
                  value={customHostname}
                  onChange={event => setCustomHostname(event.target.value)}
                  onBlur={() =>
                    setCustomHostname(current => normalizeHostnameInput(current))
                  }
                  placeholder="mybrand.com or trade.mybrand.com"
                />
                {customHostname && !customCheck.valid ? (
                  <p className="text-xs text-red-400">{customCheck.error}</p>
                ) : customCheck.valid && customCheck.isVercelSubdomain ? (
                  <p className="text-xs text-amber-300">
                    Note: if this <code>.vercel.app</code> URL is attached to your personal
                    Vercel project, remove it there first or pick a fresh name under{" "}
                    <strong>Free Vercel URL</strong>.
                  </p>
                ) : null}
              </div>

              {previewDnsRecords.length > 0 ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 space-y-2.5">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      DNS records to add at your domain registrar
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Add the required record in Namecheap, Cloudflare, GoDaddy, or your DNS host.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {previewDnsRecords.map(record => (
                      <div
                        key={`${record.type}:${record.name}:${record.value}`}
                        className="rounded-lg border border-white/10 bg-background/60 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 font-mono">
                            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                              {record.type}
                            </span>
                            <span className="text-foreground">{record.name}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-emerald-400">{record.value}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyText(record.value)}
                            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {copiedValue === record.value ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            Copy
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {record.purpose}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              disabled={
                submitting ||
                (mode === "vercel_subdomain" ? !vercelCheck.valid : !customCheck.valid)
              }
              onClick={handleSubmit}
              className="w-full btn-primary h-11"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving domain...
                </>
              ) : (
                <>
                  {selectedTarget === "new"
                    ? "Continue to Site Setup"
                    : "Save Domain & Open Wizard"}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>

            {onSwitchToBuy ? (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onSwitchToBuy();
                }}
                className="inline-flex items-center justify-center gap-1.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ShoppingCart className="w-3.5 h-3.5" />
                Prefer to buy a new .com or .site domain via M-Pesa instead?
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectDomainDialog;
