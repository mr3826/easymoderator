/**
 * QueueSignalChips (D3/D5): four real signal cards; each links to the exact
 * workflow it shares a predicate with; a failed source shows "Unavailable",
 * never an invented 0; a truncated/incomplete needs-reply scan renders N+
 * (capped 99+), never as exhaustive; the charges card keeps the D5 copy +
 * UTC-day chip and the raw numeric `count` interpolation (i18next plural
 * option — this is the pre-existing typecheck error's fix).
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { QueueSignalChips, needsReplyDisplay } from "../QueueSignalChips";
import type { NeedsReplyCount } from "@/api/types/dashboard";

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === "object") {
      const vals = Object.values(opts).filter((v) => v != null).join(" ");
      if (vals) return `${key} ${vals}`;
    }
    return key;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

const reply = (overrides: Partial<NeedsReplyCount> = {}): NeedsReplyCount => ({
  count: 3, scanned: 40, cap: 200, coverageComplete: true, generated_at: "2026-11-24T10:00:00.000Z",
  ...overrides,
});

function renderChips(props: { needsReply: NeedsReplyCount | null; pendingPayment: number | null; readyToDispatch: number | null }) {
  return render(
    <MemoryRouter>
      <QueueSignalChips {...props} />
    </MemoryRouter>,
  );
}

describe("needsReplyDisplay (pure)", () => {
  it("null source → unavailable label, never a digit", () => {
    expect(needsReplyDisplay(null, String, "Unavailable")).toBe("Unavailable");
  });
  it("complete coverage renders the exact count", () => {
    expect(needsReplyDisplay(reply({ count: 12, coverageComplete: true }), String, "X")).toBe("12");
  });
  it("incomplete coverage renders a lower bound N+", () => {
    expect(needsReplyDisplay(reply({ count: 12, coverageComplete: false }), String, "X")).toBe("12+");
  });
  it("large incomplete counts cap at 99+, never a bare big number", () => {
    expect(needsReplyDisplay(reply({ count: 200, coverageComplete: false }), String, "X")).toBe("99+");
    expect(needsReplyDisplay(reply({ count: 200, coverageComplete: true }), String, "X")).toBe("99+");
  });
});

describe("QueueSignalChips", () => {
  it("renders four cards linking to their exact predicates", () => {
    renderChips({ needsReply: reply({ count: 3 }), pendingPayment: 1, readyToDispatch: 2 });
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    const links = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    // D3 alignment: needs_reply opens the inbox needs_review tab.
    expect(links).toContain("/inbox?tab=needs_review");
    expect(links).toContain("/orders?payment=pending");
    expect(links).toContain("/orders?bucket=to_pack");
    // No bare /inbox chip link — the legacy unread destination is gone.
    expect(links).not.toContain("/inbox");
  });

  it("shows Unavailable for failed sources, never 0", () => {
    renderChips({ needsReply: null, pendingPayment: null, readyToDispatch: null });
    expect(screen.getAllByText("dashboard.pulse.queueChips.unavailable")).toHaveLength(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders the honesty + for incomplete coverage inside the card", () => {
    renderChips({ needsReply: reply({ count: 7, coverageComplete: false }), pendingPayment: 0, readyToDispatch: 0 });
    expect(screen.getByText("7+")).toBeInTheDocument();
  });

  it("shows real ledger minor units, the UTC-day chip and links to billing, without inferring fees", () => {
    render(
      <MemoryRouter>
        <QueueSignalChips needsReply={reply({ count: 0 })} pendingPayment={1} readyToDispatch={2}
          billing={{ dayUtc: "2026-11-24", count: 3, amountMinor: 2875 }} formatMoney={n => "BDT " + n.toFixed(2)} />
      </MemoryRouter>,
    );
    expect(screen.getByText("BDT 28.75")).toBeInTheDocument();
    expect(screen.getByText(/commerceSignals.charges/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /commerceSignals.charges/ })).toHaveAttribute("href", "/subscription");
    // D5: raw numeric count (i18next plural option) + day interpolation.
    expect(screen.getByText(/commerceSignals.dayCount 2026-11-24 3/)).toBeInTheDocument();
    // Honest charges tooltip (title attribute) — gross ledger ≠ invoiced/collected.
    expect(screen.getByRole("link", { name: /commerceSignals.charges/ })).toHaveAttribute("title", "dashboard.pulse.commerceSignals.chargesTooltip");
  });

  it("does not render a zero charge if the ledger is unavailable", () => {
    render(
      <MemoryRouter>
        <QueueSignalChips needsReply={reply({ count: 1 })} pendingPayment={1} readyToDispatch={2} billing={null} />
      </MemoryRouter>,
    );
    expect(screen.getByText("dashboard.pulse.commerceSignals.unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("does not render a second Orders today label", () => {
    renderChips({ needsReply: reply({ count: 3 }), pendingPayment: 0, readyToDispatch: 0 });
    expect(screen.queryByText("dashboard.pulse.overview.ordersToday")).not.toBeInTheDocument();
    expect(screen.queryByText("dashboard.pulse.attention.ordersToday")).not.toBeInTheDocument();
  });
});
