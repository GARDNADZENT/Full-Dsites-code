import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  DEPLOYMENTS_PAGE_SIZE,
  type DeploymentCursor,
  type DeploymentRowShape,
} from "@/lib/deployments";

export type DeploymentRow = DeploymentRowShape & {
  site?: { id: string; name: string } | null;
};

/**
 * PostgREST needs the cursor timestamp in a URL-safe form.
 *
 * Postgres returns `2026-11-17 14:15:52.172898+00`; we want
 * `"2026-11-17T14:15:52.172898Z"` — quoted so the filter parser treats it as one
 * literal. Returns null when the value cannot be parsed, in which case the caller
 * stops paginating rather than issuing a filter that matches everything.
 */
export function toPostgrestTimestamp(value: string): string | null {
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(date.getTime())) return null;
  return `"${date.toISOString()}"`;
}

const SELECT = `
  id,
  site_id,
  status,
  provider,
  commit_sha,
  commit_url,
  commit_message,
  error_message,
  started_at,
  completed_at,
  created_at,
  deploy_context,
  retry_of,
  rollback_of,
  publish_version_id,
  netlify_deploy_url,
  netlify_log_url,
  repository_branch,
  repository_owner,
  repository_name,
  site:sites!inner(id, name)
`;

/**
 * Keyset-paginated deployment history across every site the caller can see.
 *
 * `!inner` on the site join keeps rows whose site was hard-deleted out of the
 * list; soft-deleted sites still appear because their row survives.
 */
export function useDeployments(options?: {
  siteId?: string;
  status?: string | null;
  provider?: string | null;
}) {
  const { user } = useAuth();
  const { siteId, status, provider } = options ?? {};

  const query = useInfiniteQuery({
    queryKey: ["deployments", user?.id, siteId ?? "all", status ?? "all", provider ?? "all"],
    initialPageParam: null as DeploymentCursor | null,
    queryFn: async ({ pageParam }) => {
      let request = supabase
        .from("site_deployments")
        .select(SELECT)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(DEPLOYMENTS_PAGE_SIZE);

      if (siteId) request = request.eq("site_id", siteId);
      if (status) request = request.eq("status", status);
      if (provider) request = request.eq("provider", provider);

      if (pageParam) {
        // Raw Postgres timestamps contain a space and a `+` offset, both of which
        // corrupt an unquoted PostgREST `or=` filter (`+` decodes to a space and
        // the value silently matches nothing). Normalise to ISO-8601 with a `Z`
        // suffix and double-quote it so PostgREST passes it through verbatim.
        const cursorTime = toPostgrestTimestamp(pageParam.createdAt);

        // created_at descending, id descending as the tiebreaker.
        request = request.or(
          `created_at.lt.${cursorTime},and(created_at.eq.${cursorTime},id.lt.${pageParam.id})`,
        );
      }

      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []) as unknown as DeploymentRow[];
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.length < DEPLOYMENTS_PAGE_SIZE) return undefined;
      const last = lastPage[lastPage.length - 1];
      // Guard the cursor: if the timestamp is unparseable, stop rather than
      // issuing a filter that would return the whole table.
      if (!toPostgrestTimestamp(last.created_at)) return undefined;
      return { createdAt: last.created_at, id: last.id } satisfies DeploymentCursor;
    },
    enabled: !!user,
  });

  const rows = query.data?.pages.flat() ?? [];

  return {
    deployments: rows,
    isLoading: query.isLoading,
    isFetchingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    fetchMore: query.fetchNextPage,
    refetch: query.refetch,
    error: query.error,
  };
}

/**
 * Distinct values actually present, so filter dropdowns never offer an option
 * that returns nothing.
 */
export function useDeploymentFacets() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["deployment-facets", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("site_deployments")
        .select("status, provider")
        .limit(1000);

      if (error) throw error;

      const statuses = new Set<string>();
      const providers = new Set<string>();
      for (const row of (data ?? []) as Array<{ status: string; provider: string }>) {
        if (row.status) statuses.add(row.status);
        if (row.provider) providers.add(row.provider);
      }

      return {
        statuses: [...statuses].sort(),
        providers: [...providers].sort(),
      };
    },
    enabled: !!user,
  });
}
