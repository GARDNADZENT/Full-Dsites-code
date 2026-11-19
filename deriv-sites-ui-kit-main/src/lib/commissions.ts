/**
 * Money maths for the platform commission split.
 *
 * Rules that this module exists to enforce:
 *
 *  1. **Integer cents only.** Every amount is handled as an integer number of
 *     minor units inside the calculation. Floating-point dollars accumulate
 *     rounding error across thousands of ledger rows; cents do not.
 *  2. **Nothing is lost.** The owner's share is computed as `gross - fee`, never
 *     as `gross * (1 - feeRate)`. Two independently rounded halves can fail to
 *     add back up to the original; deriving the remainder cannot.
 *  3. **Unrounded values stay visible.** We return the exact pre-rounding fee so a
 *     future reconciliation can see where a cent went, rather than inferring it.
 *
 * These numbers are display-only. The authoritative split is written into
 * `site_commission_ledger` by the backend; this module must never be used to
 * write money to the database.
 */

/** A percentage rate, e.g. 17 means 17%. Accepts numeric strings from Postgres. */
export type RatePercent = number | string | null | undefined;

export type MoneySplit = {
  /** Gross markup earned, in the ledger currency's minor units. */
  grossMinor: number;
  /** Platform/superuser cut, rounded to the nearest minor unit. */
  feeMinor: number;
  /** Owner's remainder. Exactly `grossMinor - feeMinor`. */
  ownerMinor: number;
  /** Fee before rounding, for reconciliation. Not for display as currency. */
  feeExact: number;
  /** The rate actually applied, normalised to 0–100. Null when not provided. */
  appliedRate: number | null;
};

const toNumber = (value: RatePercent, fallback = 0): number => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Convert a decimal money value to integer minor units without float drift.
 *
 * `Math.round(12.345 * 100)` is 1235 because the intermediate is 1234.4999…;
 * going through `toFixed` on the decimal string avoids that class of error for
 * values that arrive as strings from Postgres numeric columns.
 */
export function toMinorUnits(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  // Round the decimal string, not the float product, then parse back to integer.
  const fixed = numeric.toFixed(2);
  return Math.round(Number(fixed) * 100);
}

/** Inverse of {@link toMinorUnits}; for display and for writing back. */
export function fromMinorUnits(minor: number): number {
  return Math.round(minor) / 100;
}

/**
 * Format integer minor units for display.
 *
 * Uses `Intl.NumberFormat` so thousands separators and currency symbols follow
 * the viewer's locale, and `minimumFractionDigits: 2` so `5` renders as `5.00`
 * rather than looking like a different magnitude.
 */
export function formatMinorUnits(
  minor: number,
  currency = "USD",
  locale = "en-US",
): string {
  const value = fromMinorUnits(minor);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Unknown currency code — fall back to a plain number plus the code.
    return `${value.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency}`;
  }
}

/**
 * Split a gross markup into platform fee and owner remainder.
 *
 * `feeRate` is clamped to 0–100. A negative or absurd rate would otherwise produce
 * a negative owner share (i.e. the owner owing the platform), which is never a
 * valid outcome of this business rule.
 */
export function splitCommission(
  gross: number | string | null | undefined,
  feeRate: RatePercent,
): MoneySplit {
  const grossMinor = toMinorUnits(gross);

  const rawRate = toNumber(feeRate, 0);
  const appliedRate = Math.min(100, Math.max(0, rawRate));

  // Work in minor units so the rounding point is the cent, not the dollar.
  const feeExactMinor = (grossMinor * appliedRate) / 100;
  const feeMinor = Math.round(feeExactMinor);

  return {
    grossMinor,
    feeMinor,
    // Derived, never computed independently — guarantees the two halves add up.
    ownerMinor: grossMinor - feeMinor,
    feeExact: feeExactMinor,
    appliedRate,
  };
}

/**
 * Aggregate split across many ledger rows.
 *
 * Sums the stored per-row amounts rather than recomputing from rates: the ledger is
 * the record of what was actually applied at the time, and rates can change later.
 * Recomputing would silently rewrite history.
 */
export function aggregateLedger(
  rows: Array<{ gross_markup_amount?: number | string | null; superuser_fee_amount?: number | string | null; owner_net_amount?: number | string | null }>,
): { grossMinor: number; feeMinor: number; ownerMinor: number } {
  let grossMinor = 0;
  let feeMinor = 0;
  let ownerMinor = 0;

  for (const row of rows) {
    grossMinor += toMinorUnits(row.gross_markup_amount);
    feeMinor += toMinorUnits(row.superuser_fee_amount);
    ownerMinor += toMinorUnits(row.owner_net_amount);
  }

  return { grossMinor, feeMinor, ownerMinor };
}

/**
 * True when the stored rows do not add up.
 *
 * Ledgers drift when a writer computes the owner share independently, or when a
 * row is edited after the fact. Surfacing the discrepancy is better than showing a
 * total that quietly double-counts or loses cents.
 */
export function ledgerDiscrepancyMinor(rows: Parameters<typeof aggregateLedger>[0]): number {
  const { grossMinor, feeMinor, ownerMinor } = aggregateLedger(rows);
  return grossMinor - (feeMinor + ownerMinor);
}

export type PayoutStatus = "paid" | "pending" | "processing" | "unknown";

export function normalizePayoutStatus(raw?: string | null): PayoutStatus {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("paid")) return "paid";
  if (value.includes("process")) return "processing";
  if (value.includes("pending") || value.includes("unpaid") || value === "") {
    return "pending";
  }
  return "unknown";
}

export const PAYOUT_TONES: Record<PayoutStatus, string> = {
  paid: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  processing: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  unknown: "bg-white/5 text-muted-foreground border-white/10",
};
