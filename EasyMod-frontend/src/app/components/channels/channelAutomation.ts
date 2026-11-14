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

export interface EditableHourSlot {
  open: string;
  close: string;
}

export interface EditableDaySlots {
  enabled: boolean;
  slots: EditableHourSlot[];
}

export type EditableHours = Record<DayKey, EditableDaySlots>;

export const DEFAULT_HOUR_SLOT: EditableHourSlot = { open: "09:00", close: "18:00" };

export type SerializedHours = { timezone?: string } & Partial<
  Record<DayKey, EditableHourSlot | EditableHourSlot[]>
>;

/** Normalize either `{day:{open,close}}` or `{day:[{open,close},…]}` to an array. */
function normalizeSlots(value: unknown): EditableHourSlot[] {
  if (value === undefined || value === null) return [];
  const rawSlots = Array.isArray(value) ? value : [value];
  const slots: EditableHourSlot[] = [];
  for (const raw of rawSlots) {
    if (!raw || typeof raw !== "object") continue;
    const open = (raw as { open?: unknown }).open;
    const close = (raw as { close?: unknown }).close;
    if (typeof open === "string" && typeof close === "string") {
      slots.push({ open, close });
    }
  }
  return slots;
}

/**
 * Load stored hours into the editor without dropping slots. Every day keeps
 * its full slot array (a single-slot day is just an array of length one), so a
 * saved multi-slot merchant never loses the second window.
 */
export function hoursToEditable(hours: unknown): { timezone: string; days: EditableHours } {
  const record = (hours && typeof hours === "object" ? hours : {}) as Record<string, unknown>;
  const days = {} as EditableHours;
  for (const day of DAYS) {
    const slots = normalizeSlots(record[day]);
    days[day] = slots.length > 0
      ? { enabled: true, slots }
      : { enabled: false, slots: [{ ...DEFAULT_HOUR_SLOT }] };
  }
  if (!hours) return { timezone: "", days };
  return {
    timezone: typeof record.timezone === "string" ? record.timezone : "",
    days,
  };
}

/**
 * Serialize the editor back to the canonical shape. One slot uses the
 * `{day:{open,close}}` object form; multiple slots use `{day:[…]}`. The
 * runtime accepts both, so single-slot merchants keep the existing payload.
 */
export function editableToHours(timezone: string, days: EditableHours): SerializedHours {
  const out: Record<string, string | EditableHourSlot | EditableHourSlot[]> = {};
  if (timezone.trim()) out.timezone = timezone.trim();
  for (const day of DAYS) {
    const dayValue = days[day];
    if (!dayValue?.enabled) continue;
    const slots = dayValue.slots
      .map((slot) => ({ open: slot.open, close: slot.close }))
      .filter((slot) => slot.open !== "" && slot.close !== "");
    if (slots.length === 0) continue;
    out[day] = slots.length === 1 ? slots[0] : slots;
  }
  return out as SerializedHours;
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