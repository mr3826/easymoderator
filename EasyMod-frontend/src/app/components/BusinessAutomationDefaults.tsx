import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MotionConfig, motion } from "motion/react";
import { apiClient } from "@/api";
import type { ShopAISettings } from "@/api/types/dashboard";
import { normalizeAiReplyMode } from "@/api/types/conversation";
import type { TelegramNotificationStatus } from "@/api/types/notification";
import { fadeUp } from "@/lib/motion";
import { authService } from "../lib/auth";
import AISettingsForm from "./AISettingsForm";
import EmergencyStopCard from "./channels/EmergencyStopCard";
import { MODE_LABEL_KEYS } from "./channels/channelAutomation";
import { Claim } from "./claims/Claim";
import { ClaimProvider } from "./claims/ClaimProvider";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { deriveAutomationSignal } from "./automation/derive";
import { getErrorMessage } from "@shared/lib/http/errors";

const ANIMATE = import.meta.env.MODE !== "test";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const PILL_CLASS =
  "em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary";

/**
 * Business automation defaults (ADR-0013 §9).
 *
 * This is the business-scope editor: the business mode is the ceiling that
 * channels can only narrow. The reply-settings form is the existing
 * AISettingsForm, hosted with its fields and testids preserved. The
 * emergency-stop card (channels/EmergencyStopCard) is mounted below so the
 * business scope exposes the same bypass-proof stop as the channels overview.
 *
 * Execution-page header (guardrails §29): title + one dominant signal + two
 * factual pills. No WHY HERE paragraph and no header CTA — the merchant edits
 * inside the work area, and the subtitle lives there too.
 */
