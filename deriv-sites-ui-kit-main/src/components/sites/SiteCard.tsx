import {
  Calendar,
  Copy,
  ExternalLink,
  Globe,
  Pencil,
  Rocket,
  Trash2,
  Check,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import StatusPill from "@/components/sites/StatusPill";
import {
  environmentLabel,
  platformLabel,
  resolveOperationalState,
} from "@/lib/site-status";
import type { SiteCardSummary } from "@/hooks/useSiteCards";

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const AppIdRow = ({ appId }: { appId: string | null }) => {
  const [copied, setCopied] = useState(false);

  if (!appId) {
    return (
      <span className="text-xs text-muted-foreground">
        Created automatically when the site is deployed
      </span>
    );
  }

  const short = appId.length > 14 ? `${appId.slice(0, 10)}…${appId.slice(-4)}` : appId;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(appId);
      setCopied(true);
      toast.success("App ID copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select the ID and copy manually");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={appId}
      className="group inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-foreground hover:bg-white/10"
    >
      {short}
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
      )}
    </button>
  );
};

const SiteCard = ({
  site,
  hostname,
  domainKind,
  onEdit,
  onDelete,
}: {
  site: SiteCardSummary;
  hostname: string | null;
  domainKind: string;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const navigate = useNavigate();
  const integration = site.site_integrations?.[0] ?? null;
  const state = resolveOperationalState({
    siteStatus: site.status,
    integration,
    hostname,
  });
  const templateId = site.site_configurations?.[0]?.template_id ?? null;
  const canOpen = Boolean(hostname) && state.isLive;

  // The provider's app id is the closest analogue to a Deriv "App ID": either the
  // OAuth client we registered, or the platform-managed app assigned to the site.
  const appId =
    site.platform_deriv_app_id ??
    (site.site_deriv_apps?.length ? "Assigned" : null);

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-white/10 bg-panel-bg p-4 transition-colors hover:border-white/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold uppercase tracking-wide text-foreground">
            {site.name}
          </h3>
          {hostname ? (
            <a
              href={`https://${hostname}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
            >
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{hostname}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No domain yet</p>
          )}
        </div>
        <StatusPill state={state} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
          {platformLabel(templateId)}
        </span>
        {hostname ? (
          <span
            className={cn(
              "rounded-md border px-2 py-0.5 text-[10px]",
              domainKind === "Unassigned"
                ? "border-white/10 bg-white/5 text-muted-foreground"
                : "border-primary/25 bg-primary/10 text-primary",
            )}
          >
            {domainKind === "Free Vercel" ? "Free Vercel domain" : domainKind}
          </span>
        ) : null}
      </div>

      <dl className="space-y-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">App ID</dt>
          <dd>
            <AppIdRow appId={appId} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Environment</dt>
          <dd className="font-medium text-foreground">
            {environmentLabel(site.status)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Created</dt>
          <dd className="inline-flex items-center gap-1.5 text-foreground">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            {formatDate(site.created_at)}
          </dd>
        </div>
      </dl>

      {state.key === "failed" && integration?.last_error ? (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {integration.last_error}
        </p>
      ) : null}

      <div className="mt-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </button>
        {canOpen && hostname ? (
          <a
            href={`https://${hostname}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View
          </a>
        ) : (
          <button
            type="button"
            disabled
            title="Available once the site is deployed"
            className="inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-white/5 px-3 py-2 text-xs text-muted-foreground/50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate(`/sites/${site.id}/deployments`)}
          title="Deployment history"
          className="inline-flex items-center justify-center rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
        >
          <Rocket className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete site"
          className="inline-flex items-center justify-center rounded-lg border border-red-500/20 px-3 py-2 text-red-400 hover:bg-red-500/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  );
};

export default SiteCard;
