import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, ShieldAlert, ShieldQuestion } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  checkDerivApplicationCallback,
  getSuperuserDerivStatus,
  updateDerivApplicationCallback,
  type CallbackVerification,
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
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<Record<string, CallbackVerification>>({});

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

  const check = async (site: PlatformSiteSummary) => {
    setCheckingId(site.id);
    try {
      const result = await checkDerivApplicationCallback(site.id);
      setVerifications(prev => ({ ...prev, [site.id]: result }));
      if (result.status === "registered") toast.success(`${site.name}: Deriv accepts this callback`);
      else if (result.status === "not_registered") toast.error(`${site.name}: Deriv rejected this callback`);
      else toast.info(`${site.name}: no completed login to verify yet`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not verify the callback");
    } finally {
      setCheckingId(null);
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
          Deriv only accepts a redirect URI registered on the OAuth 2.0 client, and on the new developer
          portal a portal-listed URL still has to be <span className="font-semibold">verified</span> before
          Deriv will honour it. So there are two separate failures: the URL is missing from the app, or it is
          listed but unverified. A trader sees{" "}
          <span className="font-mono text-[11px]">invalid_request</span> either way — which is why{" "}
          <span className="font-semibold">Verify</span> reports Deriv&apos;s actual verdict rather than assuming
          a mismatch.
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void check(site)}
                  disabled={checkingId === site.id || !site.assignedAppId}
                >
                  {checkingId === site.id ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldQuestion className="mr-2 h-4 w-4" />
                  )}
                  Verify
                </Button>
              </div>
              <VerificationNote
                verification={verifications[site.id]}
                callbackUri={site.callbackUri}
              />
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

/**
 * Shows what Deriv actually said about this tenant's redirect URI.
 *
 * There is no API to read a redirect-URI registration, so this cannot be a live
 * check: it is the verdict from the most recent real login. That is why the
 * wording says "last login" rather than "now", and why a stale verdict (the URI
 * changed after the attempt) is called out instead of being shown as current.
 */
function VerificationNote({
  verification,
  callbackUri,
}: {
  verification?: CallbackVerification;
  callbackUri: string | null;
}) {
  if (!verification) return null;

  const icon =
    verification.status === "registered" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
    ) : verification.status === "not_registered" ? (
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
    ) : (
      <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-amber-300" />
    );

  const tone =
    verification.status === "registered"
      ? "text-emerald-300"
      : verification.status === "not_registered"
        ? "text-red-300"
        : "text-amber-300";

  const stale = verification.lastAttempt?.stale && verification.lastAttempt.redirectUri !== callbackUri;

  return (
    <div className={`mt-2 space-y-1 text-[11px] ${tone}`}>
      <p className="flex items-start gap-1.5">
        {icon}
        <span>{verification.message}</span>
      </p>
      {verification.lastAttempt ? (
        <p className="text-muted-foreground">
          Last login attempt: {new Date(verification.lastAttempt.at).toLocaleString()} · sent{" "}
          <span className="font-mono">{verification.lastAttempt.redirectUri || "unknown"}</span>
          {verification.lastAttempt.derivErrorCode ? (
            <> · Deriv said <span className="font-mono">{verification.lastAttempt.derivErrorCode}</span></>
          ) : null}
          {stale ? " · the URL has changed since this attempt, so log in again to re-check" : null}
        </p>
      ) : null}
    </div>
  );
}

export default AdminTenantDerivApps;