export default function BusinessAutomationDefaults() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<ShopAISettings | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramNotificationStatus | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortControllerRef.current = new AbortController();
    try {
      setIsLoading(true);
      setLoadError(null);
      const [aiData, telegramData] = await Promise.all([
        apiClient.getShopAISettings(),
        apiClient.getTelegramNotificationStatus().catch(() => null),
      ]);
      if (!abortControllerRef.current?.signal.aborted) {
        setAiSettings(aiData);
        setTelegramStatus(telegramData);
      }
    } catch (error: any) {
      if (!abortControllerRef.current?.signal.aborted) {
        setLoadError(getErrorMessage(error, t("manageShop.automation.errorLoad")));
      }
    } finally {
      if (!abortControllerRef.current?.signal.aborted) {
        setIsLoading(false);
      }
    }
    // Mount-once: `t` is a stable translator and re-running on language change
    // would refetch settings the merchant may be editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [load]);

  // Adopt the persisted settings so the header pills/signal never describe a
  // mode the server has already replaced. The form keeps its own copy.
  const handleSaveAISettings = async (data: ShopAISettings) => {
    const persisted = await apiClient.updateShopAISettings(data);
    setAiSettings(persisted && Object.keys(persisted).length > 0 ? persisted : data);
    return persisted;
  };

  // Write controls are OWNER-only (ADR-0013 §9, matches the server's
  // requireOwner). The server stays the authority; this is UX only.
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  // While the emergency stop is active the backend locks automation to MANUAL
  // and rejects AUTO writes (409 EMERGENCY_STOP_ACTIVE), so the editor is
  // disabled until the owner resumes it from the card below.
  const emergencyStopActive = aiSettings?.emergency_stop?.active === true;
  const mode = normalizeAiReplyMode(aiSettings?.automation_mode);
  const ready = !isLoading && !loadError && aiSettings !== null;

  const signal = deriveAutomationSignal(
    {
      phase: loadError ? "error" : isLoading ? "loading" : "ready",
      isOwner,
      stopActive: emergencyStopActive,
      mode,
    },
    t,
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-automation min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
            {/* Execution-page header (§29): title + signal + factual pills only. */}
            <PageHeader
              title={t("manageShop.automation.title")}
              breadcrumb={[
                { label: t("manageShop.channels.title"), to: "/manage-shop/channels" },
                { label: t("manageShop.automation.title") },
              ]}
              signal={signal}
              signalTestId="automation-signal"
              signalAnnounce={false}
              meta={ready ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className={PILL_CLASS}>
                    {t("manageShop.automation.modePillLabel")}: {t(MODE_LABEL_KEYS[mode])}
                  </span>
                  <span className={PILL_CLASS}>
                    {t("manageShop.automation.confidencePillLabel")}: {aiSettings?.confidence_threshold ?? 0}%
                  </span>
                </div>
              ) : undefined}
            />
          </motion.div>

          <p className="max-w-[70ch] text-sm text-em-text-secondary">
            {t("manageShop.automation.subtitle")}
          </p>

          <ClaimProvider surface="subscription">
            <div className="space-y-6">
              <section
                data-testid="automation-billing-standing"
                aria-labelledby="automation-billing-title"
                className="rounded-xl border border-em-sunlight-600/30 bg-em-sunlight-100 p-4 text-sm text-em-text-primary"
              >
                <h2 id="automation-billing-title" className="text-sm font-semibold">
                  {t("manageShop.automation.billingStandingTitle")}
                </h2>
                <p className="mt-1">
                  <Claim id="billing.overdue_policy" surface="subscription" />
                </p>
                <Link
                  to="/subscription"
                  className={`mt-1 inline-flex min-h-11 items-center font-semibold text-em-violet-700 hover:underline ${FOCUS_RING}`}
                >
                  {t("manageShop.automation.billingManage")}
                </Link>
              </section>

              <section
                aria-labelledby="automation-capability-title"
                className="rounded-xl border border-em-border bg-em-violet-50 p-4"
              >
                <h2 id="automation-capability-title" className="text-sm font-semibold text-em-text-primary">
                  {t("manageShop.automation.capabilityTitle")}
                </h2>
                <ul className="mt-1 space-y-1 text-sm text-em-text-secondary">
                  <li><Claim id="ai.draft_reply" surface="subscription" /></li>
                  <li><Claim id="ai.auto_reply" surface="subscription" /></li>
                </ul>
              </section>

              {isLoading && (
                <div role="status" className="space-y-3">
                  <span className="sr-only">{t("manageShop.automation.loading")}</span>
                  <div className="h-28 animate-pulse rounded-xl border border-em-border bg-em-bg-surface" />
                  <div className="h-64 animate-pulse rounded-xl border border-em-border bg-em-bg-surface" />
                </div>
              )}

              {!isLoading && loadError && (
                <div
                  role="alert"
                  className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4 text-sm text-em-danger-700"
                >
                  <p>{loadError}</p>
                  <EmButton variant="secondary" onClick={load} className="mt-3">
                    {t("manageShop.automation.retryLoad")}
                  </EmButton>
                </div>
              )}

              {ready && (
                <>
                  {emergencyStopActive && (
                    <div
                      role="status"
                      data-testid="automation-emergency-stop-notice"
                      className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4 text-sm text-em-danger-700"
                    >
                      {t("manageShop.automation.emergencyStopNotice")}
                    </div>
                  )}

                  {!isOwner && (
                    <div className="rounded-xl border border-em-border bg-em-bg-surface p-4 text-sm text-em-text-secondary">
                      {t("manageShop.automation.ownerOnly")}
                    </div>
                  )}

                  <div className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-6">
                    <fieldset
                      data-testid="automation-settings-fieldset"
                      disabled={!isOwner || emergencyStopActive}
                      className="min-w-0 border-0 p-0 disabled:opacity-70"
                    >
                      <legend className="sr-only">{t("manageShop.aiSettings.title")}</legend>
                      <AISettingsForm
                        initialData={aiSettings}
                        onSave={handleSaveAISettings}
                        telegramStatus={telegramStatus}
                      />
                    </fieldset>
                  </div>
                </>
              )}

              {/* Business-wide emergency stop (ADR-0013 §6) — same card as the channels overview. */}
              <div data-testid="emergency-stop-slot">
                <EmergencyStopCard />
              </div>
            </div>
          </ClaimProvider>
        </div>
      </div>
    </MotionConfig>
  );
}
