import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";
import { useDeployments, useDeploymentFacets } from "@/hooks/useDeployments";
import { retryDeployment, rollbackSite } from "@/lib/site-runtime-config";
import DeploymentRowItem from "@/components/deployments/DeploymentRowItem";
import { cn } from "@/lib/utils";

const Deployments = () => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>("all");
  const [provider, setProvider] = useState<string>("all");

  const { deployments, isLoading, isFetchingMore, hasMore, fetchMore, refetch } =
    useDeployments({
      status: status === "all" ? null : status,
      provider: provider === "all" ? null : provider,
    });
  const { data: facets } = useDeploymentFacets();

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["deployments"] }),
      queryClient.invalidateQueries({ queryKey: ["deployment-facets"] }),
      queryClient.invalidateQueries({ queryKey: ["site-deployments"] }),
    ]);

  const retryMutation = useMutation({
    mutationFn: retryDeployment,
    onSuccess: async () => {
      toast.success("Deployment retried");
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Retry failed"),
  });

  const rollbackMutation = useMutation({
    mutationFn: ({ siteId, versionId }: { siteId: string; versionId: string }) =>
      rollbackSite(siteId, versionId),
    onSuccess: async () => {
      toast.success("Previous version restored and committed");
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Rollback failed"),
  });

  const busy = retryMutation.isPending || rollbackMutation.isPending;

  const siteByDeploymentId = useMemo(() => {
    const map = new Map<string, string>();
    deployments.forEach((row) => map.set(row.id, row.site_id));
    return map;
  }, [deployments]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl gradient-purple glow-purple-subtle">
            <Rocket className="h-5 w-5 text-foreground" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Deployments</h1>
            <p className="text-xs text-muted-foreground">
              Every publish across your sites, newest first
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-white/10 bg-panel-bg px-3 py-2 text-xs text-foreground"
          >
            <option value="all">All statuses</option>
            {(facets?.statuses ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="rounded-lg border border-white/10 bg-panel-bg px-3 py-2 text-xs text-foreground"
          >
            <option value="all">All providers</option>
            {(facets?.providers ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="flex-1 space-y-3 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {deployments.length === 0
              ? "No deployments recorded"
              : `${deployments.length} deployment${deployments.length === 1 ? "" : "s"} loaded`}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Refresh
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              <p className="text-muted-foreground">Loading deployments…</p>
            </div>
          </div>
        ) : deployments.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-panel-bg p-8 text-center">
            <Rocket className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-medium text-foreground">
              Nothing deployed yet
            </h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              A deployment is recorded each time you publish a site. Open a site
              and use <span className="text-foreground">Publish</span> to create
              the first one.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {deployments.map((deployment) => (
                <DeploymentRowItem
                  key={deployment.id}
                  deployment={deployment}
                  busy={busy}
                  onRetry={(id) => retryMutation.mutate(id)}
                  onRollback={(versionId) =>
                    rollbackMutation.mutate({
                      siteId: siteByDeploymentId.get(deployment.id) ?? deployment.site_id,
                      versionId,
                    })
                  }
                />
              ))}
            </div>

            <div className="flex items-center justify-center pt-2">
              {hasMore ? (
                <button
                  type="button"
                  onClick={() => fetchMore()}
                  disabled={isFetchingMore}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-xs text-foreground hover:bg-white/5",
                    isFetchingMore && "opacity-60",
                  )}
                >
                  {isFetchingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {isFetchingMore ? "Loading…" : "Load older deployments"}
                </button>
              ) : (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <AlertCircle className="h-3 w-3" />
                  End of history
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Deployments;
