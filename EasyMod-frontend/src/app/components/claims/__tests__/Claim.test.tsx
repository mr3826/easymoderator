import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimDecision, ClaimSurface } from "@/api/types/commercial";
import { Claim } from "../Claim";
import { ClaimProvider, resolveClaimLocale } from "../ClaimProvider";

const { mockUseClaimDecisions, translations } = vi.hoisted(() => ({
  mockUseClaimDecisions: vi.fn(),
  translations: {
    "claims.courier.pathao.booking_live.en": "Pathao booking available",
    "claims.courier.pathao.booking_live.fallback.en": "Pathao booking not live-verified",
    "claims.billing.delivered_order.en": "৳10.00 per delivered order",
  } as Record<string, string>,
}));

vi.mock("@/api/domains/commercialContract", () => ({
  useClaimDecisions: mockUseClaimDecisions,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
    i18n: { language: "en" },
  }),
}));

const REGISTRY_HASH = `sha256:${"a".repeat(64)}`;

const baseDecision = (overrides: Partial<ClaimDecision> = {}): ClaimDecision => ({
  claimId: "courier.pathao.booking_live",
  available: false,
  render: "none",
  textKey: null,
  locale: "en",
  surface: "pricing",
  scope: {
    claimedProviders: null,
    verifiedProviders: null,
    match: true,
    text: "courier:pathao",
  },
  interpolation: {},
  mode: "enforce",
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: false,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: "1.0.0",
  registryHash: REGISTRY_HASH,
  ...overrides,
});

function mockDecisions(surface: ClaimSurface, decisions: ClaimDecision[]) {
  mockUseClaimDecisions.mockReturnValue({
    data: {
      surface,
      locale: "en",
      contractVersion: "1.0.0",
      registryHash: REGISTRY_HASH,
      decisions,
    },
    isLoading: false,
    error: null,
  });
}

function renderClaim(decision: ClaimDecision | null, surface: ClaimSurface = "pricing") {
  mockDecisions(surface, decision ? [decision] : []);
  return render(
    <ClaimProvider surface={surface}>
      <Claim id={decision?.claimId ?? "missing.claim"} surface={surface} />
    </ClaimProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Claim", () => {
  it("returns no DOM node when enforce has no available claim and no fallback", () => {
    const { container } = renderClaim(baseDecision({ render: "none", textKey: null }));

    expect(container.querySelector('[data-claim-id]')).toBeNull();
    expect(screen.queryByText("Pathao booking available")).toBeNull();
  });

  it("renders the claim under shadow and marks the decision attributes", () => {
    const { container } = renderClaim(baseDecision({
      render: "claim",
      mode: "shadow",
      available: false,
      wouldBlock: true,
      textKey: "claims.courier.pathao.booking_live.en",
    }));

    const node = container.querySelector('[data-claim-id="courier.pathao.booking_live"]');
    expect(node).not.toBeNull();
    expect(node).toHaveAttribute("data-claim-render", "claim");
    expect(node).toHaveAttribute("data-claim-mode", "shadow");
    expect(node).toHaveAttribute("data-contract-version", "1.0.0");
    expect(screen.getByText("Pathao booking available")).toBeInTheDocument();
  });

  it("renders the truthful fallback when enforce blocks the claim", () => {
    renderClaim(baseDecision({
      render: "fallback",
      mode: "enforce",
      available: false,
      textKey: "claims.courier.pathao.booking_live.fallback.en",
    }));

    expect(screen.getByText("Pathao booking not live-verified")).toBeInTheDocument();
    expect(screen.queryByText("Pathao booking available")).toBeNull();
  });

  it("renders an available claim with the contract version attribute", () => {
    const { container } = renderClaim(baseDecision({
      render: "claim",
      mode: "enforce",
      available: true,
      textKey: "claims.billing.delivered_order.en",
      claimId: "billing.delivered_order",
    }));

    expect(container.querySelector('[data-claim-id="billing.delivered_order"]')).not.toBeNull();
    expect(container.querySelector('[data-contract-version="1.0.0"]')).not.toBeNull();
    expect(screen.getByText("৳10.00 per delivered order")).toBeInTheDocument();
  });

  it("renders nothing when the surface does not own the decision", () => {
    mockDecisions("pricing", [baseDecision({
      render: "claim",
      mode: "shadow",
      textKey: "claims.courier.pathao.booking_live.en",
    })]);

    const { container } = render(
      <ClaimProvider surface="pricing">
        <Claim id="courier.pathao.booking_live" surface="landing" />
      </ClaimProvider>,
    );

    expect(container.querySelector('[data-claim-id]')).toBeNull();
  });

  it("renders nothing for an unknown claim or missing provider", () => {
    mockDecisions("pricing", []);
    const { container } = render(
      <ClaimProvider surface="pricing">
        <Claim id="claims.does_not_exist" />
      </ClaimProvider>,
    );
    expect(container.querySelector('[data-claim-id]')).toBeNull();

    const outside = render(<Claim id="courier.pathao.booking_live" />);
    expect(outside.container.querySelector('[data-claim-id]')).toBeNull();
  });

  it("fails closed when a translated string is missing", () => {
    const { container } = renderClaim(baseDecision({
      render: "claim",
      mode: "shadow",
      textKey: "claims.unknown.translation.en",
    }));

    // The mock returns the key itself; Claim must not leak the raw key.
    expect(container.querySelector('[data-claim-id]')).toBeNull();
  });
});

describe("ClaimProvider", () => {
  it("queries one decision set for the surface and locale", () => {
    mockDecisions("pricing", []);
    render(
      <ClaimProvider surface="pricing">
        <span>child</span>
      </ClaimProvider>,
    );

    expect(mockUseClaimDecisions).toHaveBeenCalledTimes(1);
    expect(mockUseClaimDecisions).toHaveBeenCalledWith("pricing", "en");
  });

  it("defaults to Bengali unless the language is explicitly English", () => {
    expect(resolveClaimLocale(undefined)).toBe("bn");
    expect(resolveClaimLocale("bn")).toBe("bn");
    expect(resolveClaimLocale("en")).toBe("en");
    expect(resolveClaimLocale("en-US")).toBe("en");
  });
});