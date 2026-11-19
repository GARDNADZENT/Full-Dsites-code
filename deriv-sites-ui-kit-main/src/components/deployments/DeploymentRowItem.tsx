import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deploymentStatusLabel,
  deploymentStatusTone,
  formatDuration,
  hasInconsistentTimestamps,
  normalizeDeploymentStatus,
  providerLabel,
  shortSha,
} from "@/lib/deployments";
import type { DeploymentRow } from "@/hooks/useDeployments";

const formatWhen = (value: string) => {
  const date = new Date(value);
  const now = Date.now();
  const diffMinutes = Math.round((now - date.getTime()) / 60000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)}h ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const DeploymentRowItem = ({
  deployment,
  showSite = true,
  onRetry,
  onRollback,
  busy = false,
}: {
  deployment: DeploymentRow;
  showSite?: boolean;
  onRetry?: (id: string) => void;
  onRollback?: (publishVersionId: string) => void;
  busy?: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);

  const statusKey = normalizeDeploymentStatus(deployment.status);
  const duration = formatDuration(deployment.started_at, deployment.completed_at);
  const inconsistent = hasInconsistentTimestamps(deployment);
  const canRetry = statusKey === "failed" && Boolean(onRetry);
  const canRollback =
    statusKey === "deployed" &&
    Boolean(deployment.publish_version_id) &&
    Boolean(onRollback);

  const hasDetail =
    Boolean(deployment.commit_message) ||
    Boolean(deployment.error_message) ||
    Boolean(deployment.netlify_deploy_url) ||
    Boolean(deployment.netlify_log_url) ||
    Boolean(deployment.retry_of) ||
    Boolean(deployment.rollback_of);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="flex items-start gap-3 p-3">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((value) => !value)}
          disabled={!hasDetail}
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground",
            hasDetail ? "hover:text-foreground" : "opacity-30",
          )}
          aria-label={expanded ? "Collapse deployment" : "Expand deployment"}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                deploymentStatusTone(statusKey),
              )}
            >
              {deploymentStatusLabel(statusKey)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {providerLabel(deployment.provider)}
            </span>
            {showSite && deployment.site ? (
              <span className="truncate text-[11px] text-foreground">
                {deployment.site.name}
              </span>
            ) : null}
            {deployment.deploy_context ? (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {deployment.deploy_context}
              </span>
            ) : null}
            {duration ? (
              <span className="text-[11px] text-muted-foreground">· {duration}</span>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              · {formatWhen(deployment.created_at)}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            {deployment.commit_sha ? (
              deployment.commit_url ? (
                <a
                  href={deployment.commit_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                >
                  {shortSha(deployment.commit_sha)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="font-mono text-muted-foreground">
                  {shortSha(deployment.commit_sha)}
                </span>
              )
            ) : (
              <span className="text-muted-foreground">No commit</span>
            )}
            {deployment.repository_branch ? (
              <span className="text-muted-foreground">
                on {deployment.repository_branch}
              </span>
            ) : null}
            {deployment.retry_of ? (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                retry
              </span>
            ) : null}
            {deployment.rollback_of ? (
              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300">
                rollback
              </span>
            ) : null}
          </div>

          {inconsistent ? (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Marked {deployment.status} but never recorded a completion time
            </p>
          ) : null}

          {!expanded && deployment.error_message ? (
            <p className="mt-1.5 line-clamp-1 text-[11px] text-red-400">
              {deployment.error_message}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canRetry ? (
            <button
              type="button"
              onClick={() => onRetry?.(deployment.id)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-foreground hover:bg-white/5 disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          ) : null}
          {canRollback ? (
            <button
              type="button"
              onClick={() => onRollback?.(deployment.publish_version_id!)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-foreground hover:bg-white/5 disabled:opacity-50"
            >
              <Undo2 className="h-3 w-3" />
              Roll back
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-white/10 px-3 py-2 pl-9">
          {deployment.commit_message ? (
            <p className="whitespace-pre-wrap text-[11px] text-foreground">
              {deployment.commit_message}
            </p>
          ) : null}
          {deployment.error_message ? (
            <p className="whitespace-pre-wrap rounded border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
              {deployment.error_message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            {deployment.netlify_deploy_url ? (
              <a
                href={deployment.netlify_deploy_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Deployment
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            {deployment.netlify_log_url ? (
              <a
                href={deployment.netlify_log_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <FileText className="h-3 w-3" />
                Build log
              </a>
            ) : null}
            {deployment.repository_owner && deployment.repository_name ? (
              <span className="text-muted-foreground">
                {deployment.repository_owner}/{deployment.repository_name}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DeploymentRowItem;
