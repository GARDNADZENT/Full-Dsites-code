import { cn } from "@/lib/utils";
import type { OperationalState } from "@/lib/site-status";

/**
 * Status pill used on site cards and the site header.
 *
 * Deliberately worded in operator language ("Deployed", "Needs attention")
 * rather than database language ("active", "failed"), because the point of the
 * pill is to answer "is my site working?" at a glance.
 */
const StatusPill = ({
  state,
  className,
}: {
  state: OperationalState;
  className?: string;
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
      state.tone,
      className,
    )}
  >
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        state.key === "deployed" && "bg-emerald-400",
        state.key === "provisioning" && "bg-sky-400 animate-pulse",
        state.key === "failed" && "bg-red-400",
        state.key === "draft" && "bg-amber-400",
      )}
    />
    {state.label}
  </span>
);

export default StatusPill;
