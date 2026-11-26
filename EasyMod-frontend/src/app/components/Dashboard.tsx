/**
 * /dashboard — guardrails-compliant operational console.
 * Slim orchestrator: data (useDashboardData), pure derivation (derive), and
 * page-scoped contract components. Setup gating, polling cadence, coverage
 * honesty and deep links are preserved from the baseline; presentation follows
 * EasyModerator-UI-UX-Guardrails.md (states §16, dashboard template §21.1).
 * The page-level signal header/action band is retired (header-removal C1/C2):
 * the sticky AppBar shows the page name, the h1 stays sr-only, and status lives
 * in the record-level modules (chips, queue, ConnectionHealth).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MotionConfig, motion } from "framer-motion";
import { fadeUp, staggerChildren } from "@/lib/motion";
import FirstTimeSetupDashboard from "./FirstTimeSetupDashboard";
import { useSetupStatus } from "@/app/lib/useSetupStatus";
import { authService } from "../lib/auth";
import { useDashboardData } from "./dashboard/useDashboardData";
import {
  buildWorkGroups,
  buildWorkItems,
  deriveNarrative,
  hasAllWorkSources,
  isCaughtUp,
} from "./dashboard/derive";
import { AttentionQueue } from "./dashboard/AttentionQueue";
import { BusinessHealth } from "./dashboard/BusinessHealth";
import { ConnectionHealth } from "./dashboard/ConnectionHealth";
import { CourierSnapshot } from "./dashboard/CourierSnapshot";
import { DashboardSkeleton } from "./dashboard/DashboardSkeleton";
import { EmButton } from "./dashboard/EmButton";
import { EvidenceFooter } from "./dashboard/EvidenceFooter";
import { OverviewCards } from "./dashboard/OverviewCards";
import { PageHeader } from "./dashboard/PageHeader";
import { QueueSignalChips, formatAccountingDay } from "./dashboard/QueueSignalChips";
import { RecentOrders } from "./dashboard/RecentOrders";
import { RecentActivity } from "./dashboard/RecentActivity";
import { ResultBanner } from "./dashboard/ResultBanner";
import type { DashboardPhase } from "./dashboard/types";

const SETUP_DASHBOARD_ENABLED = import.meta.env.VITE_ENABLE_FIRST_TIME_SETUP_DASHBOARD !== "false";
// Unit tests run without WAAPI; skip entrance animation there so content is
// immediately present. Real browsers animate once per phase mount.
const ANIMATE = import.meta.env.MODE !== "test";

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const setupStorageKeyPrefix = `easymod:business-setup:${authService.getCurrentShopId() || 'default'}`;
  const completionDismissedKey = `${setupStorageKeyPrefix}:complete-dismissed`;
  const [setupCompletionDismissed, setSetupCompletionDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(completionDismissedKey) === '1';
  });
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    error: setupError,
    refresh: refreshSetupStatus,
  } = useSetupStatus({ enabled: SETUP_DASHBOARD_ENABLED });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSetupCompletionDismissed(window.localStorage.getItem(completionDismissedKey) === '1');
  }, [completionDismissedKey]);

  const pulseEnabled = !SETUP_DASHBOARD_ENABLED || Boolean(setupError) || Boolean(setupStatus?.isComplete && setupCompletionDismissed);
  const {
    pulseData,
    courierSnapshot,
    lastUpdatedAt,
    isLoading,
    error,
    failedSourceNames,
    isStale,
    refreshPulse,
    refreshCourierSnapshot,
    refreshAll,
  } = useDashboardData(pulseEnabled);

  const locale = i18n?.language === "bn" ? "bn-BD" : "en-BD";
  const formatCurrency = useCallback((value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "BDT",
      maximumFractionDigits: 0,
    }).format(Number.isFinite(value) ? value : 0), [locale]);
  const formatCount = useCallback((value: number) => new Intl.NumberFormat(locale).format(value), [locale]);
  // A8 round-3 (MINOR-2): the charges card's UTC accounting day reaches the
  // chip through the same locale-bound Intl pattern as the counts/money.
  const formatDay = useCallback((dayUtc: string) => formatAccountingDay(dayUtc, locale), [locale]);

  const dismissSetupCompletion = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(completionDismissedKey, '1');
    }
    setSetupCompletionDismissed(true);
  };

  const formatTime = useMemo(() => {
    if (!lastUpdatedAt) return "";
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Dhaka",
    }).format(lastUpdatedAt);
  }, [lastUpdatedAt, locale]);

  let phase: DashboardPhase;
  if (SETUP_DASHBOARD_ENABLED && isSetupLoading && !setupStatus && !setupError) {
    phase = "setup-loading";
  } else if (SETUP_DASHBOARD_ENABLED && setupStatus && !setupStatus.isComplete) {
    phase = "setup";
  } else if (SETUP_DASHBOARD_ENABLED && setupStatus && setupStatus.isComplete && !setupCompletionDismissed) {
    phase = "setup-complete";
  } else if (isLoading) {
    phase = "pulse-loading";
  } else if (error) {
    phase = "pulse-error";
  } else {
    phase = "ready";
  }

  const workItems = useMemo(() => (pulseData ? buildWorkItems(pulseData, t) : []), [pulseData, t]);
  const workGroups = useMemo(() => buildWorkGroups(workItems, t), [workItems, t]);
  const coverageComplete = pulseData ? hasAllWorkSources(pulseData) : false;
  const caughtUp = pulseData ? isCaughtUp(pulseData, workItems) : false;
  const deriveInput = { phase, pulse: pulseData, workItems, caughtUp, hasAllWorkSources: coverageComplete };
  const narrative = deriveNarrative(deriveInput, t, { lastSyncLabel: formatTime || undefined });

  const shell = "em-dashboard min-h-full p-4 md:p-6";
  const inner = "mx-auto w-full max-w-[1440px]";

  if (phase === "setup-loading") {
    return (
      <div className={shell}>
        <div className={inner}>
          <DashboardSkeleton label={t("dashboard.setup.loading")} />
        </div>
      </div>
    );
  }

  if (phase === "setup" || phase === "setup-complete") {
    return (
      <FirstTimeSetupDashboard
        setupStatus={setupStatus!}
        onRefresh={refreshSetupStatus}
        onDismissCompletion={dismissSetupCompletion}
        storageKeyPrefix={setupStorageKeyPrefix}
      />
    );
  }

  if (phase === "pulse-loading") {
    return (
      <div className={shell}>
        <div className={inner}>
          <DashboardSkeleton />
        </div>
      </div>
    );
  }

  if (phase === "pulse-error") {
    return (
      <div className={shell}>
        <div className={inner}>
          {/* C1 amendment: "Today's work" is NOT the AppBar's name ("Home"),
              so the compact title stays visible — same rule as the ready state. */}
          <PageHeader title={t("dashboard.pulse.title")} titleMode="compact" />
          <ResultBanner
            status="error"
            className="mb-3"
            title={t("dashboard.pulse.errorTitle")}
            description={error ?? t("dashboard.pulse.errorMsg")}
          />
          {/* C2: the error retry keeps EXACTLY ONE primary action, now anchored
              inside the error result region (it lived only in the retired
              header ActionBar before). Manual refresh lives in the footer. */}
          <EmButton
            variant="primary"
            action={{ label: t("dashboard.pulse.retry"), onClick: () => refreshPulse(true) }}
            data-testid="dashboard-primary-action"
          />
          <EvidenceFooter
            provenResult={narrative.provenResult}
            whereNext={narrative.whereNext}
            isStale={false}
            coverageComplete={false}
            onRefresh={() => refreshAll(false)}
          />
        </div>
      </div>
    );
  }

  if (!pulseData) {
    return null;
  }

  const inTransitCount = pulseData.cashPosition?.inTransit?.count ?? null;

  return (
    <div className={shell}>
      <div className={inner}>
        <MotionConfig reducedMotion="user">
          <motion.div
            variants={staggerChildren}
            initial={ANIMATE ? "hidden" : false}
            animate="visible"
          >
            {/* C1 amendment (unified title rule): srOnly is legal ONLY when the
                h1 text equals the AppBar name — "Today's work" ≠ "Home", so the
                h1 renders as a compact visible title. No signal band, no
                why-here summary, no action band; the work items and their CTAs
                live in AttentionQueue below. */}
            <PageHeader title={t("dashboard.pulse.title")} titleMode="compact" />

            {SETUP_DASHBOARD_ENABLED && Boolean(setupError) && (
              <div
                role="status"
                className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-em-warning-700/20 bg-em-warning-100 p-3 text-sm text-em-warning-700"
              >
                <span>{t("dashboard.setup.stateUnavailable", { defaultValue: "Setup status is unavailable." })}</span>
                <EmButton variant="ghost" onClick={() => void refreshSetupStatus()} className="min-h-11 px-2 underline">
                  {t("dashboard.pulse.retry")}
                </EmButton>
              </div>
            )}

            {failedSourceNames.length > 0 && (
              <div
                role="status"
                className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-em-warning-700/20 bg-em-warning-100 p-3 text-sm text-em-warning-700"
              >
                <span>{t("dashboard.pulse.partialFail", { sources: failedSourceNames.join(", ") })}</span>
                <EmButton variant="ghost" onClick={() => refreshAll(false)} className="min-h-11 px-2 underline">
                  {t("dashboard.pulse.retry")}
                </EmButton>
              </div>
            )}

            <motion.div variants={fadeUp}>
              <QueueSignalChips
                needsReply={pulseData.needsReply}
                pendingPayment={pulseData.pendingPaymentCount}
                readyToDispatch={pulseData.readyToDispatchCount}
                billing={pulseData.commerceSignals?.deliveredCharges ?? null}
                formatCount={formatCount}
                formatDay={formatDay}
                formatMoney={(amount) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'BDT', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}
              />
            </motion.div>

            <motion.div variants={fadeUp} className="grid grid-cols-1 items-start gap-x-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <AttentionQueue groups={workGroups} hasAllWorkSources={coverageComplete} caughtUp={caughtUp} formatCount={formatCount} />
              <RecentActivity activity={pulseData.commerceSignals?.recentActivity ?? null} locale={locale} />
            </motion.div>

            <motion.div variants={fadeUp}>
              <OverviewCards
                ordersToday={pulseData.ordersToday}
                cashPosition={pulseData.cashPosition}
                chartData={pulseData.chartData}
                formatCurrency={formatCurrency}
                formatCount={formatCount}
              />
            </motion.div>

            {/* D7/D8 business + connection modules (overview anatomy band). */}
            <motion.div variants={fadeUp} className="grid grid-cols-1 items-start gap-x-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <BusinessHealth
                stockExceptions={pulseData.stockExceptions}
                deliveryExceptionCount={pulseData.worklistNeedsActionCount}
                cashPosition={pulseData.cashPosition}
                formatCount={formatCount}
                formatCurrency={formatCurrency}
              />
              <ConnectionHealth />
            </motion.div>

            <motion.div variants={fadeUp}>
              <RecentOrders orders={pulseData.lastFiveOrders} formatCurrency={formatCurrency} />
            </motion.div>

            <motion.div variants={fadeUp}>
              <CourierSnapshot
                snapshot={courierSnapshot}
                inTransitCount={inTransitCount}
                locale={locale}
                onRetry={() => void refreshCourierSnapshot()}
              />
            </motion.div>

            <motion.div variants={fadeUp}>
              <EvidenceFooter
                provenResult={narrative.provenResult}
                whereNext={narrative.whereNext}
                isStale={isStale}
                coverageComplete={coverageComplete}
                onRefresh={() => refreshAll(false)}
              />
            </motion.div>
          </motion.div>
        </MotionConfig>
      </div>
    </div>
  );
}
