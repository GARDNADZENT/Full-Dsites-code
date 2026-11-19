import { Check, Circle, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  buildReadinessChecklist,
  computeReadinessScore,
  isStepComplete,
  type ReadinessInput,
} from "@/lib/site-status";

/**
 * Right-rail summary for the site editor.
 *
 * Everything shown here is derived from stored rows via `site-status.ts`, so the
 * score and the checklist can never contradict the rest of the app.
 */
const ReadinessPanel = ({ input }: { input: ReadinessInput }) => {
  const navigate = useNavigate();
  const steps = buildReadinessChecklist(input);
  const score = computeReadinessScore(input);
  const completed = steps.filter((step) => isStepComplete(step, input)).length;

  return (
    <aside className="w-full shrink-0 space-y-3 lg:w-72">
      <div className="rounded-xl border border-white/10 bg-panel-bg p-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              score === 100 ? "bg-emerald-400" : "bg-amber-400",
            )}
          />
          <p className="text-sm font-medium text-foreground">
            {score === 100
              ? "Live and active"
              : score >= 60
                ? "Almost there"
                : "Setup in progress"}
          </p>
        </div>
        {input.hostname ? (
          <a
            href={`https://${input.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            {input.hostname}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No domain yet</p>
        )}

        <div className="mt-4 flex items-baseline justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Configuration score
          </span>
          <span className="text-lg font-semibold text-foreground">{score}%</span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full gradient-purple transition-all duration-500"
            style={{ width: `${score}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {completed} of {steps.length} steps complete
        </p>
      </div>

      <div className="rounded-xl border border-white/10 bg-panel-bg p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Setup checklist
        </p>
        <ul className="mt-2 space-y-1.5">
          {steps.map((step) => {
            const done = isStepComplete(step, input);
            return (
              <li key={step.key}>
                <button
                  type="button"
                  onClick={() => step.href && navigate(step.href)}
                  className="flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left hover:bg-white/5"
                >
                  {done ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-xs",
                        done ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                    </span>
                    {step.detail ? (
                      <span className="block truncate text-[10px] text-muted-foreground/70">
                        {step.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded-xl border border-white/10 bg-panel-bg p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Shortcuts
        </p>
        <div className="mt-2 space-y-1.5">
          <button
            type="button"
            onClick={() => navigate(`/sites/${input.siteId}/config`)}
            className="w-full rounded-lg border border-white/10 px-3 py-2 text-xs text-foreground hover:bg-white/5"
          >
            Deployments
          </button>
          {input.hostname ? (
            <a
              href={`https://${input.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="block w-full rounded-lg border border-white/10 px-3 py-2 text-center text-xs text-foreground hover:bg-white/5"
            >
              Visit live site
            </a>
          ) : null}
        </div>
      </div>
    </aside>
  );
};

export default ReadinessPanel;
