import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  getSuperuserDerivStatus,
  updateDerivApplicationCallback,
  type PlatformSiteSummary,
} from "@/lib/platform-deriv";

/**
 * Per-tenant Deriv app wiring.
 *
 * There is no auto-registration button here on purpose. `app_register` exists
 * only on Deriv's legacy WebSocket stack, every legacy host answers Cloudflare
 * 520 to server networks, and the new platform exposes no applications
 * endpoint, so an "auto-register" control could only ever return 503.
 *
 * The control that actually fixes trader logins is the callback URL. Deriv
 * rejects the login with `invalid_request: The 'redirect_uri' parameter does not
 * match any of the OAuth 2.0 Client's pre-registered redirect urls` whenever the
 * URI we send is not registered on the OAuth client, so the two must match
 * exactly. That is the only failure in this area the platform can fix on its own.
 */
export function AdminTenantDerivApps() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["superuser-deriv-status"],
    queryFn: getSuperuserDerivStatus,
    retry: 0,
  });

  const sites = useMemo<PlatformSiteSummary[]>(
    () => (statusQuery.data?.sites || []).filter(site => site.status !== "deleted"),
    [statusQuery.data],
  );

  const save = async (site: PlatformSiteSummary) => {
    const callbackUri = (drafts[site.id] ?? "").trim();
    if (!callbackUri) {
      toast.error("Enter the callback URL that is registered on the Deriv app");
      return;
    }
    setSavingId(site.id);
    try {
      const result = await updateDerivApplicationCallback({ siteId: site.id, callbackUri });
      setDrafts(prev => {
        const next = { ...prev };
        delete next[site.id];
        return next;
      });
      toast.success(
        result.callbackUpdated
          ? `${site.name}: callback set to ${callbackUri}`
          : `${site.name}: callback already matched`,
      );
      await queryClient.invalidateQueries({ queryKey: ["superuser-deriv-status"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the callback");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Card className="bg-panel-bg border-white/10">
      <CardHeader>
        <CardTitle className="text-foreground text-lg flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          Tenant login callbacks
        </CardTitle>
        <CardDescription>
          Deriv only accepts a redirect URI registered on the OAuth 2.0 client. If a trader sees{" "}
          <span className="font-mono text-[11px]">invalid_request</span> after signing in, this value and the
          app at developers.deriv.com disagree — correct one to match the other, exactly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {statusQuery.isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-white/5" />
        ) : statusQuery.error ? (
          <p className="text-xs text-amber-200">
            {statusQuery.error instanceof Error ? statusQuery.error.message : "Unable to load tenants"}
          </p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tenant sites yet.</p>
        ) : (
          sites.map(site => (
            <div key={site.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{site.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {site.hostname || "no hostname"} · app {site.assignedAppId || "unassigned"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  value={drafts[site.id] ?? site.callbackUri ?? ""}
                  onChange={event => setDrafts(prev => ({ ...prev, [site.id]: event.target.value }))}
                  placeholder={`https://${site.hostname || "your-domain"}/api/deriv-oauth-callback`}
                  className="min-w-0 flex-1"
                />
                <Button
                  size="sm"
                  onClick={() => void save(site)}
                  disabled={savingId === site.id || !site.assignedAppId}
                >
                  {savingId === site.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
                {site.hostname ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDrafts(prev => ({
                        ...prev,
                        [site.id]: `https://${site.hostname}/api/deriv-oauth-callback`,
                      }))
                    }
                  >
                    Use tenant origin
                  </Button>
                ) : null}
              </div>
              {!site.assignedAppId ? (
                <p className="mt-2 text-[11px] text-amber-300">
                  No Deriv app is assigned to this site yet. Add one under Pool apps first.
                </p>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default AdminTenantDerivApps;
