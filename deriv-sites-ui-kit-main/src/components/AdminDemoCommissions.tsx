import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchCommissionLedgerTotals, type CommissionLedgerTotal } from "@/lib/platform-deriv";
import { formatMinorUnits, toMinorUnits } from "@/lib/commissions";

/**
 * Per-tenant commission from real demo trades.
 *
 * This replaces the simulator. Every row behind these figures came from a
 * contract that actually exists on a Deriv demo account: a real proposal, a real
 * buy, a real contract id. Nothing here is hypothetical.
 *
 * What it does not claim: Deriv reported the per-tenant amount. Both active
 * tenants are bound to the same Deriv app (33MsUFUfuukH8nJjySUAA), and Deriv pays
 * app markup per application, so it cannot attribute a contract to one tenant.
 * The amount is Deriv's published rule applied to that contract's real payout at
 * the site's own configured rate. The panel says "allocated" rather than implying
 * Deriv supplied it, because the difference matters if anyone reconciles this
 * against a Deriv statement.
 *
 * Demo is also not money. These rows are marked so they can never be paid out,
 * which is why they are reported as activity rather than earnings owed.
 */
export default function AdminDemoCommissions() {
    const [totals, setTotals] = useState<CommissionLedgerTotal[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Real rows only. The simulator's rows, if any survive, are excluded by
            // is_simulated so they can never be mistaken for trades.
            const rows = await fetchCommissionLedgerTotals({ simulatedOnly: false });
            setTotals(rows.filter((row) => !row.isSimulated));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not read the commission ledger");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const money = (value: number) => formatMinorUnits(toMinorUnits(value), "USD");
    const rows = totals ?? [];
    const grand = rows.reduce(
        (accumulator, site) => ({
            trades: accumulator.trades + site.trades,
            gross: accumulator.gross + toMinorUnits(site.grossTotal),
            fee: accumulator.fee + toMinorUnits(site.feeTotal),
            owner: accumulator.owner + toMinorUnits(site.ownerTotal),
        }),
        { trades: 0, gross: 0, fee: 0, owner: 0 },
    );
    const anyAllocated = rows.some((site) => site.markupBasis === "allocated");

    return (
        <div className="mt-6 space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                        <FlaskConical className="h-5 w-5 text-primary" />
                        Demo-trade commission
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Recorded from real contracts placed on Deriv demo accounts. Each row is a trade that actually
                        happened — real proposal, real buy, real contract id — grouped by tenant.
                    </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                    <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    {loading ? "Reading…" : "Refresh"}
                </Button>
            </div>

            {error && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-foreground">{error}</div>
            )}

            {!error && !loading && rows.length === 0 && (
                <div className="rounded-xl border border-border bg-muted/30 p-5 text-sm text-muted-foreground">
                    No demo trades have been recorded yet. Place one from a tenant site&apos;s dashboard and it will appear
                    here, attributed to that tenant.
                </div>
            )}

            {rows.length > 0 && (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                                    <th className="py-2 pr-4">Tenant</th>
                                    <th className="py-2 pr-4">Account</th>
                                    <th className="py-2 pr-4 text-right">Trades</th>
                                    <th className="py-2 pr-4 text-right">Gross markup</th>
                                    <th className="py-2 pr-4 text-right">Platform fee</th>
                                    <th className="py-2 pr-4 text-right">Tenant net</th>
                                    <th className="py-2 text-right">Basis</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((site) => (
                                    <tr key={`${site.siteId}-${site.accountType}-${site.markupBasis}`} className="border-b border-border/50">
                                        <td className="py-2 pr-4 font-medium text-foreground">{site.siteName}</td>
                                        <td className="py-2 pr-4 text-muted-foreground">
                                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium uppercase text-foreground">
                                                {site.accountType}
                                            </span>
                                        </td>
                                        <td className="py-2 pr-4 text-right text-muted-foreground">{site.trades}</td>
                                        <td className="py-2 pr-4 text-right text-foreground">{money(site.grossTotal)}</td>
                                        <td className="py-2 pr-4 text-right text-foreground">{money(site.feeTotal)}</td>
                                        <td className="py-2 pr-4 text-right font-medium text-emerald-500">{money(site.ownerTotal)}</td>
                                        <td className="py-2 text-right text-xs text-muted-foreground">{site.markupBasis}</td>
                                    </tr>
                                ))}
                                <tr className="font-medium">
                                    <td className="py-2 pr-4 text-foreground">All tenants</td>
                                    <td className="py-2 pr-4" />
                                    <td className="py-2 pr-4 text-right text-muted-foreground">{grand.trades}</td>
                                    <td className="py-2 pr-4 text-right text-foreground">{formatMinorUnits(grand.gross, "USD")}</td>
                                    <td className="py-2 pr-4 text-right text-foreground">{formatMinorUnits(grand.fee, "USD")}</td>
                                    <td className="py-2 pr-4 text-right text-emerald-500">{formatMinorUnits(grand.owner, "USD")}</td>
                                    <td className="py-2" />
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div className="space-y-1 text-xs text-muted-foreground">
                        {anyAllocated && (
                            <p>
                                <span className="font-medium text-foreground">allocated</span> means the per-tenant amount
                                is computed from the contract&apos;s real payout at the tenant&apos;s own rate — not reported
                                by Deriv. Both tenants currently share one Deriv app, and Deriv pays markup per
                                application, so it cannot attribute a trade to one tenant. Giving each tenant its own app
                                is what makes a figure Deriv-reported.
                            </p>
                        )}
                        <p>
                            Demo trades are recorded as <span className="font-medium text-foreground">demo</span> and are
                            never payable. Nothing here is money owed to anyone.
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}
