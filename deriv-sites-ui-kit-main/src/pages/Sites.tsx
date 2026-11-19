import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Globe,
  Loader2,
  PencilRuler,
  Plus,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSiteCards } from "@/hooks/useSiteCards";
import {
  createDraftSite,
  getDomainKindLabel,
  getSitePrimaryHostname,
  type SiteWithDomains,
} from "@/lib/domain-utils";
import {
  buildPlatformTabs,
  resolveOperationalState,
  type OperationalStatus,
} from "@/lib/site-status";
import SitesStatCard from "@/components/sites/SitesStatCard";
import SiteCard from "@/components/sites/SiteCard";
import ConnectDomainDialog from "@/components/ConnectDomainDialog";
import { cn } from "@/lib/utils";

const Sites = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { sites, isLoading, refetch } = useSiteCards();

  const [activeTab, setActiveTab] = useState("all");
  const [creating, setCreating] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    try {
      const { siteId } = await createDraftSite({
        userId: user.id,
        email: user.email,
      });
      toast.success("Site draft created");
      navigate(`/sites/${siteId}/wizard`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create site",
      );
      setCreating(false);
    }
  };

  const handleDelete = async (siteId: string, name: string) => {
    const confirmed = window.confirm(
      `Delete "${name}"? This hides the site from your dashboard. The hostname stays reserved until you release it.`,
    );
    if (!confirmed) return;

    setDeletingId(siteId);
    try {
      // Soft delete: keeps audit history and avoids orphaning deployment rows.
      const { error } = await supabase
        .from("sites")
        .update({ status: "deleted" })
        .eq("id", siteId);
      if (error) throw error;
      toast.success("Site deleted");
      await refetch();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete the site",
      );
    } finally {
      setDeletingId(null);
    }
  };

  const enriched = useMemo(
    () =>
      sites.map((site) => {
        const hostname = getSitePrimaryHostname(site);
        const integration = site.site_integrations?.[0] ?? null;
        return {
          site,
          hostname,
          domainKind: getDomainKindLabel(site, hostname),
          state: resolveOperationalState({
            siteStatus: site.status,
            integration,
            hostname,
          }),
        };
      }),
    [sites],
  );

  const byStatus = (key: OperationalStatus) =>
    enriched.filter((entry) => entry.state.key === key).length;

  const thisMonth = enriched.filter((entry) => {
    const created = new Date(entry.site.created_at);
    const now = new Date();
    return (
      created.getMonth() === now.getMonth() &&
      created.getFullYear() === now.getFullYear()
    );
  }).length;

  const tabs = useMemo(
    () =>
      buildPlatformTabs(
        sites.map((site) => site.site_configurations?.[0]?.template_id ?? null),
      ),
    [sites],
  );

  const visible = useMemo(() => {
    if (activeTab === "all") return enriched;
    return enriched.filter((entry) => {
      const templateId =
        entry.site.site_configurations?.[0]?.template_id ?? "unassigned";
      return templateId === activeTab;
    });
  }, [enriched, activeTab]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="text-muted-foreground">Loading your sites…</p>
        </div>
      </div>
    );
  }

  const attention = byStatus("failed");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl gradient-purple glow-purple-subtle">
            <Globe className="h-5 w-5 text-foreground" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Your Sites</h1>
            <p className="text-xs text-muted-foreground">
              Manage and deploy your trading platform sites
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
          >
            <TrendingUp className="h-3.5 w-3.5" />
            Earnings overview
          </button>
          <button
            type="button"
            onClick={() => navigate("/support")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            Report an issue
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="btn-primary inline-flex items-center gap-1.5 text-xs disabled:opacity-60"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {creating ? "Creating…" : "Create Site"}
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-5 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SitesStatCard
            label="Total sites"
            value={sites.length}
            icon={Globe}
            tone="purple"
          />
          <SitesStatCard
            label="Deployed"
            value={byStatus("deployed")}
            icon={RefreshCw}
            tone="emerald"
          />
          <SitesStatCard
            label="Drafts"
            value={byStatus("draft")}
            icon={PencilRuler}
            tone="amber"
          />
          <SitesStatCard
            label="This month"
            value={thisMonth}
            icon={TrendingUp}
            tone="sky"
          />
        </div>

        {attention > 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <p className="text-xs text-red-200">
              {attention} site{attention > 1 ? "s" : ""} failed to deploy. Open
              the site to see the error and retry the claim — the hostname stays
              reserved in the meantime.
            </p>
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Filter sites
              </h2>
              <p className="text-xs text-muted-foreground">
                Switch between all platforms or view one platform type only.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              Showing {visible.length} of {sites.length} sites
            </span>
          </div>

          <div className="flex gap-1 overflow-x-auto rounded-xl border border-white/10 bg-panel-bg p-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "whitespace-nowrap rounded-lg px-3 py-2 text-xs transition-colors",
                  activeTab === tab.id
                    ? "bg-white/10 font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>
        </section>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-panel-bg p-8 text-center">
            <Globe className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-medium text-foreground">
              {sites.length === 0 ? "No sites yet" : "Nothing in this view"}
            </h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              You do not need to buy a domain to start. Launch on a free{" "}
              <code className="text-foreground">.vercel.app</code> URL, connect a
              domain you already own, or create a blank draft.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                className="btn-primary inline-flex items-center gap-1.5 text-xs"
              >
                <Globe className="h-3.5 w-3.5" />
                Free .vercel.app site
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Start blank draft
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map(({ site, hostname, domainKind }) => (
              <SiteCard
                key={site.id}
                site={site}
                hostname={hostname}
                domainKind={domainKind}
                onEdit={() => navigate(`/sites/${site.id}/wizard`)}
                onDelete={() => handleDelete(site.id, site.name)}
              />
            ))}
          </div>
        )}

        {deletingId ? (
          <p className="text-xs text-muted-foreground">Deleting site…</p>
        ) : null}
      </div>

      <ConnectDomainDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialMode="vercel_subdomain"
        sites={sites as unknown as SiteWithDomains[]}
        onConnected={() => refetch()}
        onSwitchToBuy={() => navigate("/domains?buy=1")}
      />
    </div>
  );
};

export default Sites;
