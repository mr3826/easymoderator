/**
 * BusinessHealth (D8) state matrix: stock exceptions with out/low split and
 * lower-bound honesty, delivery exceptions from the needs_action authority,
 * cash in-transit/at-risk with the derivation note kept; every source failure
 * renders Unavailable — never 0, never a green placeholder. No opportunities,
 * no analytics, no billing-overdue duplication (the shell banner owns that).
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BusinessHealth } from "../BusinessHealth";
import type { StockExceptions } from "@/api/types/dashboard";
import type { CashPosition } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        const vals = Object.values(opts).filter((v) => v != null).join(" ");
        if (vals) return `${key} ${vals}`;
      }
      return key;
    },
  }),
}));

const stock = (overrides: Partial<StockExceptions> = {}): StockExceptions => ({
  outOfStock: 2, lowStock: 5, exceptions: 7, scanned: 40, cap: 1000, coverageComplete: true,
  generated_at: "2026-11-24T10:00:00.000Z", ...overrides,
});

const cash: CashPosition = {
  inTransit: { amount: 12500, count: 7 },
  atRisk: { amount: 3400, count: 2, windowDays: 30 },
};

const formatCount = (n: number) => String(n);
const formatCurrency = (n: number) => "BDT " + n.toFixed(0);

function renderHealth(props: Partial<Parameters<typeof BusinessHealth>[0]> = {}) {
  return render(
    <MemoryRouter>
      <BusinessHealth
        stockExceptions={stock()}
        deliveryExceptionCount={4}
        cashPosition={cash}
        formatCount={formatCount}
        formatCurrency={formatCurrency}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("BusinessHealth", () => {
  it("renders the section with real figures and the out/low split", () => {
    renderHealth();
    expect(screen.getByText("dashboard.businessHealth.title")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument(); // exceptions total
    expect(screen.getByText(/businessHealth\.outOfStock: 2/)).toBeInTheDocument();
    expect(screen.getByText(/businessHealth\.lowStock: 5/)).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // delivery exceptions
    expect(screen.getByText("BDT 12500")).toBeInTheDocument();
    expect(screen.getByText("BDT 3400")).toBeInTheDocument();
  });

  it("links each signal to the exact server predicate destination", () => {
    renderHealth();
    expect(screen.getByRole("link", { name: /businessHealth.stockExceptions/ })).toHaveAttribute("href", "/products?stock=exceptions");
    expect(screen.getByRole("link", { name: /businessHealth.deliveryExceptions/ })).toHaveAttribute("href", "/orders?bucket=needs_action");
    expect(screen.getByRole("link", { name: /businessHealth.cashInTransit/ })).toHaveAttribute("href", "/orders?bucket=in_transit");
    // At-risk has no verified bucket seed — lands on the plain orders list.
    expect(screen.getByRole("link", { name: /businessHealth.cashAtRisk/ })).toHaveAttribute("href", "/orders");
  });

  it("renders lower bounds with + when the stock scan was incomplete", () => {
    renderHealth({ stockExceptions: stock({ coverageComplete: false }) });
    expect(screen.getByText("7+")).toBeInTheDocument();
    expect(screen.queryByText(/^7$/)).not.toBeInTheDocument();
  });

  it("source failures render Unavailable, never zero", () => {
    renderHealth({ stockExceptions: null, deliveryExceptionCount: null, cashPosition: null });
    expect(screen.getAllByText("dashboard.businessHealth.unavailable")).toHaveLength(4);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("keeps the order-status-derived cash honesty note on the section", () => {
    renderHealth();
    expect(screen.getByText("dashboard.pulse.cashPosition.derivationNote")).toBeInTheDocument();
  });

  it("renders nothing that duplicates billing or opportunities surfaces (D8)", () => {
    const { container } = renderHealth();
    // No /subscription destination (BillingStandingBanner owns overdue status).
    expect(container.querySelector('a[href="/subscription"]')).toBeNull();
    expect(screen.queryByText(/opportunit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/analytic|revenue|score/i)).not.toBeInTheDocument();
  });

  it("interpolates order counts via the raw numeric plural option", () => {
    renderHealth();
    expect(screen.getByText(/cashPosition.ordersUnit 7/)).toBeInTheDocument();
    expect(screen.getByText(/cashPosition.ordersUnit 2/)).toBeInTheDocument();
  });
});
