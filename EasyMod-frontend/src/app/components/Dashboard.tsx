/**
 * /dashboard — guardrails-compliant operational console.
 * Slim orchestrator: data (useDashboardData), pure derivation (derive), and
 * page-scoped contract components. Setup gating, polling cadence, coverage
 * honesty and deep links are preserved from the baseline; presentation follows
 * EasyModerator-UI-UX-Guardrails.md (screen anatomy §5, signals §8, one primary
 * action §11, states §16, dashboard template §21.1).
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
  derivePrimaryAction,
  deriveSignal,
  hasAllWorkSources,
  isCaughtUp,
} from "./dashboard/derive";
import { AttentionQueue } from "./dashboard/AttentionQueue";
import { CourierSnapshot } from "./dashboard/CourierSnapshot";
import { DashboardSkeleton } from "./dashboard/DashboardSkeleton";
import { EmButton } from "./dashboard/EmButton";
import { EvidenceFooter } from "./dashboard/EvidenceFooter";
import { OverviewCards } from "./dashboard/OverviewCards";
import { PageHeader } from "./dashboard/PageHeader";
import { QueueSignalChips } from "./dashboard/QueueSignalChips";
import { RecentOrders } from "./dashboard/RecentOrders";
import { ResultBanner } from "./dashboard/ResultBanner";
import type { Action, DashboardPhase } from "./dashboard/types";

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
  const signal = deriveSignal(deriveInput, t);
  const narrative = deriveNarrative(deriveInput, t, { lastSyncLabel: formatTime || undefined });

  const primaryAction: Action = { ...derivePrimaryAction(deriveInput, t) };
  if (phase === "pulse-error") {
    primaryAction.onClick = () => refreshPulse(true);
  }
  const refreshAction: Action = { label: t("dashboard.pulse.refresh"), onClick: () => refreshAll(false) };

  // Single context crumb (shop name): the h1 is the only "Today's work" node —
  // repeating the title here would break strict-mode text queries.
  const shopName = authService.getCurrentShop()?.shop_name;
  const breadcrumb = [{ label: shopName || t("dashboard.pulse.context.workspace") }];

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
          <PageHeader
            title={t("dashboard.pulse.title")}
            breadcrumb={breadcrumb}
            signal={signal}
            whyHere={narrative.whyHere}
            primaryAction={primaryAction}
            secondaryActions={[refreshAction]}
          />
          <ResultBanner
            status="error"
            title={t("dashboard.pulse.errorTitle")}
            description={error ?? t("dashboard.pulse.errorMsg")}
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
            <motion.div variants={fadeUp}>
              <PageHeader
                title={t("dashboard.pulse.title")}
                breadcrumb={breadcrumb}
                signal={signal}
                whyHere={narrative.whyHere}
                primaryAction={primaryAction}
                secondaryActions={[refreshAction]}
              />
            </motion.div>

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
                unread={pulseData.unreadCount}
                pendingPayment={pulseData.pendingPaymentCount}
                readyToDispatch={pulseData.readyToDispatchCount}
              />
            </motion.div>

            <motion.div variants={fadeUp}>
              <AttentionQueue groups={workGroups} hasAllWorkSources={coverageComplete} caughtUp={caughtUp} />
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
