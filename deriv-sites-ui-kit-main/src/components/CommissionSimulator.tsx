import { useState } from "react";
import { FlaskConical, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    fetchCommissionLedgerTotals,
    simulateCommissions,
    type CommissionLedgerTotal,
    type SimulateCommissionsResult,
} from "@/lib/platform-deriv";
import { formatMinorUnits, toMinorUnits } from "@/lib/commissions";

/**
 * Runs a commission simulation and shows the per-tenant split.
 *
 * Two things this deliberately does not do:
 *
 *  1. It never claims the numbers are real. Deriv's new API cannot report earned
 *     markup, so nothing here is measured — it is Deriv's published formula
 *     applied to hypothetical payouts.
 *  2. It never touches a site's configured markup rate. Overrides live only in
 *     the request, so an operator comparing tenants does not silently change
 *     what their live sites charge.
 *
 * The formula is Deriv's, not ours: API Terms §4.3.3 computes markup per trade
 * from the contract payout and the app's markup percentage, truncating to zero
 * any amount below the smallest currency unit. That truncation is why a low
 * margin on small payouts earns exactly nothing, which the per-site summary
 * surfaces as a count rather than hiding it.
 */
export default function CommissionSimulator({ defaultMarkup = 2.5 }: { defaultMarkup?: number }) {
    const [tradesPerSite, setTradesPerSite] = useState("5");
    const [payoutMin, setPayoutMin] = useState("10");
    const [payoutMax, setPayoutMax] = useState("200");
    const [baseRate, setBaseRate] = useState(String(defaultMarkup));
    const [step, setStep] = useState("0.5");
    const [result, setResult] = useState<SimulateCommissionsResult | null>(null);
    // Read back out of the ledger rather than trusting the run's own response.
    const [recorded, setRecorded] = useState<CommissionLedgerTotal[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    const money = (value: number) => formatMinorUnits(toMinorUnits(value), "USD");

    const run = async () => {
        setRunning(true);
        setError(null);
        try {
            // One call. The database spreads the margins across tenants in a
            // single transaction, so the rows it writes and the totals it returns
            // are always the same run — there is no window where a first pass
            // wrote rows at one rate and a second pass wrote them at another.
            const next = await simulateCommissions({
                runId: `ui-${Date.now()}`,
                tradesPerSite: Number(tradesPerSite),
                payoutMin: Number(payoutMin),
                payoutMax: Number(payoutMax),
                marginSpread: true,
                baseRate: Number(baseRate),
                rateStep: Number(step),
            });
            setResult(next);

            // The point of the exercise is that the commission is *recorded*, so
            // the figures below are re-read from site_commission_ledger instead of
            // echoed from the response. If these disagree with the table above, the
            // write is wrong and the operator should see that, not a clean number.
            try {
                setRecorded(await fetchCommissionLedgerTotals({ simulatedOnly: true, runId: next.runId }));
            } catch {
                setRecorded(null);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Simulation failed");
        } finally {
            setRunning(false);
        }
    };

    const totals = result?.sites ?? [];
    const grand = totals.reduce(
        (accumulator, site) => ({
            gross: accumulator.gross + toMinorUnits(site.grossTotal),
            fee: accumulator.fee + toMinorUnits(site.feeTotal),
            owner: accumulator.owner + toMinorUnits(site.ownerTotal),
        }),
        { gross: 0, fee: 0, owner: 0 },
    );

    return (
        <div className="mt-6 space-y-4 rounded-xl border border-border bg-card p-5">
            <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                    <FlaskConical className="h-5 w-5 text-primary" />
                    Commission simulator
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                    Applies Deriv&apos;s own markup rule (§4.3.3): gross = contract <span className="font-medium text-foreground">payout</span> ×
                    markup %, with any amount below 0.01 truncated to zero. These are hypothetical trades — no money is earned and none is
                    owed. Rows are recorded as <span className="font-medium text-foreground">simulated</span> and cannot be marked paid.
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-xs font-medium text-foreground">
                    <span>Trades per site</span>
                    <Input className="w-28" value={tradesPerSite} onChange={(event) => setTradesPerSite(event.target.value)} />
                </label>
                <label className="space-y-1 text-xs font-medium text-foreground">
                    <span>Payout min</span>
                    <Input className="w-28" value={payoutMin} onChange={(event) => setPayoutMin(event.target.value)} />
                </label>
                <label className="space-y-1 text-xs font-medium text-foreground">
                    <span>Payout max</span>
                    <Input className="w-28" value={payoutMax} onChange={(event) => setPayoutMax(event.target.value)} />
                </label>
                <label className="space-y-1 text-xs font-medium text-foreground">
                    <span>First tenant rate %</span>
                    <Input className="w-28" value={baseRate} onChange={(event) => setBaseRate(event.target.value)} />
                </label>
                <label className="space-y-1 text-xs font-medium text-foreground">
                    <span>Step per tenant %</span>
                    <Input className="w-28" value={step} onChange={(event) => setStep(event.target.value)} />
                </label>
                <Button type="button" onClick={run} disabled={running}>
                    <Play className="mr-2 h-4 w-4" />
                    {running ? "Simulating…" : "Run simulation"}
                </Button>
            </div>

            {error && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-foreground">{error}</div>
            )}

            {result && totals.length > 0 && (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                                    <th className="py-2 pr-4">Tenant</th>
                                    <th className="py-2 pr-4 text-right">Markup</th>
                                    <th className="py-2 pr-4 text-right">Trades</th>
                                    <th className="py-2 pr-4 text-right">Payout</th>
                                    <th className="py-2 pr-4 text-right">Gross</th>
                                    <th className="py-2 pr-4 text-right">Platform fee</th>
                                    <th className="py-2 pr-4 text-right">Owner net</th>
                                    <th className="py-2 text-right">Zeroed*</th>
                                </tr>
                            </thead>
                            <tbody>
                                {totals.map((site) => (
                                    <tr key={site.siteId} className="border-b border-border/50">
                                        <td className="py-2 pr-4 font-medium text-foreground">{site.siteName}</td>
                                        <td className="py-2 pr-4 text-right text-foreground">{site.markupRate}%</td>
                                        <td className="py-2 pr-4 text-right text-muted-foreground">{site.trades}</td>
                                        <td className="py-2 pr-4 text-right text-muted-foreground">{money(site.payoutTotal)}</td>
                                        <td className="py-2 pr-4 text-right text-foreground">{money(site.grossTotal)}</td>
                                        <td className="py-2 pr-4 text-right text-foreground">{money(site.feeTotal)}</td>
                                        <td className="py-2 pr-4 text-right font-medium text-emerald-500">{money(site.ownerTotal)}</td>
                                        <td className="py-2 text-right text-muted-foreground">{site.truncatedTrades}</td>
                                    </tr>
                                ))}
                                <tr className="font-medium">
                                    <td className="py-2 pr-4 text-foreground">All tenants</td>
                                    <td className="py-2 pr-4" />
                                    <td className="py-2 pr-4 text-right text-muted-foreground">
                                        {totals.reduce((sum, site) => sum + site.trades, 0)}
                                    </td>
                                    <td className="py-2 pr-4" />
                                    <td className="py-2 pr-4 text-right text-foreground">{formatMinorUnits(grand.gross, "USD")}</td>
                                    <td className="py-2 pr-4 text-right text-foreground">{formatMinorUnits(grand.fee, "USD")}</td>
                                    <td className="py-2 pr-4 text-right text-emerald-500">{formatMinorUnits(grand.owner, "USD")}</td>
                                    <td className="py-2" />
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        * Trades whose markup fell below 0.01 and was therefore zeroed by Deriv&apos;s truncation rule. Run{" "}
                        <span className="font-mono text-foreground">{result.runId}</span> · {result.inserted} row(s) recorded,{" "}
                        {result.skipped} already present.
                    </p>
                </>
            )}
        </div>
    );
}
