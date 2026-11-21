/**
 * P04 component truthfulness — the /dashboard setup variant must render the
 * backend operational ladder honestly:
 *   (a) configuration complete with no messages is NOT presented as verified;
 *   (b) a listening channel without an accepted reply says waiting_for_test;
 *   (d) delivery failure says action_required and keeps warnings visible;
 *   (e) only provider acceptance unlocks the success banner + capability bullets;
 *   (f) an older payload without the operational block fails closed;
 *   (g) refresh stays wired and a re-render follows the new state.
 * The generatedAt timestamp is labelled "Status checked", never "Verified".
 */
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FirstTimeSetupDashboard from "../FirstTimeSetupDashboard";
import type { SetupOperational, SetupStatus, SetupTask } from "@/api/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        const vals = Object.values(opts).filter((v) => v != null).join(" ");
        if (vals) return `${key} ${vals}`;
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

function makeTask(overrides: Partial<SetupTask> = {}): SetupTask {
  return {
    key: "connect_channel",
    title: "Connect Facebook Page",
    description: "Connect a page",
    status: "complete",
    required: true,
    ctaLabel: "Manage channel",
    href: "/manage-shop/chat-settings",
    missing: [],
    warnings: [],
    meta: {},
    ...overrides,
  };
}

function makeOperational(
  state: SetupOperational["state"],
  evidence: Partial<SetupOperational["evidence"]> = {},
  warnings: SetupOperational["warnings"] = [],
): SetupOperational {
  return {
    state,
    operationalVerified: state === "verified_operational",
    evidenceWindowDays: 30,
    warnings,
    evidence: {
      webhook: {
        connectedFacebookPages: 1,
        verifiedEver: 0,
        verifiedWithinWindow: 0,
        lastVerifiedAt: null,
      },
      assistant: {
        draftsGenerated: 0,
        draftsApproved: 0,
        providerAcceptedEver: 0,
        providerAcceptedWithinWindow: 0,
        lastProviderAcceptedAt: null,
        approvedSendFailures: 0,
        outboxNeedsReconciliation: 0,
      },
      ...evidence,
    },
  };
}

function makeStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    isComplete: true,
    completedCount: 4,
    totalCount: 4,
    progressPercent: 100,
    tasks: [makeTask()],
    counts: { connectedFacebookPages: 1, webhookVerifiedFacebookPages: 0, activeProducts: 3, activeFaqs: 1 },
    generatedAt: "2026-11-20T09:30:00.000Z",
    ...overrides,
  };
}

