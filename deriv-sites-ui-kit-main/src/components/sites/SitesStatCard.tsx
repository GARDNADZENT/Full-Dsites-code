import type { ElementType } from "react";
import { cn } from "@/lib/utils";

type Tone = "purple" | "emerald" | "amber" | "sky";

const TONES: Record<Tone, { icon: string; value: string; ring: string }> = {
  purple: {
    icon: "bg-purple-500/15 text-purple-300",
    value: "text-foreground",
    ring: "border-purple-500/20",
  },
  emerald: {
    icon: "bg-emerald-500/15 text-emerald-300",
    value: "text-emerald-300",
    ring: "border-emerald-500/20",
  },
  amber: {
    icon: "bg-amber-500/15 text-amber-300",
    value: "text-amber-300",
    ring: "border-amber-500/20",
  },
  sky: {
    icon: "bg-sky-500/15 text-sky-300",
    value: "text-foreground",
    ring: "border-sky-500/20",
  },
};

/**
 * Summary tile for the Sites page: label in small caps, big value, subtle icon.
 * Values are coloured only where the number carries a signal (deployed = good,
 * drafts = attention); neutrals stay neutral so colour keeps meaning.
 */
const SitesStatCard = ({
  label,
  value,
  icon: Icon,
  tone = "purple",
  caption,
}: {
  label: string;
  value: string | number;
  icon: ElementType;
  tone?: Tone;
  caption?: string;
}) => {
  const palette = TONES[tone];

  return (
    <div
      className={cn(
        "rounded-xl border bg-panel-bg p-4 transition-colors",
        palette.ring,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-lg",
            palette.icon,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className={cn("mt-3 text-2xl font-semibold leading-none", palette.value)}>
        {value}
      </p>
      {caption ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
};

export default SitesStatCard;
