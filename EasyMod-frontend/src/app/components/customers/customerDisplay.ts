import type { CustomerState, OpportunityStrength, OrderOutcome } from "@/api/types/customer-intelligence";

/**
 * Neutral, explainable presentation for Customer 360. Colours signal "needs
 * attention", never blame — a return history is shown as history, not as a
 * judgement about the person.
 */
export const stateStyles: Record<CustomerState, string> = {
  NEW: "bg-em-bg-muted text-em-text-secondary",
  INTERESTED: "bg-em-info-100 text-em-info-700",
  BUYER: "bg-em-success-100 text-em-success-700",
  REPEAT_BUYER: "bg-em-success-100 text-em-success-700",
  AT_RISK: "bg-em-warning-100 text-em-warning-700",
  INACTIVE: "bg-em-bg-muted text-em-text-secondary",
};

export const strengthStyles: Record<OpportunityStrength, string> = {
  HIGH: "bg-em-success-100 text-em-success-700",
  MEDIUM: "bg-em-info-100 text-em-info-700",
};

export const outcomeStyles: Record<OrderOutcome, string> = {
  DELIVERED: "bg-em-success-100 text-em-success-700",
  RETURNED: "bg-em-warning-100 text-em-warning-700",
  CANCELLED: "bg-em-bg-muted text-em-text-secondary",
  IN_PROGRESS: "bg-em-info-100 text-em-info-700",
};

export const localeFor = (language: string) => (language === "bn" ? "bn-BD" : "en-US");

export function formatMoney(value: number, language: string): string {
  return new Intl.NumberFormat(localeFor(language), {
    style: "currency",
    currency: "BDT",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function formatDateTime(value: string | null | undefined, language: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(localeFor(language), { dateStyle: "medium", timeStyle: "short" });
}

export function formatRelative(value: string | null | undefined, language: string, now = Date.now()): string {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "—";
  const minutes = Math.round((then - now) / 60000);
  const rtf = new Intl.RelativeTimeFormat(localeFor(language), { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

export const initialOf = (name: string | null | undefined) => (name ?? "?").trim().charAt(0).toUpperCase() || "?";
