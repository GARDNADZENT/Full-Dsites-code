import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  BadgeCheck,
  CheckCircle2,
  Coins,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
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
  autoGenerateTierPool,
  clampMarkupRate,
  deletePoolApp,
  formatMarkupRate,
  getSuperuserDerivStatus,
  importDerivApps,
  markPayout,
  MARKUP_PRESETS,
  saveSuperuserDerivToken,
  syncCommissions,
  upsertPoolApp,
  type PlatformPoolApp,
} from "@/lib/platform-deriv";

const formatAmount = (value: number, currency = "USD") =>
  `${currency} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const AdminDerivAppPool = () => {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [wsAppId, setWsAppId] = useState("1089");
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
  const [syncToDeriv, setSyncToDeriv] = useState(false);

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
    setWsAppId(credential.wsAppId || "1089");
    setCallbackUri(credential.defaultCallbackUri);
    setDefaultFeeRate(credential.defaultPlatformFeeRate ?? 17);
  }, [credential]);

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
      const result = await saveSuperuserDerivToken({
        apiToken: tokenInput.trim() || undefined,
        wsAppId,
        defaultCallbackUri: callbackUri,
        defaultPlatformFeeRate: defaultFeeRate,
      });
      setTokenInput("");
      return result.verifiedAccount
        ? `Connected Deriv ${result.verifiedAccount.loginid}`
        : "Superuser Deriv settings saved";
    });

  const disconnectToken = () =>
    run("disconnect", async () => {
      await saveSuperuserDerivToken({ clearToken: true });
      return "Superuser Deriv token disconnected";
    });

  const generatePool = () =>
    run("tiers", async () => {
      const result = await autoGenerateTierPool([0, 1, 1.5, 2, 2.5, 3]);
      const parts = [`${result.created.length} tier app${result.created.length === 1 ? "" : "s"} created`];
      if (result.skipped.length) parts.push(`${result.skipped.length} already existed`);
      if (result.errors.length) parts.push(`${result.errors.length} failed`);
      return parts.join(" · ");
    });

  const importApps = () =>
    run("import", async () => {
      const result = await importDerivApps();
      return `${result.imported} of ${result.totalFound} Deriv apps imported`;
    });

  const addManualApp = () =>
    run("manual", async () => {
      if (!newAppId.trim()) throw new Error("Deriv App ID is required");
      const result = await upsertPoolApp({
        appId: newAppId.trim(),
        oauthClientId: newAppId.trim(),
        name: newAppName.trim() || `DSites Pool (${formatMarkupRate(newAppMarkup)} Markup)`,
        markupPercentage: newAppMarkup,
        callbackUri,
        clientSecret: newAppSecret.trim() || undefined,
        isDefault: true,
        syncToDeriv,
      });
      setNewAppId("");
      setNewAppName("");
      setNewAppSecret("");
      return `Pool app ${result.app.appId} saved${result.syncedToDeriv ? " and synced to Deriv" : ""}`;
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
        legacyAppId: app.legacyAppId || undefined,
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
                placeholder={credential?.connected ? "Replace existing CR… token (optional)" : "Paste a Deriv API token with admin scope"}
                autoComplete="off"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>WS app_id</span>
                  <Input value={wsAppId} onChange={event => setWsAppId(event.target.value.replace(/[^0-9]/g, "").slice(0, 12))} placeholder="1089" />
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
                Scopes: {credential?.scopes?.length ? credential.scopes.join(", ") : "none yet"} · admin
                scope {credential?.hasAdminScope ? "present" : "required for app_register"}.
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                One-click tier pool
              </p>
              <p className="text-xs text-muted-foreground">
                Registers a v2 DevHub app for each 0%–3% markup tier and rebalances every platform-managed site.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[0, 1, 1.5, 2, 2.5, 3].map(tier => (
                  <span key={tier} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {formatMarkupRate(tier)}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void generatePool()} disabled={busy === "tiers" || !credential?.connected}>
                  {busy === "tiers" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  Generate 0–3% tier pool
                </Button>
                <Button variant="outline" onClick={() => void importApps()} disabled={busy === "import" || !credential?.connected}>
                  {busy === "import" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowDownUp className="mr-2 h-4 w-4" />}
                  Import existing apps
                </Button>
              </div>
              {!credential?.connected ? (
                <p className="text-[11px] text-amber-300">Connect a Deriv admin token to auto-register apps.</p>
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
            <div className="flex items-center justify-between rounded-md border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-xs text-muted-foreground">Push markup + callback to Deriv (app_update)</span>
              <Switch checked={syncToDeriv} onCheckedChange={setSyncToDeriv} />
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
                      {app.legacyAppId ? ` · legacy ${app.legacyAppId}` : ""}
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
                  <th className="py-2 pr-3 font-medium">Mode</th>
                  <th className="py-2 pr-3 font-medium">Markup</th>
                  <th className="py-2 pr-3 font-medium">Traders</th>
                  <th className="py-2 pr-3 font-medium">Gross</th>
                  <th className="py-2 pr-3 font-medium">Superuser</th>
                  <th className="py-2 pr-3 font-medium">Owner net</th>
                  <th className="py-2 pr-3 font-medium">Unpaid</th>
                  <th className="py-2 pr-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {sites.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-4 text-center text-muted-foreground">No sites yet.</td>
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
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${site.derivMode === "custom" ? "bg-white/10 text-muted-foreground" : "bg-primary/20 text-primary"}`}>
                          {site.derivMode === "custom" ? "custom" : "pool"}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatMarkupRate(site.requestedMarkupRate)}
                        <span className="block text-[11px]">{site.assignedAppId || "queued"}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{site.realTraders} / {site.demoTraders}</td>
                      <td className="py-2 pr-3 text-foreground">{formatAmount(site.grossMarkup, site.currency)}</td>
                      <td className="py-2 pr-3 text-foreground">{formatAmount(site.superuserFee, site.currency)}</td>
                      <td className="py-2 pr-3 text-emerald-300">{formatAmount(site.ownerNet, site.currency)}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{formatAmount(site.ownerPending, site.currency)}</td>
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
