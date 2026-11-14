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
        className="rounded-xl border border-[var(--ca-border)] bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ca-violet)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--ca-ink)]">{label}</h3>
            <p className="mt-1 text-xs text-[var(--ca-ink-muted)]">
              {t("manageShop.channels.detail.effective")}:{" "}
              <span className="font-medium text-[var(--ca-ink)]">{effective}</span>
            </p>
            {source && (
              <p className="mt-0.5 text-xs text-[var(--ca-ink-soft)]">
                {t("manageShop.channels.detail.source")}: {source}
              </p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              overridden
                ? "bg-[var(--ca-violet-soft)] text-[var(--ca-violet-deep)]"
                : "bg-[var(--ca-surface-sunken)] text-[var(--ca-ink-muted)]"
            }`}
          >
            {overridden
              ? t("manageShop.channels.detail.overridden")
              : t("manageShop.channels.detail.inherited")}
          </span>
        </div>

        {!canEdit && (
          <p className="mt-2 text-xs text-[var(--ca-ink-soft)]" data-testid="channel-read-only-reason">
            {readOnlyReason || t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}

        {canEdit && !overridden && (
          <button
            type="button"
            onClick={onStartOverride}
            disabled={saving}
            className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-[var(--ca-violet)] px-3 py-1.5 text-xs font-semibold text-[var(--ca-violet-deep)] hover:bg-[var(--ca-violet-soft)] disabled:opacity-60"
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
                className="inline-flex min-h-9 items-center rounded-lg border border-[var(--ca-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-surface-muted)] disabled:opacity-60"
              >
                {t("manageShop.channels.detail.revert")}
              </button>
              {saving && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1 text-xs text-[var(--ca-ink-muted)]"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t("manageShop.channels.detail.saving")}
                </span>
              )}
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {error}
          </p>
        )}
      </section>
    );
  },
);