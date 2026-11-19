import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Per-site summary used by the Sites grid.
 *
 * Extends the existing dashboard payload with the integration row so the card
 * can tell the operator whether the site is actually live on Vercel, not just
 * whether the `sites` row says `active`.
 */
export type SiteCardSummary = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  deriv_mode: string | null;
  platform_deriv_app_id: string | null;
  requested_markup_rate: number | string | null;
  configuration_status: string | null;
  active_configuration_version: number | null;
  domain_purchases?: { domain_name: string } | null;
  site_domains?:
    | Array<{
        id: string;
        hostname: string;
        is_primary: boolean;
        status: string;
        is_verified: boolean;
        ssl_status: string | null;
      }>
    | null;
  site_integrations?:
    | Array<{
        status: string | null;
        netlify_site_url: string | null;
        netlify_site_name: string | null;
        last_error: string | null;
      }>
    | null;
  site_configurations?:
    | Array<{ template_id: string | null; status: string | null }>
    | null;
  site_deriv_apps?: Array<{ id: string }> | null;
};

export function useSiteCards() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ["site-cards", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sites")
        .select(
          `
          id,
          name,
          status,
          created_at,
          deriv_mode,
          platform_deriv_app_id,
          requested_markup_rate,
          configuration_status,
          active_configuration_version,
          domain_purchases(domain_name),
          site_domains(id, hostname, is_primary, status, is_verified, ssl_status),
          site_integrations(status, netlify_site_url, netlify_site_name, last_error),
          site_configurations(template_id, status),
          site_deriv_apps(id)
        `,
        )
        .neq("status", "deleted")
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data ?? []) as unknown as SiteCardSummary[];
    },
    enabled: !!user,
  });

  return {
    sites: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
