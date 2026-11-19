import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Coins,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  clampMarkupRate,
  deletePoolApp,
  formatMarkupRate,
  getSuperuserDerivStatus,
  markPayout,
  addAppForSite,
  repairDerivAssignments,
  MARKUP_PRESETS,
  saveSuperuserToken,
  syncCommissions,
  upsertPoolApp,
  type PlatformPoolApp,
} from "@/lib/platform-deriv";

const formatAmount = (value: number, currency = "USD") =>
  `${currency} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const AdminDerivAppPool = () => {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [wsAppId, setWsAppId] = useState("");
  const [callbackUri, setCallbackUri] = useState("https://dsites-admin.vercel.app/api/deriv-oauth-callback");
  const [defaultFeeRate, setDefaultFeeRate] = useState(17);
  const [busy, setBusy] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10),
  );
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [newAppId, setNewAppId] = useState("");
  const [newAppName, setNewAppName] = useState("");
  const [newAppMarkup, setNewAppMarkup] = useState(2.5);
  const [newAppSecret, setNewAppSecret] = useState("");

  const statusQuery = useQuery({
    queryKey: ["superuser-deriv-status"],
    queryFn: getSuperuserDerivStatus,
    retry: 0,
  });

  const status = statusQuery.data;
  const credential = status?.credential;
  const apps = useMemo<PlatformPoolApp[]>(() => status?.apps || [], [status]);
  const sites = useMemo(() => status?.sites || [], [status]);
  const totals = status?.totals || [];

  useEffect(() => {
    if (!credential) return;
    setWsAppId(credential.wsAppId || "");
    setCallbackUri(credential.defaultCallbackUri);
    setDefaultFeeRate(credential.defaultPlatformFeeRate ?? 17);
  }, [credential]);


  // The token is the single credential every tenant login depends on; an expiry
  // takes the whole platform down, so warn well before it lands.
  const tokenDaysRemaining = credential?.tokenDaysRemaining ?? null;
  const tokenExpired = tokenDaysRemaining !== null && tokenDaysRemaining <= 0;
  const tokenExpiryWarning =
    tokenDaysRemaining === null || tokenDaysRemaining === undefined
      ? null
      : tokenExpired
        ? "This Deriv token has expired. Tenant logins will fail until a new token is saved."
        : tokenDaysRemaining <= 14
          ? `This Deriv token expires in ${tokenDaysRemaining} day${tokenDaysRemaining === 1 ? "" : "s"}. Save a new token to avoid a platform-wide login outage.`
          : null;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["superuser-deriv-status"] });
    await queryClient.invalidateQueries({ queryKey: ["markup-statistics"] });
  };

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    try {
      const message = await action();
      await refresh();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(null);
    }
  };

  const saveToken = () =>
    run("token", async () => {
      const result = await saveSuperuserToken({
        apiToken: tokenInput.trim() || undefined,
        wsAppId,
        defaultCallbackUri: callbackUri,
        defaultPlatformFeeRate: defaultFeeRate,
      });
      setTokenInput("");

      // The token can be stored and verified by Deriv while app registration is
      // still unavailable. Say why accurately, because the reason is easy to get
      // wrong: it is NOT a missing `admin` scope. Current OAuth 2.0 apps use the
      // trade / account_manage / application_read / payment scope set, which has
      // no admin scope at all. app_register belongs to Deriv's legacy stack
      // (legacy WebSocket only, no REST equivalent), and the legacy WebSocket
      // hosts return Cloudflare 520 from server networks.
      if (result.appRegistration && !result.appRegistration.available) {
        toast.warning(
          "Token saved. Automatic app creation is unavailable: Deriv's application methods (app_register) exist only on the legacy WebSocket API, which server networks cannot reach. Register a new application at developers.deriv.com, then add it under Add app.",
          { duration: 12000 },
        );
      }

      return result.verifiedAccount
        ? `Connected Deriv ${result.verifiedAccount.loginid}`
        : result.verification && !result.verification.reachable
          ? "Token saved; Deriv could not be reached to verify it"
          : "Superuser Deriv settings saved";
    });

  const disconnectToken = () =>
    run("disconnect", async () => {
      await saveSuperuserToken({ clearToken: true });
      return "Superuser Deriv token disconnected";
    });



  /**
   * Attach a DevHub-created App ID to one tenant.
   *
   * Automatic registration is blocked whenever Deriv's application API host is
   * unreachable, so the operator creates the app once at developers.deriv.com and
   * pastes the App ID here. Nothing is inferred: the ID typed is the ID bound.
   */
  const linkAppToSite = (site: { id: string; name: string; requestedMarkupRate: number }) => {
    const appId = window.prompt(
      `Deriv App ID for ${site.name}\n\nCreate the app at developers.deriv.com with callback URL:\n${callbackUri}`,
      "",
    );
    if (!appId || !appId.trim()) return;
    void run(`link:${site.id}`, async () => {
      const result = await addAppForSite({
        siteId: site.id,
        derivAppId: appId.trim(),
        callbackUri,
        markupPercentage: site.requestedMarkupRate,
      });
      return `${site.name} → app ${result.app.appId}`;
    });
  };

  const repairAssignments = () =>
    run("repair", async () => {
      const result = await repairDerivAssignments();
      return result.repairedSites === 0
        ? "Every site is already bound to its own app"
        : `${result.repairedSites} site${result.repairedSites === 1 ? "" : "s"} rebound to their own app`;
    });


  const addManualApp = () =>
    run("manual", async () => {
      if (!newAppId.trim()) throw new Error("Deriv App ID is required");
      // app_update is a legacy-only method, so nothing is pushed to Deriv here;
      // the pool row is local and the App ID is the authoritative link.
      const safeName = newAppName.trim() || `DSites Pool ${formatMarkupRate(newAppMarkup)} Markup`;
      const result = await upsertPoolApp({
        appId: newAppId.trim(),
        oauthClientId: newAppId.trim(),
        name: safeName,
        markupPercentage: newAppMarkup,
        callbackUri,
        clientSecret: newAppSecret.trim() || undefined,
        isDefault: true,
      });
      setNewAppId("");
      setNewAppName("");
      setNewAppSecret("");
      return `Pool app ${result.app.appId} saved`;
    });

  const syncLedger = () =>
    run("sync", async () => {
      const result = await syncCommissions(dateFrom, dateTo);
      return `${result.processed} ledger rows · ${result.attributed} attributed · ${result.unattributed} unattributed`;
    });

  const payout = (siteId: string, currency: string) =>
    run(`payout:${siteId}:${currency}`, async () => {
      const result = await markPayout({ siteId, currency });
      return `${result.paidCount} ledger rows marked paid (${formatAmount(result.totalPaid, currency)})`;
    });

  const toggleApp = (app: PlatformPoolApp) =>
    run(`toggle:${app.id}`, async () => {
      await upsertPoolApp({
        id: app.id,
        appId: app.appId,
        oauthClientId: app.oauthClientId,
        name: app.name,
        markupPercentage: app.markupPercentage,
        callbackUri: app.callbackUri,
        environment: app.environment,
        configuredScopes: app.configuredScopes,
        notes: app.notes || undefined,
        isActive: !app.isActive,
        // The Edge Function clears competing defaults whenever isDefault is true.
        isDefault: app.isDefault ? !app.isActive : false,
      });
      return `${app.appId} ${app.isActive ? "deactivated" : "activated"}`;
    });

  const removeApp = (app: PlatformPoolApp) =>
    run(`delete:${app.id}`, async () => {
      await deletePoolApp(app.id);
      return `Pool app ${app.appId} deleted`;
    });

  return (
    <div className="space-y-6">
      <Card className="bg-panel-bg border-white/10">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-foreground text-lg flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Superuser Deriv App Pool
              </CardTitle>
              <CardDescription>
                Own the v2 DevHub apps, keep the markup, and split commissions with every site owner.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  credential?.connected
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-amber-500/15 text-amber-300"
                }`}
              >
                <BadgeCheck className="h-3.5 w-3.5" />
                {credential?.connected
                  ? `Deriv: ${credential.loginId || "connected"}`
                  : "No Deriv token connected"}
              </span>
              <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={statusQuery.isFetching}>
                <RefreshCw className={`h-4 w-4 ${statusQuery.isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusQuery.error ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {statusQuery.error instanceof Error ? statusQuery.error.message : "Unable to load the pool status"}.
                Superuser admin permission is required.
              </span>
            </div>
          ) : null}

          {credential?.connected ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Automatic app creation is unavailable: Deriv's <code className="font-mono">app_register</code> exists
                only on the legacy WebSocket API, and the legacy hosts return Cloudflare 520 to server networks. Current
                OAuth 2.0 apps also have no admin scope, so this is not something a token can grant. Register a new
                application at developers.deriv.com with the callback URL below, then add it under Add app.
              </span>
            </div>
          ) : null}

          {credential?.lastError ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Last Deriv error: {credential.lastError}</span>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                Deriv API token
              </p>
              <Input
                type="password"
                value={tokenInput}
                onChange={event => setTokenInput(event.target.value)}
                placeholder={credential?.connected ? "Replace existing Deriv token (optional)" : "Paste a Deriv API token"}
                autoComplete="off"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Deriv App ID</span>
                  <Input
                    value={wsAppId}
                    onChange={event => setWsAppId(event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64))}
                    placeholder="e.g. 33MsUFUfuukH8nJjySUAA"
                  />
                  <span className="block text-[10px] text-muted-foreground">
                    OAuth 2.0 App ID from developers.deriv.com. IDs are alphanumeric; they are not numbers.
                  </span>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Default platform fee %</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={defaultFeeRate}
                    onChange={event => setDefaultFeeRate(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
                  />
                </label>
              </div>
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>Central OAuth callback URL</span>
                <Input value={callbackUri} onChange={event => setCallbackUri(event.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveToken()} disabled={busy === "token"}>
                  {busy === "token" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                  {tokenInput.trim() ? "Verify & save token" : "Save settings"}
                </Button>
                {credential?.connected ? (
                  <Button variant="outline" onClick={() => void disconnectToken()} disabled={busy === "disconnect"}>
                    Disconnect token
                  </Button>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Scopes: {credential?.scopes?.length ? credential.scopes.join(", ") : "none yet"}.
                {" "}Deriv OAuth 2.0 scopes are trade, account_manage, application_read and payment; there is no admin scope, and none of them can register applications.
              </p>
              {tokenExpiryWarning ? (
                <p className={`text-[11px] ${tokenExpired ? "text-red-300" : "text-amber-300"}`}>
                  {tokenExpiryWarning}
                </p>
              ) : null}
            </div>

          </div>
        </CardContent>
      </Card>

      <Card className="bg-panel-bg border-white/10">
        <CardHeader>
          <CardTitle className="text-foreground text-lg">Pool apps ({apps.length})</CardTitle>
          <CardDescription>Each app carries one markup tier. Sites bind the closest active tier automatically.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto]">
            <Input value={newAppId} onChange={event => setNewAppId(event.target.value)} placeholder="v2 DevHub App ID" />
            <Input value={newAppName} onChange={event => setNewAppName(event.target.value)} placeholder="Display name (optional)" />
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{formatMarkupRate(newAppMarkup)}</span>
              <Slider value={[newAppMarkup]} min={0} max={3} step={0.5} onValueChange={values => setNewAppMarkup(clampMarkupRate(values[0] ?? 2.5))} />
            </div>
            <Button onClick={() => void addManualApp()} disabled={busy === "manual"}>
              {busy === "manual" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add app
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              type="password"
              value={newAppSecret}
              onChange={event => setNewAppSecret(event.target.value)}
              placeholder="Client secret (optional, encrypted)"
              autoComplete="off"
            />
            <div className="flex items-center rounded-md border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                Set markup and the callback URL on this app in the Deriv dashboard; the platform cannot push them.
              </span>
            </div>
          </div>

          {statusQuery.isLoading ? (
            <div className="h-28 animate-pulse rounded-xl bg-white/5" />
          ) : apps.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-sm text-muted-foreground">
              No pool apps yet. Connect a Deriv admin token and generate the tier pool, or add an app ID manually.
            </div>
          ) : (
            <div className="space-y-2">
              {apps.map(app => (
                <div key={app.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{app.name}</span>
                      <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[11px] font-semibold text-primary">
                        {formatMarkupRate(app.markupPercentage)}
                      </span>
                      {app.isDefault ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">default</span>
                      ) : null}
                      {!app.isActive ? (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">inactive</span>
                      ) : null}
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">{app.environment}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground break-all">
                      App {app.appId} · OAuth {app.oauthClientId} · {app.registrationSource}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <Users className="mr-1 inline h-3 w-3" />
                      {app.assignedSiteCount} site{app.assignedSiteCount === 1 ? "" : "s"} · scopes {app.configuredScopes.join(", ") || "trade"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleApp(app)}
                      disabled={busy === `toggle:${app.id}`}
                    >
                      {app.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-300 hover:bg-red-500/10"
                      onClick={() => void removeApp(app)}
                      disabled={busy === `delete:${app.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-panel-bg border-white/10">
        <CardHeader>
          <CardTitle className="text-foreground text-lg flex items-center gap-2">
            <Coins className="h-5 w-5 text-primary" />
            Commission split
          </CardTitle>
          <CardDescription>
            Gross Deriv markup, the superuser fee, and what each site owner is owed. Sync pulls <code>app_markup_details</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>From</span>
              <Input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>To</span>
              <Input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} />
            </label>
            <Button onClick={() => void syncLedger()} disabled={busy === "sync"}>
              {busy === "sync" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync commissions
            </Button>
          </div>

          {totals.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {totals.map(row => (
                <div key={row.currency} className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <p className="text-xs text-muted-foreground">{row.currency} · {row.tradeCount} trades</p>
                  <p className="text-lg font-semibold text-foreground">{formatAmount(row.grossMarkup, row.currency)}</p>
                  <p className="text-xs text-muted-foreground">Superuser {formatAmount(row.superuserFee, row.currency)}</p>
                  <p className="text-xs text-emerald-300">Owners {formatAmount(row.ownerNet, row.currency)}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    unpaid {formatAmount(row.ownerPending, row.currency)} · unattributed {row.unattributedTrades}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-white/10">
                  <th className="py-2 pr-3 font-medium">Site</th>
                  <th className="py-2 pr-3 font-medium">Owner</th>
                  <th className="py-2 pr-3 font-medium">Deriv app</th>
                  <th className="py-2 pr-3 font-medium">Markup</th>
                  <th className="py-2 pr-3 font-medium">Traders</th>
                  <th className="py-2 pr-3 font-medium">Gross</th>
                  <th className="py-2 pr-3 font-medium">Superuser</th>
                  <th className="py-2 pr-3 font-medium">Owner net</th>
                  <th className="py-2 pr-3 font-medium">Unpaid</th>
                  <th className="py-2 pr-3 font-medium">Payout</th>
                  <th className="py-2 pr-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {sites.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-4 text-center text-muted-foreground">No sites yet.</td>
                  </tr>
                ) : (
                  sites.map(site => (
                    <tr key={site.id} className="border-b border-white/5">
                      <td className="py-2 pr-3">
                        <span className="text-foreground">{site.name}</span>
                        <span className="block text-[11px] text-muted-foreground break-all">{site.hostname || "no domain"}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {site.ownerEmail}
                        {site.ownerDerivLoginId ? <span className="block text-[11px]">{site.ownerDerivLoginId}</span> : null}
                      </td>
                      <td className="py-2 pr-3">
                        {site.derivMode === "custom" ? (
                          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">
                            own app
                          </span>
                        ) : site.assignedAppId ? (
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                              app {site.assignedAppId}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                              no app
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => linkAppToSite(site)}
                              disabled={busy === `link:${site.id}`}
                              title="Attach an App ID you created at developers.deriv.com"
                            >
                              {busy === `link:${site.id}` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Link2 className="h-3 w-3" />
                              )}
                              <span className="ml-1">Link app</span>
                            </Button>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatMarkupRate(site.requestedMarkupRate)}
                        <span className="block text-[11px]">{site.assignedAppId || "queued"}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{site.realTraders} / {site.demoTraders}</td>
                      <td className="py-2 pr-3 text-foreground">{formatAmount(site.grossMarkup, site.currency)}</td>
                      <td className="py-2 pr-3 text-foreground">{formatAmount(site.superuserFee, site.currency)}</td>
                      <td className="py-2 pr-3 text-emerald-300">{formatAmount(site.ownerNet, site.currency)}</td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatAmount(site.ownerPending, site.currency)}
                        <span className="block text-[11px]">{formatMarkupRate(site.requestedMarkupRate)} markup</span>
                      </td>
                      <td className="py-2 pr-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={site.ownerPending <= 0 || busy === `payout:${site.id}:${site.currency}`}
                          onClick={() => void payout(site.id, site.currency)}
                        >
                          {busy === `payout:${site.id}:${site.currency}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Wallet className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1.5">Mark paid</span>
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Users className="h-3 w-3" />
            Traders shown as real / demo are attributed by app ID + login ID on every login through a DSites site.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminDerivAppPool;
