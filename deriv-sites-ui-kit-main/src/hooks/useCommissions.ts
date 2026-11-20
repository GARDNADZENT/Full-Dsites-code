import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { aggregateLedger, ledgerDiscrepancyMinor } from "@/lib/commissions";

export type LedgerRow = {
  id: string;
  site_id: string;
  organisation_id: string | null;
  client_loginid: string | null;
  contract_id: string | null;
  currency: string;
  gross_markup_amount: number | string | null;
  applied_markup_rate: number | string | null;
  platform_fee_rate: number | string | null;
  superuser_fee_amount: number | string | null;
  owner_net_amount: number | string | null;
  attribution_status: string | null;
  payout_status: string | null;
  /** True when the row came from the commission simulator, not from Deriv. */
  is_simulated: boolean | null;
  payout_reference: string | null;
  paid_at: string | null;
  traded_at: string | null;
  synchronized_at: string | null;
  site?: { id: string; name: string } | null;
};

const SELECT = `
  id,
  site_id,
  organisation_id,
  client_loginid,
  contract_id,
  currency,
  gross_markup_amount,
  applied_markup_rate,
  platform_fee_rate,
  superuser_fee_amount,
  owner_net_amount,
  attribution_status,
  payout_status,
  is_simulated,
  payout_reference,
  paid_at,
  traded_at,
  synchronized_at,
  site:sites(id, name)
`;

/**
 * Commission ledger for the signed-in operator.
 *
 * Row-level security already scopes this to organisations the caller belongs to
 * (or platform finance readers), so no client-side filtering is used as an access
 * control — only for presentation.
 */
export function useCommissions(options?: {
  siteId?: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const { user } = useAuth();
  const { siteId, from, to, limit = 500 } = options ?? {};

  const query = useQuery({
    queryKey: ["commissions", user?.id, siteId ?? "all", from ?? null, to ?? null, limit],
    queryFn: async () => {
      let request = supabase
        .from("site_commission_ledger")
        .select(SELECT)
        .order("traded_at", { ascending: false, nullsFirst: false })
        .limit(limit);

      if (siteId) request = request.eq("site_id", siteId);
      if (from) request = request.gte("traded_at", `${from}T00:00:00.000Z`);
      if (to) request = request.lte("traded_at", `${to}T23:59:59.999Z`);

      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []) as unknown as LedgerRow[];
    },
    enabled: !!user,
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const totals = useMemo(() => {
    const sums = aggregateLedger(rows);
    return {
      ...sums,
      /**
       * Rows recorded but not yet paid out, in minor units.
       *
       * Simulated rows are excluded on purpose. They are arithmetic, not money:
       * counting them here would tell an operator that a tenant is owed funds
       * that no one ever earned, and the ledger's own checks make them
       * unpayable anyway. They are surfaced separately below.
       */
      unpaidOwnerMinor: rows
        .filter(
          (row) =>
            row.is_simulated !== true &&
            (row.payout_status ?? "").toLowerCase() !== "paid",
        )
        .reduce(
          (total, row) =>
            total + Math.round(Number(row.owner_net_amount ?? 0) * 100),
          0,
        ),
      /** Simulated owner share, in minor units. Never payable. */
      simulatedOwnerMinor: rows
        .filter((row) => row.is_simulated === true)
        .reduce(
          (total, row) =>
            total + Math.round(Number(row.owner_net_amount ?? 0) * 100),
          0,
        ),
      simulatedCount: rows.filter((row) => row.is_simulated === true).length,
      discrepancyMinor: ledgerDiscrepancyMinor(rows),
      paidCount: rows.filter((row) => (row.payout_status ?? "").toLowerCase() === "paid")
        .length,
      pendingCount: rows.filter(
        (row) =>
          row.is_simulated !== true &&
          (row.payout_status ?? "").toLowerCase() !== "paid",
      ).length,
    };
  }, [rows]);

  return {
    rows,
    totals,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Per-site rollup, used by the commissions page summary table. */
export function useCommissionBySite(options?: { from?: string; to?: string }) {
  const { rows, isLoading, error, refetch } = useCommissions(options);

  const bySite = useMemo(() => {
    const buckets = new Map<
      string,
      {
        siteId: string;
        siteName: string;
        grossMinor: number;
        feeMinor: number;
        ownerMinor: number;
        rows: number;
        unpaidOwnerMinor: number;
      }
    >();

    for (const row of rows) {
      const key = row.site_id;
      const bucket =
        buckets.get(key) ??
        {
          siteId: key,
          siteName: row.site?.name ?? "Unknown site",
          grossMinor: 0,
          feeMinor: 0,
          ownerMinor: 0,
          rows: 0,
          unpaidOwnerMinor: 0,
        };

      bucket.grossMinor += Math.round(Number(row.gross_markup_amount ?? 0) * 100);
      bucket.feeMinor += Math.round(Number(row.superuser_fee_amount ?? 0) * 100);
      bucket.ownerMinor += Math.round(Number(row.owner_net_amount ?? 0) * 100);
      bucket.rows += 1;
      if ((row.payout_status ?? "").toLowerCase() !== "paid") {
        bucket.unpaidOwnerMinor += Math.round(
          Number(row.owner_net_amount ?? 0) * 100,
        );
      }

      buckets.set(key, bucket);
    }

    return [...buckets.values()].sort((a, b) => b.grossMinor - a.grossMinor);
  }, [rows]);

  return { bySite, rows, isLoading, error, refetch };
}
