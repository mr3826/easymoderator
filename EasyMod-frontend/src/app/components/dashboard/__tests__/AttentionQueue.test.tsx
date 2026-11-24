/**
 * AttentionQueue (A8 round-3, MINOR-1): the "N more in this group" note must
 * interpolate LOCALE-formatted digits (displayCount — the same Intl-bound
 * formatter QueueSignalChips/derive use, so bn renders Bangla numerals) while
 * i18next's plural slot keeps the raw numeric count.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MessageCircle } from "lucide-react";
import { AttentionQueue } from "../AttentionQueue";
import type { WorkGroup, WorkItem } from "../types";

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (key === "dashboard.pulse.work.moreInGroup") {
      // Mirrors the real templates ("{{displayCount}} more in this group" /
      // "এই তালিকায় আরও {{displayCount}}টি"): interpolate displayCount and
      // expose the plural option's type so the pin proves both slots.
      return `MORE:${opts?.displayCount}|countIs${typeof opts?.count}`;
    }
    return key;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

const bnDigits = (value: number) => new Intl.NumberFormat("bn-BD").format(value);

const item = (n: number): WorkItem => ({
  id: `exception-${n}`,
  kind: "exception",
  title: `ORD-${n}`,
  detail: "dashboard.pulse.status.returned",
  to: `/orders?orderId=${n}`,
  sortAt: n,
  icon: MessageCircle,
  action: "dashboard.pulse.attention.reviewOrder",
});

const items = [item(1), item(2), item(3)];
const group: WorkGroup = {
  kind: "exception",
  title: "dashboard.pulse.work.groups.exceptions",
  to: "/orders?bucket=needs_action",
  action: "dashboard.pulse.work.openOrders",
  items,
  visibleItems: items.slice(0, 2),
  hiddenCount: 1,
};

function renderQueue(props: { formatCount?: (n: number) => string }) {
  return render(
    <MemoryRouter>
      <AttentionQueue groups={[group]} hasAllWorkSources caughtUp={false} {...props} />
    </MemoryRouter>,
  );
}

describe("AttentionQueue hidden-count note (A8 round-3 MINOR-1)", () => {
  it("interpolates the locale-formatted displayCount (Bangla digits) with count still a raw number", () => {
    renderQueue({ formatCount: bnDigits });
    expect(screen.getByText(`MORE:${bnDigits(1)}|countIsnumber`)).toBeInTheDocument();
    expect(screen.getByText(/MORE:১/)).toBeInTheDocument();
  });

  it("default (no formatter wired) keeps plain digits — the pure pins stay honest", () => {
    renderQueue({});
    expect(screen.getByText("MORE:1|countIsnumber")).toBeInTheDocument();
  });
});