const renderDashboard = (props: Partial<ComponentProps<typeof FirstTimeSetupDashboard>> = {}) =>
  render(
    <MemoryRouter>
      <FirstTimeSetupDashboard
        setupStatus={makeStatus()}
        onRefresh={vi.fn()}
        onDismissCompletion={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());

describe("FirstTimeSetupDashboard — operational truthfulness (P04)", () => {
  it("(a) configuration complete with no messages renders configured state, warnings, and never a verified claim", () => {
    renderDashboard({
      setupStatus: makeStatus({
        tasks: [
          makeTask({
            warnings: [{ code: "WEBHOOK_NOT_VERIFIED", message: "No webhook verification was found." }],
          }),
        ],
        operational: makeOperational("configured", {}, [
          { code: "WEBHOOK_NOT_VERIFIED", message: "No webhook verification was found." },
        ]),
      }),
    });

    expect(screen.getByText(/dashboard\.setup\.states\.configured\.title/)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.setup\.states\.verified_operational/)).not.toBeInTheDocument();
    // The complete branch no longer silences task/operational warnings.
    expect(screen.getAllByText(/dashboard\.setup\.warnings\.WEBHOOK_NOT_VERIFIED/).length).toBeGreaterThan(0);
    expect(screen.getByText("dashboard.setup.warningsTitle")).toBeInTheDocument();
    // Capability bullets belong to verified operation only.
    expect(screen.queryByText("Reply to customers")).not.toBeInTheDocument();
  });

  it("labels the computation timestamp 'Status checked', not 'Verified'", () => {
    renderDashboard({
      setupStatus: makeStatus({ operational: makeOperational("configured") }),
    });

    expect(screen.getAllByText(/dashboard\.setup\.statusCheckedAt/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/dashboard\.setup\.verifiedAt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Verified /)).not.toBeInTheDocument();
  });

  it("(b) a listening channel with no accepted reply renders waiting_for_test guidance", () => {
    renderDashboard({
      setupStatus: makeStatus({
        operational: makeOperational("waiting_for_test", {
          webhook: {
            connectedFacebookPages: 1,
            verifiedEver: 1,
            verifiedWithinWindow: 1,
            lastVerifiedAt: "2026-11-20T09:00:00.000Z",
          },
        }),
      }),
    });

    expect(screen.getByText(/dashboard\.setup\.states\.waiting_for_test\.title/)).toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.states\.waiting_for_test\.description/)).toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.evidence\.webhookVerifiedAt/)).toBeInTheDocument();
    expect(screen.getByText("dashboard.setup.evidence.providerNone")).toBeInTheDocument();
  });

  it("(d) a failed delivery surfaces the action_required banner and its warning", () => {
    renderDashboard({
      setupStatus: makeStatus({
        operational: makeOperational(
          "action_required",
          {
            assistant: {
              draftsGenerated: 1,
              draftsApproved: 1,
              providerAcceptedEver: 0,
              providerAcceptedWithinWindow: 0,
              lastProviderAcceptedAt: null,
              approvedSendFailures: 1,
              outboxNeedsReconciliation: 1,
            },
          },
          [{ code: "OPERATIONAL_TEST_FAILED", message: "An approved AI reply failed to reach Messenger." }],
        ),
      }),
    });

    expect(screen.getByText(/dashboard\.setup\.states\.action_required\.title/)).toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.warnings\.OPERATIONAL_TEST_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.evidence\.deliveryFailures/)).toBeInTheDocument();
  });

  it("(e) provider acceptance unlocks the success state and the capability bullets", () => {
    renderDashboard({
      setupStatus: makeStatus({
        operational: makeOperational("verified_operational", {
          webhook: {
            connectedFacebookPages: 1,
            verifiedEver: 1,
            verifiedWithinWindow: 1,
            lastVerifiedAt: "2026-11-20T09:00:00.000Z",
          },
          assistant: {
            draftsGenerated: 2,
            draftsApproved: 1,
            providerAcceptedEver: 1,
            providerAcceptedWithinWindow: 1,
            lastProviderAcceptedAt: "2026-11-20T09:10:00.000Z",
            approvedSendFailures: 0,
            outboxNeedsReconciliation: 0,
          },
        }),
      }),
    });

    expect(screen.getByText(/dashboard\.setup\.states\.verified_operational\.title/)).toBeInTheDocument();
    expect(screen.getByText("Reply to customers")).toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.evidence\.providerAccepted/)).toBeInTheDocument();
  });

  it("(f) an older payload without the operational block fails closed to 'configured'", () => {
    renderDashboard({ setupStatus: makeStatus() });

    expect(screen.getByText(/dashboard\.setup\.states\.configured\.title/)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.setup\.states\.verified_operational/)).not.toBeInTheDocument();
    expect(screen.getByText("dashboard.setup.evidence.none")).toBeInTheDocument();
  });

  it("(g) an incomplete refresh keeps the task view, and re-rendered statuses after refresh always follow the new evidence", () => {
    // Partial run: config NOT complete — the task list must render and no
    // operational banner may claim any end-state while steps are missing.
    const view = render(
      <MemoryRouter>
        <FirstTimeSetupDashboard
          setupStatus={makeStatus({
            isComplete: false,
            completedCount: 3,
            totalCount: 4,
            progressPercent: 75,
            tasks: [makeTask(), makeTask({ key: "first_product", status: "incomplete" })],
            operational: makeOperational("waiting_for_test"),
          })}
          onRefresh={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("dashboard.setup.title")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.setup\.states\./)).not.toBeInTheDocument();

    // Refresh lands with a still-inconclusive test...
    view.rerender(
      <MemoryRouter>
        <FirstTimeSetupDashboard
          setupStatus={makeStatus({
            operational: makeOperational("waiting_for_test", {
              webhook: { connectedFacebookPages: 1, verifiedEver: 1, verifiedWithinWindow: 1, lastVerifiedAt: null },
            }),
          })}
          onRefresh={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/dashboard\.setup\.states\.waiting_for_test\.title/)).toBeInTheDocument();

    // ...and with provider acceptance after the next refresh.
    view.rerender(
      <MemoryRouter>
        <FirstTimeSetupDashboard
          setupStatus={makeStatus({ operational: makeOperational("verified_operational") })}
          onRefresh={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/dashboard\.setup\.states\.verified_operational\.title/)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.setup\.states\.waiting_for_test/)).not.toBeInTheDocument();
  });
});
