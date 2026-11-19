/**
 * PROVEN RESULT + WHERE NEXT (guardrails §4/§5/§21.1). Page-level evidence
 * strip: last sync (polite live region), coverage honesty, stale warning, and
 * real next-step links. Deviation from §24 EvidencePanel (item-detail shaped)
 * documented in the PR body.
 */
import { Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmButton } from "./EmButton";

interface EvidenceFooterProps {
  provenResult: string;
  whereNext: string;
  isStale: boolean;
  coverageComplete: boolean;
  onRefresh: () => void;
}

export function EvidenceFooter({ provenResult, whereNext, isStale, coverageComplete, onRefresh }: EvidenceFooterProps) {
  const { t } = useTranslation();
  return (
    <footer className="mt-6">
      {isStale && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-em-warning-700/20 bg-em-warning-100 p-3 text-sm text-em-warning-700"
        >
          <span className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("dashboard.pulse.staleWarning")}
          </span>
          <EmButton variant="secondary" onClick={onRefresh} className="min-h-11 px-3">
            {t("dashboard.pulse.refresh")}
          </EmButton>
        </div>
      )}
      <div className="rounded-xl border border-em-border bg-em-bg-surface p-4">
        <h2 className="text-sm font-semibold text-em-text-primary">{t("dashboard.pulse.evidence.title")}</h2>
        <p aria-live="polite" className="em-tabular mt-1 text-xs font-medium text-em-text-secondary">
          {provenResult}
        </p>
        <p className="mt-1 text-xs text-em-text-secondary">
          {coverageComplete ? t("dashboard.pulse.evidence.coverageComplete") : t("dashboard.pulse.work.coverageNote")}
        </p>
        <p className="mt-1 text-xs text-em-text-secondary">{t("dashboard.pulse.liveUpdate")}</p>
        <p className="mt-3 text-sm text-em-text-secondary">{whereNext}</p>
        <nav aria-label={t("dashboard.pulse.evidence.nextSteps")} className="mt-2">
          <ul className="flex flex-wrap items-center gap-2">
            <li>
              <Link
                to="/orders"
                className="inline-flex min-h-11 items-center rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted"
              >
                {t("dashboard.pulse.attention.openOrders")}
              </Link>
            </li>
            <li>
              <Link
                to="/audit-logs"
                className="inline-flex min-h-11 items-center rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted"
              >
                {t("dashboard.pulse.evidence.auditLog")}
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
