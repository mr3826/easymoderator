/**
 * Pure billing-usage derivation (guardrails §8/§16, ADR-0011).
 *
 * The monthly invoice job already freezes each period's usage into
 * `invoice.metadata` (deliveredCount / zeroRatedCount / gross / credit / net and
 * one entry per order with its outcome date). `GET /api/subscription/invoices`
 * returns those rows verbatim, so a usage view needs NO new endpoint — it only
 * reads what the page already fetches and used to discard.
 *
 * Fail-closed: an invoice without usable metadata contributes nothing and is
 * not counted as a covered period. Legacy/pre-cutover invoice types legitimately
 * have no metadata, and must render as "—" rather than an invented zero.
 *
 * Scope is BILLED history only. Un-invoiced (month-to-date) lines are not
 * reachable through any merchant API, so nothing here projects or estimates.
 */

export interface UsageInvoice {
  /** Amount in minor units (poisha), or null when the payload was unusable. */
  amount: number | null;
  status: string;
  metadata?: Record<string, unknown> | null;
}

export interface InvoiceUsageDetail {
  deliveredCount: number;
  zeroRatedCount: number;
  grossMinor: number | null;
  creditMinor: number | null;
  netMinor: number | null;
}

export interface UsageSummary {
  /** True only when at least one invoice carried usable usage metadata. */
  hasDetail: boolean;
  periodsCovered: number;
  deliveredCount: number;
  zeroRatedCount: number;
  /** Sum of pending + overdue invoice amounts, in minor units. */
  outstandingMinor: number;
}

const nonNegativeInt = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

/** Read one invoice's frozen usage, or null when it has none. */
export function invoiceUsage(metadata?: Record<string, unknown> | null): InvoiceUsageDetail | null {
  if (!metadata || typeof metadata !== "object") return null;
  const deliveredCount = nonNegativeInt(metadata.deliveredCount);
  const zeroRatedCount = nonNegativeInt(metadata.zeroRatedCount);
  if (deliveredCount === null || zeroRatedCount === null) return null;
  return {
    deliveredCount,
    zeroRatedCount,
    grossMinor: nonNegativeInt(metadata.grossMinor),
    creditMinor: nonNegativeInt(metadata.creditMinor),
    netMinor: nonNegativeInt(metadata.netMinor),
  };
}

export function deriveUsageSummary(invoices: UsageInvoice[]): UsageSummary {
  let periodsCovered = 0;
  let deliveredCount = 0;
  let zeroRatedCount = 0;
  let outstandingMinor = 0;

  for (const invoice of invoices) {
    const usage = invoiceUsage(invoice.metadata);
    if (usage) {
      periodsCovered += 1;
      deliveredCount += usage.deliveredCount;
      zeroRatedCount += usage.zeroRatedCount;
    }
    if ((invoice.status === "pending" || invoice.status === "overdue") && invoice.amount !== null) {
      outstandingMinor += invoice.amount;
    }
  }

  return {
    hasDetail: periodsCovered > 0,
    periodsCovered,
    deliveredCount,
    zeroRatedCount,
    outstandingMinor,
  };
}

/**
 * The real outcome date for one order, from the invoice's frozen line list.
 * The billing-lines API exposes `createdAt` (row insert time), which is NOT the
 * delivery/return date — only `metadata.lines[].occurredAt` is.
 */
export function outcomeDateFor(
  metadata: Record<string, unknown> | null | undefined,
  orderId: string | null | undefined,
): string | null {
  if (!metadata || !orderId) return null;
  const lines = metadata.lines;
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const entry = line as Record<string, unknown>;
    if (String(entry.orderId ?? "") !== String(orderId)) continue;
    const occurredAt = entry.occurredAt;
    if (typeof occurredAt !== "string" || occurredAt.length === 0) return null;
    return Number.isNaN(new Date(occurredAt).getTime()) ? null : occurredAt;
  }
  return null;
}
