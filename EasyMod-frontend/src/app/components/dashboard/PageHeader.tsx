/**
 * Slim page title (header-removal contract C1): optional breadcrumb → ONE h1 →
 * optional record-level meta row. The permanent page-level signal badge,
 * explanatory summary and action band are RETIRED on every merchant page —
 * do not re-add them here or at any call site (docs/header-removal/03_CONTRACT.md).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BreadcrumbItem } from "./types";

interface PageHeaderProps {
  title?: string;
  /**
   * 'compact' renders a visible small heading — required on record pages and
   * anywhere the sticky AppBar does not show the same name. 'srOnly' keeps the
   * h1 in the accessibility tree while the AppBar owns the visible title.
   */
  titleMode?: "compact" | "srOnly";
  breadcrumb?: BreadcrumbItem[];
  /** Record-level/contextual status only — never a global shop pulse. */
  meta?: ReactNode;
}

export function PageHeader({ title, titleMode = "compact", breadcrumb, meta }: PageHeaderProps) {
  const { t } = useTranslation();
  if (!title && (!breadcrumb || breadcrumb.length === 0) && !meta) return null;
  return (
    <header className="mb-3">
      {breadcrumb && breadcrumb.length > 0 && (
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
      {title && (
        <h1 className={titleMode === "srOnly" ? "sr-only" : "text-lg font-semibold text-em-text-primary"}>
          {title}
        </h1>
      )}
      {meta && <div className="mt-1">{meta}</div>}
    </header>
  );
}
