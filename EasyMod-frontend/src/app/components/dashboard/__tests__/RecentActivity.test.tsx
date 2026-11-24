/**
 * RecentActivity (D4): actor is the stored user or the localized "System"
 * label — never inferred; order rows with a stored id deep-link to the only
 * verified seed (/orders?orderId=); conversation/product rows stay unlinked;
 * limit 6; null → unavailable, [] → empty, list otherwise.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RecentActivity, orderRowHref } from "../RecentActivity";
import type { DashboardCommerceSignals } from "@/api/types/dashboard";

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === "object") {
      const vals = Object.values(opts).filter((v) => v != null).join(" ");
      if (vals) return `${key} ${vals}`;
    }
    return key;
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: tMock }) }));

type ActivityItem = NonNullable<DashboardCommerceSignals["recentActivity"]>[number];

const item = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: `row-${Math.random().toString(36).slice(2)}`,
  action: "ORDER_CREATED",
  resourceType: "ORDER",
  occurredAt: "2026-11-24T00:30:00Z",
  ...overrides,
});

const renderFeed = (activity: ActivityItem[] | null) =>
  render(<MemoryRouter><RecentActivity locale="en-BD" activity={activity} /></MemoryRouter>);

describe("orderRowHref (verified deep-link rule)", () => {
  it("links ORDER and order rows that carry a resource id", () => {
    expect(orderRowHref(item({ resourceType: "ORDER", resource_id: "o-1" }))).toBe("/orders?orderId=o-1");
    expect(orderRowHref(item({ resourceType: "order", resource_id: "o-2" }))).toBe("/orders?orderId=o-2");
  });
  it("never links without a stored id or for other resources", () => {
    expect(orderRowHref(item({ resourceType: "ORDER" }))).toBeNull();
    expect(orderRowHref(item({ resourceType: "CONVERSATION", resource_id: "c-1" }))).toBeNull();
    expect(orderRowHref(item({ resourceType: "PRODUCT", resource_id: "p-1" }))).toBeNull();
  });
});

describe("RecentActivity", () => {
  it("renders projected events with the stored actor and audit navigation", () => {
    renderFeed([item({ action: "ORDER_CONFIRMED", resourceType: "ORDER", resource_id: "o-9", user: { id: "u1", full_name: "Rina Akter" } })]);
    expect(screen.getByText(/actions.ORDER_CONFIRMED/)).toBeInTheDocument();
    expect(screen.getByText(/Rina Akter/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /commerceSignals.viewAll/ })).toHaveAttribute("href", "/audit-logs");
    expect(screen.getByRole("link", { name: /actions.ORDER_CONFIRMED/ })).toHaveAttribute("href", "/orders?orderId=o-9");
  });

  it("labels null-actor rows System — no AI/Provider inference", () => {
    renderFeed([item({ id: "sys-row", action: "ai_draft_approved", resourceType: "ai_draft", user: null })]);
    expect(screen.getByText(/commerceSignals.activitySystem/)).toBeInTheDocument();
    // The visible actor is the System label — never a fabricated AI/Provider name.
    expect(screen.queryByText(/^AI$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider/)).not.toBeInTheDocument();
  });

  it("keeps conversation/product rows unlinked", () => {
    renderFeed([
      item({ action: "INBOX_MESSAGE_SENT", resourceType: "CONVERSATION", resource_id: "c-1" }),
      item({ action: "PRODUCT_STOCK_UPDATED", resourceType: "PRODUCT", resource_id: "p-1" }),
    ]);
    // Only header link exists — no /orders?orderId for non-order resources.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("caps the feed at six rows", () => {
    renderFeed(Array.from({ length: 8 }, (_unused, index) => item({ id: `row-${index}` })));
    expect(screen.getAllByText(/actions.ORDER_CREATED/)).toHaveLength(6);
  });

  it("does not claim empty activity when the source fails", () => {
    renderFeed(null);
    expect(screen.getByText("dashboard.pulse.commerceSignals.activityUnavailable")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.pulse.commerceSignals.activityEmpty")).not.toBeInTheDocument();
  });

  it("explains the empty state instead of hiding it", () => {
    renderFeed([]);
    expect(screen.getByText("dashboard.pulse.commerceSignals.activityEmpty")).toBeInTheDocument();
  });
});
