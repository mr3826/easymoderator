/**
 * QueueSignalChips: real aggregates link to their workflow; a failed source
 * shows "Unavailable", never an invented 0; no second "Orders today" node.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { QueueSignalChips } from "../QueueSignalChips";

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string) => key,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

function renderChips(props: { unread: number | null; pendingPayment: number | null; readyToDispatch: number | null }) {
  return render(
    <MemoryRouter>
      <QueueSignalChips {...props} />
    </MemoryRouter>,
  );
}

describe("QueueSignalChips", () => {
  it("renders counts and links each chip to its workflow", () => {
    renderChips({ unread: 3, pendingPayment: 1, readyToDispatch: 2 });
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/inbox", "/orders?payment=pending", "/orders?bucket=to_pack"]);
  });

  it("shows Unavailable for failed sources, never 0", () => {
    renderChips({ unread: null, pendingPayment: null, readyToDispatch: null });
    expect(screen.getAllByText("dashboard.pulse.queueChips.unavailable")).toHaveLength(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows real ledger minor units and links to billing, without inferring fees", () => {
    render(<MemoryRouter><QueueSignalChips unread={0} pendingPayment={1} readyToDispatch={2}
      billing={{ dayUtc: "2026-11-24", count: 3, amountMinor: 2875 }} formatMoney={n => "BDT " + n.toFixed(2)} /></MemoryRouter>);
    expect(screen.getByText("BDT 28.75")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /commerceSignals.charges/ })).toHaveAttribute("href", "/subscription");
  });
  it("does not render a zero charge if the ledger is unavailable", () => {
    render(<MemoryRouter><QueueSignalChips unread={1} pendingPayment={1} readyToDispatch={2} billing={null} /></MemoryRouter>);
    expect(screen.getByText("dashboard.pulse.commerceSignals.unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
  it("does not render a second Orders today label", () => {
    renderChips({ unread: 3, pendingPayment: 0, readyToDispatch: 0 });
    expect(screen.queryByText("dashboard.pulse.overview.ordersToday")).not.toBeInTheDocument();
    expect(screen.queryByText("dashboard.pulse.attention.ordersToday")).not.toBeInTheDocument();
  });
});
