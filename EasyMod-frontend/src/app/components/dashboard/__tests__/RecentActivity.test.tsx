import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import { RecentActivity } from "../RecentActivity";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
describe("RecentActivity", () => {
  it("renders actual projected events and audit navigation", () => {
    render(<MemoryRouter><RecentActivity locale="en-BD" activity={[{ id:"a", action:"ORDER_CONFIRM", resourceType:"ORDER", occurredAt:"2026-11-24T00:30:00Z" }]} /></MemoryRouter>);
    expect(screen.getByText(/actions.ORDER_CONFIRM/)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/audit-logs");
  });
  it("does not claim empty activity when the source fails", () => {
    render(<MemoryRouter><RecentActivity locale="en-BD" activity={null} /></MemoryRouter>);
    expect(screen.getByText("dashboard.pulse.commerceSignals.activityUnavailable")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.pulse.commerceSignals.activityEmpty")).not.toBeInTheDocument();
  });
});
