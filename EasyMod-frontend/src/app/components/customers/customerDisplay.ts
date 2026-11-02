import type { CustomerState, OpportunityStrength, OrderOutcome } from "@/api/types/customer-intelligence";

/**
 * Neutral, explainable presentation for Customer 360. Colours signal "needs
 * attention", never blame — a return history is shown as history, not as a
 * judgement about the person.
 */
export const stateStyles: Record<CustomerState, string> = {
  NEW: "bg-gray-100 text-gray-700",
  INTERESTED: "bg-blue-50 text-blue-700",
  BUYER: "bg-emerald-50 text-emerald-700",
  REPEAT_BUYER: "bg-emerald-100 text-emerald-800",
  AT_RISK: "bg-amber-50 text-amber-800",
  INACTIVE: "bg-slate-100 text-slate-600",
};

export const strengthStyles: Record<OpportunityStrength, string> = {
  HIGH: "bg-emerald-100 text-emerald-800",
  MEDIUM: "bg-sky-50 text-sky-700",
};

export const outcomeStyles: Record<OrderOutcome, string> = {
  DELIVERED: "bg-emerald-50 text-emerald-700",
  RETURNED: "bg-amber-50 text-amber-800",
  CANCELLED: "bg-gray-100 text-gray-600",
  IN_PROGRESS: "bg-blue-50 text-blue-700",
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
