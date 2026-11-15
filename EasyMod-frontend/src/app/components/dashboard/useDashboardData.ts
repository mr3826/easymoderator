/**
 * Dashboard data layer — extracted verbatim from the baseline Dashboard.tsx
 * (fetch fan-out, sequence guards, coverage honesty, polling cadence) so the
 * redesign changes presentation only. Adds the real queue aggregates that the
 * baseline fetched but dropped, and a stale-sync flag for the §21.1 warning.
 *
 * `t` must stay identity-stable (real react-i18next is); refreshPulse keeps
 * useCallback([t]) and the effect keeps its exact dependency shape — an
 * unstable dep re-fires polling and reintroduces documented test flakiness.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/api";
import { getErrorMessage } from "@shared/lib/http/errors";
import type { CourierSnapshotState, PulseData } from "./types";

const REPLY_PAGE_SIZE = 100;
const DRAFT_PAGE_SIZE = 100;
const EXCEPTION_SAMPLE_LIMIT = 10;
const COURIER_SAMPLE_LIMIT = 100;
/** 2.5 poll intervals — avoids flapping on one throttled background tick. */
const STALE_AFTER_MS = 150_000;
const STALE_CHECK_MS = 30_000;

const countOrNull = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

export function useDashboardData(enabled: boolean) {
  const { t } = useTranslation();
  const [pulseData, setPulseData] = useState<PulseData | null>(null);
  const [courierSnapshot, setCourierSnapshot] = useState<CourierSnapshotState>({ orders: null, isLoading: true });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSourceNames, setFailedSourceNames] = useState<string[]>([]);
  const [isStale, setIsStale] = useState(false);
  const requestSequenceRef = useRef(0);
  const courierRequestSequence = useRef(0);

  const refreshPulse = useCallback(async (isInitialLoad = false) => {
    const requestSequence = ++requestSequenceRef.current;
    if (isInitialLoad) setIsLoading(true);
    setError(null);

    try {
      const [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult] = await Promise.allSettled([
        apiClient.getDashboardMetrics(),
        apiClient.getDashboardQueue(),
        apiClient.getOrders({ order_status: "draft", page: 1, limit: DRAFT_PAGE_SIZE }),
        apiClient.getConversations({ page: 1, limit: REPLY_PAGE_SIZE }),
        apiClient.getOrders({ page: 1, limit: 5 }),
      ]);

      if (requestSequence !== requestSequenceRef.current) return;

      if (metricsResult.status === "rejected") console.error("Failed to load dashboard overview:", metricsResult.reason);
      if (queueResult.status === "rejected") console.error("Failed to load dashboard action counts:", queueResult.reason);
      if (draftsResult.status === "rejected") console.error("Failed to load Draft orders:", draftsResult.reason);
      if (conversationsResult.status === "rejected") console.error("Failed to load reply tasks:", conversationsResult.reason);
      if (latestOrdersResult.status === "rejected") console.error("Failed to load recent orders:", latestOrdersResult.reason);

      const results = [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult];
      const failedSources = [
        [metricsResult, "dashboard.pulse.sourceNames.overview"],
        [queueResult, "dashboard.pulse.sourceNames.actionCounts"],
        [draftsResult, "dashboard.pulse.sourceNames.drafts"],
        [conversationsResult, "dashboard.pulse.sourceNames.replies"],
        [latestOrdersResult, "dashboard.pulse.sourceNames.recentOrders"],
      ] as const;
      const nextFailedSources = failedSources
        .filter(([result]) => result.status === "rejected")
        .map(([, key]) => t(key));
      setFailedSourceNames(nextFailedSources);

      if (results.every((result) => result.status === "rejected")) {
        setPulseData(null);
        setError(t("dashboard.pulse.errorMsg"));
        setLastUpdatedAt(null);
        return;
      }

      if (!isInitialLoad && nextFailedSources.length > 0) {
        toast.warning(t("dashboard.pulse.partialFail", { sources: nextFailedSources.join(", ") }));
      }

      const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
      const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
      const drafts = draftsResult.status === 'fulfilled' ? draftsResult.value : null;
      const conversationPage = conversationsResult.status === 'fulfilled' ? conversationsResult.value : null;
      const atRiskOrders = Array.isArray(queue?.at_risk_orders) ? queue.at_risk_orders : null;

      setPulseData({
        ordersToday: countOrNull(metrics?.metrics?.ordersToday),
        replyTasks: conversationPage
          ? conversationPage.data.filter((conversation) => conversation.needs_merchant_reply === true)
          : null,
        replyTaskCoverageComplete: conversationPage
          ? conversationPage.page === 1 && conversationPage.total <= conversationPage.data.length
          : false,
        draftOrders: drafts,
        draftCoverageComplete: drafts !== null && drafts.length < DRAFT_PAGE_SIZE,
        atRiskOrders,
        exceptionCoverageComplete: atRiskOrders !== null && atRiskOrders.length < EXCEPTION_SAMPLE_LIMIT,
        lastFiveOrders: latestOrdersResult.status === "fulfilled" ? latestOrdersResult.value : null,
        cashPosition: metrics?.cashPosition ?? null,
        unreadCount: countOrNull(queue?.unread_count),
        pendingPaymentCount: countOrNull(queue?.pending_payment_count),
        readyToDispatchCount: countOrNull(queue?.ready_to_dispatch_count),
        chartData: metrics?.chartData ?? null,
      });
      setLastUpdatedAt(new Date());
    } catch (loadError: unknown) {
      if (requestSequence !== requestSequenceRef.current) return;
      const e = loadError as { response?: { data?: { error?: { message?: string } } } };
      setError(getErrorMessage(e, t("dashboard.pulse.errorMsg")));
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, [t]);

  const refreshCourierSnapshot = useCallback(async () => {
    const requestSequence = ++courierRequestSequence.current;
    setCourierSnapshot({ orders: null, isLoading: true });
    try {
      const orders = await apiClient.getOrders({ page: 1, limit: COURIER_SAMPLE_LIMIT });
      if (requestSequence !== courierRequestSequence.current) return;
      setCourierSnapshot({ orders: Array.isArray(orders) ? orders : [], isLoading: false });
    } catch (requestError) {
      if (requestSequence !== courierRequestSequence.current) return;
      console.error("Failed to load the recent courier order sample:", requestError);
      setCourierSnapshot({ orders: null, isLoading: false });
    }
  }, []);

  const refreshAll = useCallback((isInitialLoad = false) => {
    void refreshPulse(isInitialLoad);
    void refreshCourierSnapshot();
  }, [refreshCourierSnapshot, refreshPulse]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    refreshPulse(true);
    void refreshCourierSnapshot();
    const timer = window.setInterval(() => refreshPulse(false), 60000);
    // Order rows include customer and item details. Keep this broad sample on
    // entry/manual refresh and a slower cadence than the task sources.
    const courierTimer = window.setInterval(() => void refreshCourierSnapshot(), 300000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(courierTimer);
      requestSequenceRef.current += 1;
      courierRequestSequence.current += 1;
    };
  }, [refreshCourierSnapshot, refreshPulse, enabled]);

  // Stale-sync detection (§21.1): flips a boolean only, never re-fetches.
  useEffect(() => {
    setIsStale(false);
    if (!lastUpdatedAt) return;
    const check = () => setIsStale(Date.now() - lastUpdatedAt.getTime() > STALE_AFTER_MS);
    const id = window.setInterval(check, STALE_CHECK_MS);
    return () => window.clearInterval(id);
  }, [lastUpdatedAt]);

  return {
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
  };
}
