/**
 * Evidence rail contract: provider-confirmed wording only (no read receipts),
 * no combobox/textarea, customer name never a heading, grounding only when
 * stored references exist, SSE vs offline sync line.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Conversation } from "@/api/types/conversation";
import { InboxEvidenceRail } from "../InboxEvidenceRail";

const conversation = {
  id: "conv-1",
  customer_id: "cust-1",
  customer: { id: "cust-1", name: "Alice" },
  channel: "facebook",
  status: "active",
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  needs_merchant_reply: true,
  needs_merchant_reply_reason: "CUSTOMER_UNANSWERED",
} as unknown as Conversation;

const narrative = {
  whyHere: "Customers are waiting for a reply on this page.",
  whatNow: "Open next reply",
  whereNext: "Open the next task, reply, then return to the queue.",
  provenResult: "Not synced yet",
};

const renderRail = (props: Partial<Parameters<typeof InboxEvidenceRail>[0]> = {}) =>
  render(
    <MemoryRouter>
      <InboxEvidenceRail
        conversation={conversation}
        narrative={narrative}
        sseConnected
        outboundResult="pending"
        {...props}
      />
    </MemoryRouter>,
  );

describe("InboxEvidenceRail", () => {
  it("shows item id, customer, source, reason and provider-pending outcome", () => {
    renderRail();
    expect(screen.getByTestId("inbox-evidence-rail")).toBeTruthy();
    expect(screen.getByText("conv-1")).toBeTruthy();
    expect(screen.getByText(/Alice \(cust-1\)/)).toBeTruthy();
    expect(screen.getByText(/facebook/)).toBeTruthy();
    expect(screen.getByText("Reported reply task: Customer is waiting for a reply")).toBeTruthy();
    expect(screen.getByText("Provider confirmation pending")).toBeTruthy();
    expect(screen.getByText("Live updates connected (SSE)")).toBeTruthy();
    expect(screen.getByText("Not synced yet")).toBeTruthy();
  });
  it("never claims customer read receipts", () => {
    const { container } = renderRail({ outboundResult: "confirmed" });
    expect(container.textContent).not.toMatch(/seen by|delivered to customer|read receipt/i);
    expect(screen.getByText("Provider confirmed the send")).toBeTruthy();
  });
  it("reports offline sync honestly", () => {
    renderRail({ sseConnected: false });
    expect(screen.getByText("Live updates offline — reconnecting")).toBeTruthy();
  });
  it("renders grounding only when stored references exist", () => {
    const { rerender } = renderRail();
    expect(screen.queryByText(/Grounded in/)).toBeNull();
    rerender(
      <MemoryRouter>
        <InboxEvidenceRail
          conversation={conversation}
          narrative={narrative}
          sseConnected
          outboundResult="pending"
          groundingRefs={[{ kind: "faq", id: "f1", title: "Delivery times" }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Grounded in 1 saved sources/)).toBeTruthy();
    expect(screen.getByText(/Delivery times/)).toBeTruthy();
  });
  it("adds no combobox, textarea or customer-name heading", () => {
    const { container } = renderRail();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(screen.queryByRole("heading", { name: /Alice/ })).toBeNull();
  });
  it("labels unlinked conversations without inventing a customer", () => {
    renderRail({ conversation: { ...conversation, customer_id: null, customer: undefined } as unknown as Conversation });
    expect(screen.getByText("Not linked to a customer record")).toBeTruthy();
  });
});
