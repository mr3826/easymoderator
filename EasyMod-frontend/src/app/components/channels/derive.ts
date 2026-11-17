/**
 * Pure channels-workspace signal derivation (guardrails §8/§29). One dominant
 * signal: can customers reach this shop on Messenger right now? Per-channel
 * detail stays in the cards; the header carries only facts. Key names avoid the
 * legacy pinned phrases ("Channels could not load", "No channels connected") so
 * real-i18n singular assertions never collide with the header signal.
 */
import type { Signal } from "../dashboard/types";

export interface ChannelsDeriveInput {
  phase: "loading" | "error" | "ready";
  connectedCount: number;
  stopActive: boolean;
}

export type ChannelsTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveChannelsSignal(input: ChannelsDeriveInput, t: ChannelsTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.channels.signal.blocked"),
      reason: t("manageShop.channels.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.channels.signal.pending") };
  }
  if (input.stopActive) {
    return {
      kind: "attention",
      label: t("manageShop.channels.signal.stopped"),
      reason: t("manageShop.channels.signal.reason.stopActive"),
    };
  }
  if (input.connectedCount > 0) {
    return {
      kind: "healthy",
      label: t("manageShop.channels.signal.healthy"),
      reason: t("manageShop.channels.signal.reason.connectedCount", { count: input.connectedCount }),
    };
  }
  return {
    kind: "attention",
    label: t("manageShop.channels.signal.attention"),
    reason: t("manageShop.channels.signal.reason.noChannels"),
  };
}
