import { ArrowLeft, Rocket } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useDeployments } from "@/hooks/useDeployments";
import DeploymentRowItem from "@/components/deployments/DeploymentRowItem";

/**
 * Per-site deployment history.
 *
 * Shares the row component and hook with the global /deployments page so the two
 * views can never disagree about what a deployment looks like.
 */
const SiteDeployments = () => {
  const { siteId = "" } = useParams();
  const navigate = useNavigate();

  const { data: site } = useQuery({
    queryKey: ["site-name", siteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sites")
        .select("id, name")
        .eq("id", siteId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(siteId),
  });

  const { deployments, isLoading, hasMore, fetchMore, isFetchingMore } = useDeployments({
    siteId,
  });

  return (
    <div className="flex flex-1 flex-col">
      <header className="px-4 py-5 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="mb-2 -ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sites
        </button>
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">
            {site?.name ?? "Site"} deployments
          </h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Publish history for this site only, newest first
        </p>
      </header>

      <div className="flex-1 space-y-2 px-4 pb-10 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : deployments.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-panel-bg p-8 text-center">
            <Rocket className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-medium text-foreground">
              No deployments yet
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Publish this site to record its first deployment.
            </p>
            <button
              type="button"
              onClick={() => navigate(`/sites/${siteId}/config`)}
              className="btn-primary mt-4 inline-flex items-center gap-1.5 text-xs"
            >
              Open site settings
            </button>
          </div>
        ) : (
          <>
            {deployments.map((deployment) => (
              <DeploymentRowItem
                key={deployment.id}
                deployment={deployment}
                showSite={false}
              />
            ))}
            {hasMore ? (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => fetchMore()}
                  disabled={isFetchingMore}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs text-foreground hover:bg-white/5 disabled:opacity-60"
                >
                  {isFetchingMore ? "Loading…" : "Load older deployments"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};

export default SiteDeployments;
