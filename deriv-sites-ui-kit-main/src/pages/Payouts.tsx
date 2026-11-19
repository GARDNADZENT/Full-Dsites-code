import { useMemo, useState } from "react";
import { AlertTriangle, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommissionBySite } from "@/hooks/useCommissions";
import {
  formatMinorUnits,
  normalizePayoutStatus,
  PAYOUT_TONES,
} from "@/lib/commissions";

/**
 * Payout visibility.
 *
 * Read-only on purpose: transferring money is an explicit, auditable action and
 * this view does not pretend to do it. It answers "what is owed, for which site,
 * and what has already been paid".
 */
const Payouts = () => {
  const [range, setRange] = useState<"30" | "90" | "all">("all");

  const from = useMemo(() => {
    if (range === "all") return undefined;
    const days = range === "30" ? 30 : 90;
    const start = new Date();
    start.setDate(start.getDate() - days);
    return start.toISOString().slice(0, 10);
  }, [range]);

  const { bySite, rows, isLoading } = useCommissionBySite({ from });
  const currency = rows[0]?.currency ?? "USD";

  const owedTotal = bySite.reduce((total, site) => total + site.unpaidOwnerMinor, 0);
  const paidTotal = bySite.reduce(
    (total, site) => total + (site.ownerMinor - site.unpaidOwnerMinor),
    0,
  );

  const recentPaid = useMemo(
    () =>
      rows
        .filter((row) => normalizePayoutStatus(row.payout_status) === "paid")
        .slice(0, 10),
    [rows],
  );

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl gradient-purple glow-purple-subtle">
            <Wallet className="h-5 w-5 text-foreground" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Payouts</h1>
            <p className="text-xs text-muted-foreground">
              What is owed to you, per site
            </p>
          </div>
        </div>

        <div className="flex gap-1 rounded-lg border border-white/10 bg-panel-bg p-1">
          {(["30", "90", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px]",
                range === option
                  ? "bg-white/10 font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "all" ? "All time" : `${option}d`}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 space-y-4 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-amber-500/20 bg-panel-bg p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Outstanding
            </p>
            <p className="mt-2 text-2xl font-semibold text-amber-300">
              {formatMinorUnits(owedTotal, currency)}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Recorded but not marked paid
            </p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-panel-bg p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Paid to date
            </p>
            <p className="mt-2 text-2xl font-semibold text-emerald-300">
              {formatMinorUnits(paidTotal, currency)}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {recentPaid.length} settled row
              {recentPaid.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : bySite.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-panel-bg p-8 text-center">
            <Wallet className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-medium text-foreground">
              Nothing to pay out yet
            </h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Once Deriv reports markup for your sites, the amount owed appears
              here grouped by site.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-panel-bg">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Site</th>
                  <th className="px-3 py-2 text-right font-medium">Trades</th>
                  <th className="px-3 py-2 text-right font-medium">Gross</th>
                  <th className="px-3 py-2 text-right font-medium">Your net</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {bySite.map((site) => {
                  const settled = site.unpaidOwnerMinor === 0;
                  return (
                    <tr
                      key={site.siteId}
                      className="border-b border-white/5 last:border-0"
                    >
                      <td className="px-3 py-2 text-foreground">{site.siteName}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {site.rows}
                      </td>
                      <td className="px-3 py-2 text-right text-foreground">
                        {formatMinorUnits(site.grossMinor, currency)}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-400">
                        {formatMinorUnits(site.ownerMinor, currency)}
                      </td>
                      <td className="px-3 py-2 text-right text-amber-300">
                        {formatMinorUnits(site.unpaidOwnerMinor, currency)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px]",
                            settled ? PAYOUT_TONES.paid : PAYOUT_TONES.pending,
                          )}
                        >
                          {settled ? "settled" : "outstanding"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="text-[11px] text-muted-foreground">
            This page is read-only. Payouts are recorded by the platform finance
            workflow, and no action here moves money.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Payouts;
