import { useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMarkupStatistics } from "@/hooks/useMarkupStatistics";

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export default function AdminMarkupStats({ enabled, siteId, adminMode = true, title = "Registered-application markup" }: { enabled: boolean; siteId?: string; adminMode?: boolean; title?: string }) {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))));
  const [dateTo, setDateTo] = useState(isoDate(now));
  const query = useMarkupStatistics({ dateFrom, dateTo, siteId, adminMode, enabled });
  const groups = new Map<string, { amount: number; count: number; turnover: number; hasAmount: boolean; hasCount: boolean; hasTurnover: boolean }>();
  for (const record of query.data?.records || []) {
    const currency = record.currency || "Unspecified";
    const current = groups.get(currency) || { amount: 0, count: 0, turnover: 0, hasAmount: false, hasCount: false, hasTurnover: false };
    if (typeof record.markupAmount === "number") { current.amount += record.markupAmount; current.hasAmount = true; }
    if (typeof record.tradeCount === "number") { current.count += record.tradeCount; current.hasCount = true; }
    if (typeof record.turnover === "number") { current.turnover += record.turnover; current.hasTurnover = true; }
    groups.set(currency, current);
  }

  return <div className="space-y-4 mt-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h3 className="text-lg font-semibold text-foreground flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" />{title}</h3><p className="text-xs text-muted-foreground">Authoritative Deriv markup only; Partner commissions and platform fees are separate.</p></div>
      <div className="flex items-end gap-2"><label className="text-xs font-medium text-foreground space-y-1"><span>From</span><Input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} /></label><label className="text-xs font-medium text-foreground space-y-1"><span>To</span><Input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} /></label><Button type="button" variant="outline" size="icon" onClick={() => query.refetch()}><RefreshCw className={`w-4 h-4 ${query.isFetching ? "animate-spin" : ""}`} /></Button></div>
    </div>
    {query.isLoading && <div className="h-24 rounded-xl bg-muted/50 animate-pulse" />}
    {query.error && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-foreground">{query.error.message}</div>}
    {!query.isLoading && !query.error && groups.size === 0 && <div className="rounded-xl border border-border bg-muted/30 p-5 text-sm text-muted-foreground">No markup records were returned for this range. No total has been inferred.</div>}
    {groups.size > 0 && <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{[...groups.entries()].map(([currency, values]) => <div key={currency} className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">Markup · {currency}</p><p className="text-2xl font-semibold text-foreground">{values.hasAmount ? values.amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "not returned"}</p><p className="text-xs text-muted-foreground mt-2">Trades: {values.hasCount ? values.count : "not returned"} · Turnover: {values.hasTurnover ? values.turnover.toLocaleString() : "not returned"}</p></div>)}</div>}
    {!!query.data?.errors.length && <p className="text-xs text-amber-600">{query.data.errors.length} site connection(s) could not be synchronized.</p>}
  </div>;
}
