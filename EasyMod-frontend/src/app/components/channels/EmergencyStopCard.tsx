/**
 * EmergencyStopCard — business-wide, bypass-proof AI stop (ADR-0013 §6).
 *
 * OWNER-only write controls (matching the server's requireOwner). The copy is
 * deliberately honest: human replies and draft approvals keep working, and a
 * provider call that already passed the boundary may still complete. The
 * confirm dialog traps focus and closes on Escape (guardrails §17/§18).
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, OctagonX, Play } from "lucide-react";
import {
  emergencyResume,
  emergencyStop,
  getShopAISettings,
} from "@/api/domains/shop";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import { useDialogFocus } from "../inbox/useDialogFocus";
import { MODE_LABEL_KEYS } from "./channelAutomation";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export default function EmergencyStopCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, confirmOpen);

  const settingsQuery = useQuery({
    queryKey: ["shop-ai-settings"],
    queryFn: getShopAISettings,
  });

  const emergency = settingsQuery.data?.emergency_stop;
  const stopActive = emergency?.active === true;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["shop-ai-settings"] });
    void queryClient.invalidateQueries({ queryKey: ["channels"] });
    void queryClient.invalidateQueries({ queryKey: ["channel-settings"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  const stopMutation = useMutation({
    mutationFn: () => emergencyStop(),
    onSuccess: () => {
      stayOpen(false);
      invalidate();
      toast.success(t("emergencyStop.activeTitle"));
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, t("emergencyStop.errorStop"))),
  });

  const resumeMutation = useMutation({
    mutationFn: () => emergencyResume(),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.prior_mode
          ? t("emergencyStop.priorMode", { mode: t(MODE_LABEL_KEYS[result.prior_mode]) })
          : t("emergencyStop.resumeNote"),
      );
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, t("emergencyStop.errorResume"))),
  });

  function stayOpen(next: boolean) {
    setConfirmOpen(next);
  }

  const busy = stopMutation.isPending || resumeMutation.isPending;
  const adminSource = emergency?.source === "admin";

  return (
    <section
      className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-5"
      aria-label={t("emergencyStop.title")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold text-em-text-primary">
            <OctagonX className="h-4 w-4 text-em-danger-700" aria-hidden="true" />
            {t("emergencyStop.title")}
          </h2>
          <p className="mt-1 text-sm text-em-text-secondary">{t("emergencyStop.subtitle")}</p>
        </div>
        {stopActive && (
          <span className="shrink-0 rounded-full bg-em-danger-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-em-danger-700">
            {t("manageShop.channels.badge.stopped")}
          </span>
        )}
      </div>

      {settingsQuery.isLoading && (
        <p role="status" className="mt-3 text-sm text-em-text-secondary">
          {t("common.loading")}
        </p>
      )}

      {settingsQuery.isError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-em-danger-100 p-3 text-sm text-em-danger-700">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("emergencyStop.errorStop")}</span>
          <button
            type="button"
            onClick={() => void settingsQuery.refetch()}
            className={`ml-auto shrink-0 font-semibold underline ${FOCUS_RING}`}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {!settingsQuery.isLoading && !settingsQuery.isError && (
        <>
          {stopActive && (
            <div
              role="alert"
              data-testid="emergency-stop-banner"
              className="mt-3 rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-3 text-sm text-em-danger-700"
            >
              <p className="font-semibold">{t("emergencyStop.activeTitle")}</p>
              <p className="mt-1">{t("emergencyStop.activeDesc")}</p>
              {emergency?.prior_mode && (
                <p className="mt-1 text-xs">
                  {t("emergencyStop.priorMode", {
                    mode: t(MODE_LABEL_KEYS[emergency.prior_mode]),
                  })}
                </p>
              )}
            </div>
          )}

          {!isOwner && (
            <p className="mt-3 text-xs text-em-text-secondary">{t("emergencyStop.ownerOnly")}</p>
          )}

          {isOwner && (
            <div className="mt-3">
              {!stopActive ? (
                <button
                  type="button"
                  data-testid="emergency-stop-button"
                  disabled={busy}
                  onClick={() => setConfirmOpen(true)}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-lg bg-em-danger-700 px-4 py-2 text-sm font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-60 ${FOCUS_RING}`}
                >
                  <OctagonX className="h-4 w-4" aria-hidden="true" />
                  {t("emergencyStop.stopButton")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="emergency-resume-button"
                    disabled={busy || adminSource}
                    onClick={() => resumeMutation.mutate()}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted disabled:opacity-60 ${FOCUS_RING}`}
                  >
                    {resumeMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="h-4 w-4" aria-hidden="true" />
                    )}
                    {t("emergencyStop.resumeButton")}
                  </button>
                  <p className="mt-1 text-xs text-em-text-secondary">
                    {adminSource ? t("emergencyStop.denyAdminSource") : t("emergencyStop.resumeNote")}
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}

      {confirmOpen && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="emergency-stop-confirm-title"
          onKeyDown={(e) => {
            if (e.key === "Escape") stayOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
        >
          <div className="w-full max-w-sm space-y-4 rounded-xl border border-em-border bg-em-bg-surface p-6 shadow-xl">
            <h3
              id="emergency-stop-confirm-title"
              className="text-lg font-semibold text-em-text-primary"
            >
              {t("emergencyStop.confirmTitle")}
            </h3>
            <p className="text-sm text-em-text-secondary">{t("emergencyStop.confirmDesc")}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => stayOpen(false)}
                className={`min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted ${FOCUS_RING}`}
              >
                {t("emergencyStop.cancel")}
              </button>
              <button
                type="button"
                disabled={stopMutation.isPending}
                onClick={() => stopMutation.mutate()}
                className={`inline-flex min-h-11 items-center gap-2 rounded-lg bg-em-danger-700 px-4 py-2 text-sm font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-60 ${FOCUS_RING}`}
              >
                {stopMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {t("emergencyStop.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
