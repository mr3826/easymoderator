/**
 * Pure notification-channel signal derivation (guardrails §8/§29). One
 * dominant signal for the page: can the merchant receive alerts right now?
 * Channel-specific detail stays in the panels and factual pills.
 */
import type { Signal } from "../dashboard/types";
import type { TelegramNotificationStatus } from "@/api/types/notification";

export interface NotificationDeriveInput {
  phase: "loading" | "error" | "ready";
  telegram: TelegramNotificationStatus | null;
}

export type NotificationTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveNotificationSignal(
  input: NotificationDeriveInput,
  t: NotificationTranslate,
): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.notifications.signal.blocked"),
      reason: t("manageShop.notifications.signal.reason.error"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.notifications.signal.pending") };
  }
  const telegram = input.telegram;
  if (!telegram || !telegram.configured) {
    return {
      kind: "attention",
      label: t("manageShop.notifications.signal.attention"),
      reason: t("manageShop.notifications.signal.reason.notConfigured"),
    };
  }
  if (telegram.connected) {
    return {
      kind: "healthy",
      label: t("manageShop.notifications.signal.healthy"),
      reason: t("manageShop.notifications.signal.reason.connected"),
    };
  }
  if (telegram.status === "pending") {
    return {
      kind: "pending",
      label: t("manageShop.notifications.signal.waiting"),
      reason: t("manageShop.notifications.signal.reason.pending"),
    };
  }
  if (telegram.status === "unhealthy") {
    return {
      kind: "attention",
      label: t("manageShop.notifications.signal.attention"),
      reason: t("manageShop.notifications.signal.reason.unhealthy"),
    };
  }
  return {
    kind: "attention",
    label: t("manageShop.notifications.signal.attention"),
    reason: t("manageShop.notifications.signal.reason.disconnected"),
  };
}
