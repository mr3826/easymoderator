/**
 * Page header (guardrails §24): context bar → title + dominant signal +
 * WHY HERE → primary action bar (WHAT NOW). signalTestId/primaryTestId/meta
 * are additive slots so other redesigned pages (inbox) reuse the anatomy
 * without forking it; defaults preserve the dashboard proof hooks.
 */
import type { ReactNode } from "react";
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
  /** Overview pages answer WHY HERE in the header; execution pages (guardrails
   *  §29) answer it inside the work area and omit this paragraph entirely. */
  whyHere?: string;
  primaryAction?: Action;
  secondaryActions?: Action[];
  loading?: boolean;
  signalTestId?: string;
  primaryTestId?: string;
  meta?: ReactNode;
  /** Inbox keeps role="status" reserved for thread-level claims; the header
   *  signal still announces politely through a live-region wrapper. */
  signalAnnounce?: boolean;
}

export function PageHeader({
  title,
  breadcrumb,
  signal,
  whyHere,
  primaryAction,
  secondaryActions,
  loading,
  signalTestId = "dashboard-signal",
  primaryTestId,
  meta,
  signalAnnounce = true,
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
        {signal && (signalAnnounce ? (
          <SignalBadge signal={signal} size="md" announce data-testid={signalTestId} />
        ) : (
          <span aria-live="polite">
            <SignalBadge signal={signal} size="md" data-testid={signalTestId} />
          </span>
        ))}
      </div>
      {whyHere && <p className="mt-1 max-w-[70ch] text-sm text-em-text-secondary">{whyHere}</p>}
      {meta && <div className="mt-3">{meta}</div>}
      {primaryAction && (
        <ActionBar
          className="mt-4"
          primaryAction={primaryAction}
          secondaryActions={secondaryActions}
          loading={loading}
          primaryTestId={primaryTestId}
        />
      )}
    </header>
  );
}
