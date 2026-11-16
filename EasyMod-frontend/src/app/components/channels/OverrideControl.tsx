/**
 * OverrideControl — the shared inherit/override shell for a single channel
 * setting (ADR-0013 §9, PROPOSED_ARCHITECTURE §4).
 *
 * Presentational only: the owning page supplies the effective value, the
 * inherit/override state and the mutation callbacks. Editing is OWNER-only,
 * matching the server's requireOwner; read-only surfaces show an accurate
 * reason instead of a disabled control with no explanation.
 */
import { forwardRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export interface OverrideControlProps {
  label: string;
  /** True when an explicit channel override is stored. */
  overridden: boolean;
  canEdit: boolean;
  readOnlyReason?: string;
  /** Rendered effective value (already resolved by the server). */
  effective: ReactNode;
  /** Literal source badge text (Inherited / Overridden / Clamped / …). */
  source?: ReactNode;
  onStartOverride: () => void;
  onRevert: () => void;
  revertTestId?: string;
  saving?: boolean;
  error?: string | null;
  /** The editor shown while an override is stored. */
  children: ReactNode;
}

export const OverrideControl = forwardRef<HTMLDivElement, OverrideControlProps>(
  function OverrideControl(
    {
      label,
      overridden,
      canEdit,
      readOnlyReason,
      effective,
      source,
      onStartOverride,
      onRevert,
      revertTestId,
      saving = false,
      error,
      children,
    },
    ref,
  ) {
    const { t } = useTranslation();
    return (
      <section
        ref={ref}
        tabIndex={-1}
        className="rounded-xl border border-em-border bg-em-bg-surface p-4 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-em-text-primary">{label}</h3>
            <p className="mt-1 text-xs text-em-text-secondary">
              {t("manageShop.channels.detail.effective")}:{" "}
              <span className="font-medium text-em-text-primary">{effective}</span>
            </p>
            {source && (
              <p className="mt-0.5 text-xs text-em-text-secondary">
                {t("manageShop.channels.detail.source")}: {source}
              </p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              overridden
                ? "bg-em-violet-100 text-em-violet-700"
                : "bg-em-bg-muted text-em-text-secondary"
            }`}
          >
            {overridden
              ? t("manageShop.channels.detail.overridden")
              : t("manageShop.channels.detail.inherited")}
          </span>
        </div>

        {!canEdit && (
          <p className="mt-2 text-xs text-em-text-secondary" data-testid="channel-read-only-reason">
            {readOnlyReason || t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}

        {canEdit && !overridden && (
          <button
            type="button"
            onClick={onStartOverride}
            disabled={saving}
            className={`mt-3 inline-flex min-h-11 items-center rounded-lg border border-em-violet-600 px-3 py-1.5 text-xs font-semibold text-em-violet-700 hover:bg-em-violet-50 disabled:opacity-60 ${FOCUS_RING}`}
          >
            {t("manageShop.channels.detail.startOverride")}
          </button>
        )}

        {canEdit && overridden && (
          <div className="mt-3 space-y-3">
            {children}
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={revertTestId}
                onClick={onRevert}
                disabled={saving}
                className={`inline-flex min-h-11 items-center rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-1.5 text-xs font-medium text-em-text-primary hover:bg-em-bg-muted disabled:opacity-60 ${FOCUS_RING}`}
              >
                {t("manageShop.channels.detail.revert")}
              </button>
              {saving && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1 text-xs text-em-text-secondary"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t("manageShop.channels.detail.saving")}
                </span>
              )}
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2 text-xs text-em-danger-700">
            {error}
          </p>
        )}
      </section>
    );
  },
);
