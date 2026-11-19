/**
 * Presentation helpers for deployment history.
 *
 * `site_deployments` is written after the fact, so every row here is terminal:
 * there is no "building" state to stream. Anything we cannot derive from stored
 * columns is rendered as unknown rather than guessed.
 */

export type DeploymentStatusKey =
  | "deployed"
  | "committed"
  | "queued"
  | "failed"
  | "cancelled"
  | "unknown";

const STATUS_TONES: Record<DeploymentStatusKey, string> = {
  deployed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  committed: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  queued: "bg-indigo-500/10 text-indigo-300 border-indigo-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
  cancelled: "bg-white/5 text-muted-foreground border-white/10",
  unknown: "bg-white/5 text-muted-foreground border-white/10",
};

const STATUS_LABELS: Record<DeploymentStatusKey, string> = {
  deployed: "Deployed",
  committed: "Committed",
  queued: "In progress",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/**
 * Normalise the free-text `status` column.
 *
 * Writers have used both `deployed` and `deployed_failed`-style strings, so we
 * match on substrings instead of equality. Failure wins over success: a status
 * that mentions "failed" is a failure even if it also says "deploy".
 */
export function normalizeDeploymentStatus(raw?: string | null): DeploymentStatusKey {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();

  if (value.includes("fail") || value.includes("error")) return "failed";
  if (value.includes("cancel") || value.includes("skip")) return "cancelled";
  if (value.includes("deploy")) return "deployed";
  if (value.includes("commit") || value.includes("publish")) return "committed";
  if (value.includes("queue") || value.includes("pending") || value.includes("progress")) {
    return "queued";
  }
  return "unknown";
}

export function deploymentStatusLabel(key: DeploymentStatusKey): string {
  return STATUS_LABELS[key];
}

export function deploymentStatusTone(key: DeploymentStatusKey): string {
  return STATUS_TONES[key];
}

/**
 * Duration between start and completion.
 *
 * Returns null when either timestamp is missing — a half-written row should show
 * "—", not a misleading 0s. Sub-minute spans render in seconds so quick publishes
 * do not all collapse to "0m".
 */
export function formatDuration(
  startedAt?: string | null,
  completedAt?: string | null,
): string | null {
  if (!startedAt || !completedAt) return null;

  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const seconds = Math.round((end - start) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const leftoverMinutes = minutes % 60;
  return leftoverMinutes ? `${hours}h ${leftoverMinutes}m` : `${hours}h`;
}

/**
 * Rows that claim success but have no completion timestamp.
 *
 * This flags a writer bug rather than a display problem: a deployment that
 * reached `deployed` should always have `completed_at`. Surfacing it keeps the
 * inconsistency visible instead of quietly rendering "—" forever.
 */
export function hasInconsistentTimestamps(row: {
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}): boolean {
  const status = normalizeDeploymentStatus(row.status);
  const isTerminalSuccess = status === "deployed" || status === "committed";
  return isTerminalSuccess && !row.completed_at;
}

/**
 * Keyset pagination cursor.
 *
 * Deployments are ordered by `created_at` descending. Two rows can share a
 * millisecond, so the cursor carries `id` as a tiebreaker and the query filters
 * on the compound condition. Offset pagination would drift as new rows arrive.
 */
export type DeploymentCursor = { createdAt: string; id: string };

export function cursorFromRow(row: { created_at: string; id: string }): DeploymentCursor {
  return { createdAt: row.created_at, id: row.id };
}

export const DEPLOYMENTS_PAGE_SIZE = 25;

/**
 * The provider column says "github" but the URLs are Vercel's.
 *
 * The schema kept Netlify-era column names (`netlify_deploy_url`,
 * `netlify_log_url`) after the move to Vercel, so nothing in the UI should repeat
 * that word. This maps raw values to operator-facing labels.
 */
export function providerLabel(raw?: string | null): string {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("github")) return "GitHub";
  if (value.includes("vercel")) return "Vercel";
  if (value.includes("netlify")) return "Vercel"; // legacy column values
  return raw?.trim() || "Unknown";
}

export type DeploymentRowShape = {
  id: string;
  site_id: string;
  status: string;
  provider: string;
  commit_sha: string | null;
  commit_url: string | null;
  commit_message: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  deploy_context: string | null;
  retry_of: string | null;
  rollback_of: string | null;
  publish_version_id: string | null;
  netlify_deploy_url: string | null;
  netlify_log_url: string | null;
  repository_branch: string | null;
  repository_owner: string | null;
  repository_name: string | null;
};

export const shortSha = (sha?: string | null): string =>
  sha ? sha.slice(0, 7) : "—";
