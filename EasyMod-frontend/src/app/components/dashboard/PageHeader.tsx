/**
 * Page header (guardrails §24): context bar → title + dominant signal +
 * WHY HERE → primary action bar (WHAT NOW).
 */
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ActionBar } from "./ActionBar";
import { SignalBadge } from "./SignalBadge";
import type { Action, BreadcrumbItem, Signal } from "./types";

interface PageHeaderProps {
  title: string;
  breadcrumb: BreadcrumbItem[];
  signal?: Signal;
  whyHere: string;
  primaryAction?: Action;
  secondaryActions?: Action[];
  loading?: boolean;
}

export function PageHeader({
  title,
  breadcrumb,
  signal,
  whyHere,
  primaryAction,
  secondaryActions,
  loading,
}: PageHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="mb-6">
      {breadcrumb.length > 0 && (
        <nav aria-label={t("dashboard.pulse.context.breadcrumb")} className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs font-medium text-em-text-secondary">
            {breadcrumb.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex items-center gap-1">
                {index > 0 && <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                {item.to ? (
                  <Link to={item.to} className="rounded hover:text-em-violet-700 hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span aria-current={index === breadcrumb.length - 1 ? "page" : undefined}>{item.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-em-text-primary">{title}</h1>
        {signal && <SignalBadge signal={signal} size="md" announce data-testid="dashboard-signal" />}
      </div>
      <p className="mt-1 max-w-[70ch] text-sm text-em-text-secondary">{whyHere}</p>
      {primaryAction && (
        <ActionBar
          className="mt-4"
          primaryAction={primaryAction}
          secondaryActions={secondaryActions}
          loading={loading}
        />
      )}
    </header>
  );
}
