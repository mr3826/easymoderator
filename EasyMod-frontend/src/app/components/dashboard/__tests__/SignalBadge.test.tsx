/**
 * SignalBadge: every signal kind carries a visible label AND an icon —
 * never color alone (guardrails §8/§18).
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignalBadge } from "../SignalBadge";
import type { SignalKind } from "../types";

const kinds: SignalKind[] = ["healthy", "attention", "review", "blocked", "resolved", "pending"];

describe("SignalBadge", () => {
  it.each(kinds)("%s renders a visible label and an icon", (kind) => {
    const { container } = render(<SignalBadge signal={{ kind, label: `Label ${kind}` }} />);
    expect(screen.getByText(`Label ${kind}`)).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("shows the reason when provided", () => {
    render(<SignalBadge signal={{ kind: "attention", label: "Attention", reason: "2 delivery exceptions" }} />);
    expect(screen.getByText(/2 delivery exceptions/)).toBeInTheDocument();
  });

  it("announces politely only when asked (dominant header badge)", () => {
    const { rerender } = render(<SignalBadge signal={{ kind: "review", label: "Review" }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<SignalBadge signal={{ kind: "review", label: "Review" }} announce />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
