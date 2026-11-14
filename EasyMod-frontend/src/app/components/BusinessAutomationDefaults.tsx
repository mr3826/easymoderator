import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { apiClient } from "@/api";
import type { ShopAISettings } from "@/api/types/dashboard";
import type { TelegramNotificationStatus } from "@/api/types/notification";
import { authService } from "../lib/auth";
import AISettingsForm from "./AISettingsForm";
import EmergencyStopCard from "./channels/EmergencyStopCard";
import { Claim } from "./claims/Claim";
import { ClaimProvider } from "./claims/ClaimProvider";
import { getErrorMessage } from "@shared/lib/http/errors";

/**
 * Business automation defaults (ADR-0013 §9).
 *
 * This is the business-scope editor: the business mode is the ceiling that
 * channels can only narrow. The reply-settings form is the existing
 * AISettingsForm, hosted unchanged (fields and testids preserved). The
 * emergency-stop card (channels/EmergencyStopCard) is mounted below so the
 * business scope exposes the same bypass-proof stop as the channels overview.
 */
export default function BusinessAutomationDefaults() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<ShopAISettings | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramNotificationStatus | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortControllerRef.current = new AbortController();
    const load = async () => {
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
    };
    load();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleSaveAISettings = async (data: ShopAISettings) => {
    return apiClient.updateShopAISettings(data);
  };

  // Write controls are OWNER-only (ADR-0013 §9, matches the server's
  // requireOwner). The server stays the authority; this is UX only.
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  // While the emergency stop is active the backend locks automation to MANUAL
  // and rejects AUTO writes (409 EMERGENCY_STOP_ACTIVE), so the editor is
  // disabled until the owner resumes it from the card below.
  const emergencyStopActive = aiSettings?.emergency_stop?.active === true;

  return (
    <div className="ca-scope min-h-full bg-[var(--ca-surface-muted)] p-4 md:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <Link
            to="/manage-shop/channels"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ca-violet-deep)] hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("manageShop.automation.backToChannels")}
          </Link>
          <h1 className="text-xl font-bold text-[var(--ca-ink)] md:text-2xl">
            {t("manageShop.automation.title")}
          </h1>
          <p className="text-sm text-[var(--ca-ink-muted)]">{t("manageShop.automation.subtitle")}</p>
        </header>

        <ClaimProvider surface="subscription">
          <section
            data-testid="automation-billing-standing"
            className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-sunlight-soft)] p-4 text-sm text-[var(--ca-ink)]"
          >
            <p className="font-semibold">{t("manageShop.automation.billingStandingTitle")}</p>
            <p className="mt-1">
              <Claim id="billing.overdue_policy" surface="subscription" />
            </p>
            <Link
              to="/subscription"
              className="mt-1 inline-block font-semibold text-[var(--ca-violet-deep)] hover:underline"
            >
              {t("manageShop.automation.billingManage")}
            </Link>
          </section>

          <section className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-violet-soft)] p-4">
            <p className="text-sm font-semibold text-[var(--ca-ink)]">
              {t("manageShop.automation.capabilityTitle")}
            </p>
            <ul className="mt-1 space-y-1 text-sm text-[var(--ca-ink-muted)]">
              <li><Claim id="ai.draft_reply" surface="subscription" /></li>
              <li><Claim id="ai.auto_reply" surface="subscription" /></li>
            </ul>
          </section>

          {isLoading && (
            <div className="rounded-xl border border-[var(--ca-border)] bg-white p-6 text-sm text-[var(--ca-ink-muted)]" role="status">
              {t("manageShop.automation.loading")}
            </div>
          )}

          {!isLoading && loadError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {loadError}
            </div>
          )}

          {!isLoading && !loadError && (
            <>
              {emergencyStopActive && (
                <div
                  role="status"
                  data-testid="automation-emergency-stop-notice"
                  className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                >
                  {t("manageShop.automation.emergencyStopNotice")}
                </div>
              )}

              {!isOwner && (
                <div className="rounded-xl border border-[var(--ca-border)] bg-white p-4 text-sm text-[var(--ca-ink-muted)]">
                  {t("manageShop.automation.ownerOnly")}
                </div>
              )}

              <div className="rounded-xl border border-[var(--ca-border)] bg-white p-4 md:p-6">
                <fieldset
                  data-testid="automation-settings-fieldset"
                  disabled={!isOwner || emergencyStopActive}
                  className="min-w-0 border-0 p-0 disabled:opacity-70"
                >
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
        </ClaimProvider>
      </div>
    </div>
  );
}