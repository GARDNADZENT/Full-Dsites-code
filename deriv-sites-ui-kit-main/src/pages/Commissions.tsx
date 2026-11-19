import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, DollarSign, RefreshCw, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommissions } from "@/hooks/useCommissions";
import {
  formatMinorUnits,
  fromMinorUnits,
  normalizePayoutStatus,
  PAYOUT_TONES,
} from "@/lib/commissions";

const fmtDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

const CommissionStat = ({
  label,
  value,
  hint,
  tone = "purple",
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "purple" | "emerald" | "amber";
  icon: React.ElementType;
}) => {
  const tones = {
    purple: "border-purple-500/20 bg-purple-500/15 text-purple-300",
    emerald: "border-emerald-500/20 bg-emerald-500/15 text-emerald-300",
    amber: "border-amber-500/20 bg-amber-500/15 text-amber-300",
  } as const;

  return (
    <div className={cn("rounded-xl border bg-panel-bg p-4", tones[tone].split(" ")[0])}>
      <div className="flex items-center gap-2">
        <span className={cn("rounded-lg p-1.5", tones[tone])}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-3 text-2xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
};

const Commissions = () => {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<"30" | "90" | "all">("30");

  const { from } = useMemo(() => {
    if (range === "all") return { from: undefined };
    const days = range === "30" ? 30 : 90;
    const start = new Date();
    start.setDate(start.getDate() - days);
    return { from: start.toISOString().slice(0, 10) };
  }, [range]);

  const { rows, totals, isLoading, refetch } = useCommissions({ from });
  const currency = rows[0]?.currency ?? "USD";

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl gradient-purple glow-purple-subtle">
            <DollarSign className="h-5 w-5 text-foreground" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Commissions</h1>
            <p className="text-xs text-muted-foreground">
              Markup earned by your sites, and how it splits
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
          <button
            type="button"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["commissions"] });
              refetch();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-4 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <CommissionStat
            label="Gross markup"
            value={formatMinorUnits(totals.grossMinor, currency)}
            hint={`${rows.length} trade${rows.length === 1 ? "" : "s"}`}
            icon={DollarSign}
          />
          <CommissionStat
            label="Your share"
            value={formatMinorUnits(totals.ownerMinor, currency)}
            hint="Net after platform fee"
            tone="emerald"
            icon={Wallet}
          />
          <CommissionStat
            label="Owed to you"
            value={formatMinorUnits(totals.unpaidOwnerMinor, currency)}
            hint={`${totals.pendingCount} unpaid row${totals.pendingCount === 1 ? "" : "s"}`}
            tone="amber"
            icon={Wallet}
          />
          <CommissionStat
            label="Platform fee"
            value={formatMinorUnits(totals.feeMinor, currency)}
            hint="Retained by the platform"
            icon={DollarSign}
          />
        </div>

        {totals.discrepancyMinor !== 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs text-amber-200">
              The ledger does not balance: fee plus owner share differs from gross by{" "}
              <strong>{formatMinorUnits(totals.discrepancyMinor, currency)}</strong>.
              Rows are shown as recorded — reconcile before paying out.
            </p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-panel-bg p-8 text-center">
            <DollarSign className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-medium text-foreground">
              No commissions recorded
            </h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Markup appears here after Deriv reports trades for one of your sites.
              Commission rows are written by the platform, not by this page.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-panel-bg">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Site</th>
                  <th className="px-3 py-2 font-medium">Trader</th>
                  <th className="px-3 py-2 text-right font-medium">Markup %</th>
                  <th className="px-3 py-2 text-right font-medium">Gross</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2 text-right font-medium">Your net</th>
                  <th className="px-3 py-2 font-medium">Payout</th>
                  <th className="px-3 py-2 font-medium">Traded</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const payout = normalizePayoutStatus(row.payout_status);
                  return (
                    <tr key={row.id} className="border-b border-white/5 last:border-0">
                      <td className="px-3 py-2 text-foreground">
                        {row.site?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                        {row.client_loginid ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {row.applied_markup_rate != null
                          ? `${Number(row.applied_markup_rate).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-foreground">
                        {formatMinorUnits(
                          Math.round(Number(row.gross_markup_amount ?? 0) * 100),
                          row.currency ?? currency,
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {formatMinorUnits(
                          Math.round(Number(row.superuser_fee_amount ?? 0) * 100),
                          row.currency ?? currency,
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-emerald-400">
                        {formatMinorUnits(
                          Math.round(Number(row.owner_net_amount ?? 0) * 100),
                          row.currency ?? currency,
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px]",
                            PAYOUT_TONES[payout],
                          )}
                        >
                          {payout}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {fmtDate(row.traded_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Amounts reflect the ledger exactly as recorded, derived from stored row
          values rather than recomputed from current rates — so changing a markup
          rate never rewrites past earnings.{" "}
          {from ? `Showing trades since ${fmtDate(from)}.` : "Showing all time."}
        </p>
      </div>
    </div>
  );
};

export default Commissions;
