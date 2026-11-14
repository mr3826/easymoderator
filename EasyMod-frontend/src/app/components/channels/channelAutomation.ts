/**
 * Shared, side-effect-free helpers for the channel automation surfaces
 * (ADR-0013 §3/§9). Kept small and literal so the UI cannot offer a widening
 * override or invent an effective state.
 */
import type {
  AiReplyMode,
  AiReplyModeSource,
  ChannelAutomationWarning,
  EmergencyStopState,
} from "@/api/types/conversation";

/** Restriction order: MANUAL > DRAFT > AUTO. */
export const MODE_RANK: Record<AiReplyMode, number> = {
  AUTO: 1,
  DRAFT: 2,
  MANUAL: 3,
};

export const ALL_MODES: AiReplyMode[] = ["AUTO", "DRAFT", "MANUAL"];

/**
 * Modes a channel may store without being less restrictive than the business
 * ceiling. Widening is never offered (ADR-0013 §3).
 */
export function allowedOverrideModes(ceiling: AiReplyMode | null | undefined): AiReplyMode[] {
  if (!ceiling) return ["MANUAL"];
  return ALL_MODES.filter((mode) => MODE_RANK[mode] >= MODE_RANK[ceiling]);
}

export const MODE_LABEL_KEYS: Record<AiReplyMode, string> = {
  AUTO: "inbox.mode.auto",
  DRAFT: "inbox.mode.draft",
  MANUAL: "inbox.mode.manual",
};

export const MODE_SOURCE_LABEL_KEYS: Record<AiReplyModeSource, string> = {
  emergency_stop: "manageShop.channels.modeSource.emergencyStop",
  shop_inactive: "manageShop.channels.modeSource.shopInactive",
  channel_override: "manageShop.channels.modeSource.channelOverride",
  business_default: "manageShop.channels.modeSource.businessDefault",
  fail_closed: "manageShop.channels.modeSource.failClosed",
};

export type ChannelAutomationBadge =
  | "inherited"
  | "overridden"
  | "clamped"
  | "stopped"
  | "billingPaused";

export function deriveChannelBadge(input: {
  emergencyStop?: EmergencyStopState | null;
  billingAiActive?: boolean;
  modeSource?: AiReplyModeSource | null;
  warnings?: ChannelAutomationWarning[];
}): ChannelAutomationBadge {
  if (input.emergencyStop?.active === true) return "stopped";
  if (input.billingAiActive === false) return "billingPaused";
  if ((input.warnings || []).includes("override_clamped_by_business")) return "clamped";
  if (input.modeSource === "channel_override") return "overridden";
  return "inherited";
}

export const BADGE_LABEL_KEYS: Record<ChannelAutomationBadge, string> = {
  inherited: "manageShop.channels.badge.inherited",
  overridden: "manageShop.channels.badge.overridden",
  clamped: "manageShop.channels.badge.clamped",
  stopped: "manageShop.channels.badge.stopped",
  billingPaused: "manageShop.channels.badge.billingPaused",
};

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAYS)[number];

export interface EditableDaySlot {
  enabled: boolean;
  open: string;
  close: string;
}

export type EditableHours = Record<DayKey, EditableDaySlot>;

/** Flatten either `{day:{open,close}}` or `{day:[{open,close},…]}` to one slot. */
export function firstSlot(
  value: { open: string; close: string } | { open: string; close: string }[] | undefined,
): { open: string; close: string } | null {
  if (!value) return null;
  const slot = Array.isArray(value) ? value[0] : value;
  if (!slot || typeof slot.open !== "string" || typeof slot.close !== "string") return null;
  return slot;
}

export function hoursToEditable(hours: unknown): { timezone: string; days: EditableHours } {
  const record = (hours && typeof hours === "object" ? hours : {}) as Record<string, unknown>;
  const defaults: EditableHours = {
    mon: { enabled: false, open: "09:00", close: "18:00" },
    tue: { enabled: false, open: "09:00", close: "18:00" },
    wed: { enabled: false, open: "09:00", close: "18:00" },
    thu: { enabled: false, open: "09:00", close: "18:00" },
    fri: { enabled: false, open: "09:00", close: "18:00" },
    sat: { enabled: false, open: "09:00", close: "18:00" },
    sun: { enabled: false, open: "09:00", close: "18:00" },
  };
  if (!hours) return { timezone: "", days: defaults };
  const days = { ...defaults };
  for (const day of DAYS) {
    const slot = firstSlot(record[day] as never);
    if (slot) {
      days[day] = { enabled: true, open: slot.open, close: slot.close };
    }
  }
  return {
    timezone: typeof record.timezone === "string" ? record.timezone : "",
    days,
  };
}

/** Serialize the editor back to the canonical `{day:{open,close}}` shape. */
export function editableToHours(
  timezone: string,
  days: EditableHours,
): { timezone?: string } & Record<DayKey, { open: string; close: string }> {
  const out: { timezone?: string } & Record<string, { open: string; close: string }> = {};
  if (timezone.trim()) out.timezone = timezone.trim();
  for (const day of DAYS) {
    const slot = days[day];
    if (slot.enabled) out[day] = { open: slot.open, close: slot.close };
  }
  return out as { timezone?: string } & Record<DayKey, { open: string; close: string }>;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * True when a stored business-hours object contains a day slot the runtime
 * cannot parse. The backend fails closed on these (CLOSED, no auto-send), so
 * the overview surfaces an honest warning rather than pretending it is valid.
 */
export function hoursLookMalformed(hours: unknown): boolean {
  if (!hours || typeof hours !== "object") return false;
  const record = hours as Record<string, unknown>;
  for (const day of DAYS) {
    const raw = record[day];
    if (raw === undefined || raw === null) continue;
    const slots = Array.isArray(raw) ? raw : [raw];
    if (slots.length === 0) return true;
    for (const slot of slots) {
      if (!slot || typeof slot !== "object") return true;
      const open = (slot as { open?: unknown }).open;
      const close = (slot as { close?: unknown }).close;
      if (typeof open !== "string" || typeof close !== "string") return true;
      if (!HH_MM.test(open) || !HH_MM.test(close)) return true;
    }
  }
  return false;
}