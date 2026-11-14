import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
  ZERO_RATED_OUTCOMES,
} from "@/shared/contracts/commercial-contract";
import {
  parseClaimDecisionPayload,
  parsePublicCommercialContract,
} from "./commercialContract";
import type { ClaimDecision } from "../types/commercial";

const HASH = `sha256:${"a".repeat(64)}`;

function validPublicPayload(): Record<string, unknown> {
  return {
    contract_version: COMMERCIAL_CONTRACT_VERSION,
    contract_hash: HASH,
    registry_hash: HASH,
    model: COMMERCIAL_CONTRACT.model,
    currency: COMMERCIAL_CONTRACT.currency,
    trigger: COMMERCIAL_CONTRACT.trigger,
    unit_price_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
    unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
    zero_rated_outcomes: [...ZERO_RATED_OUTCOMES],
    subscription_fee_bdt: 0,
    setup_fee_bdt: 0,
    monthly_minimum_bdt: 0,
    conversation_entitlement: null,
    cycle: COMMERCIAL_CONTRACT.cycle,
    payment: COMMERCIAL_CONTRACT.payment,
    due_days: COMMERCIAL_CONTRACT.dueDays,
    on_overdue: { ...COMMERCIAL_CONTRACT.onOverdue },
    description: { en: "৳10.00 per delivered order.", bn: "প্রতি ডেলিভারি অর্ডারে ৳১০.০০।" },
    claims: [{
      id: "billing.delivered_order",
      verified_scope: "global",
      surfaces: ["pricing", "invoice"],
      i18n_key: { en: "claims.billing.delivered_order.en", bn: "claims.billing.delivered_order.bn" },
      fallback_i18n_key: null,
    }],
  };
}

const validDecision = (overrides: Partial<ClaimDecision> = {}): ClaimDecision => ({
  claimId: "billing.delivered_order",
  available: true,
  render: "claim",
  textKey: "claims.billing.delivered_order.en",
  locale: "en",
  surface: "pricing",
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: "global" },
  interpolation: {},
  mode: "enforce",
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: true,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: COMMERCIAL_CONTRACT_VERSION,
  registryHash: HASH,
  ...overrides,
});

const validDecisionPayload = (decisions: ClaimDecision[] = [validDecision()]) => ({
  surface: "pricing",
  locale: "en",
  contractVersion: COMMERCIAL_CONTRACT_VERSION,
  registryHash: HASH,
  decisions,
});

describe("parsePublicCommercialContract", () => {
  it("accepts a complete contract payload", () => {
    const parsed = parsePublicCommercialContract(validPublicPayload());

    expect(parsed.contract_version).toBe(COMMERCIAL_CONTRACT_VERSION);
    expect(parsed.unit_price_minor).toBe(1000);
    expect(parsed.registry_hash).toBe(HASH);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].id).toBe("billing.delivered_order");
  });

  it("throws when the payload is missing", () => {
    expect(() => parsePublicCommercialContract(null)).toThrow(/must be an object/);
  });

  it("throws when the public price omits the minor units (no price fallback)", () => {
    const payload = validPublicPayload();
    delete payload.unit_price_minor;
    expect(() => parsePublicCommercialContract(payload)).toThrow(/unit_price_minor/);
  });

  it("throws when the public price disagrees with the frontend mirror", () => {
    const payload = validPublicPayload();
    payload.unit_price_minor = 99900;
    payload.unit_price_bdt = 999;
    expect(() => parsePublicCommercialContract(payload)).toThrow(/unit_price_minor/);
  });

  it("throws when a retired subscription fee reappears", () => {
    const payload = validPublicPayload();
    payload.subscription_fee_bdt = 999;
    expect(() => parsePublicCommercialContract(payload)).toThrow(/subscription_fee_bdt/);
  });

  it("throws on a contract version drift", () => {
    const payload = validPublicPayload();
    payload.contract_version = "0.9.0";
    expect(() => parsePublicCommercialContract(payload)).toThrow(/contract_version/);
  });

  it("throws on a malformed hash", () => {
    const payload = validPublicPayload();
    payload.contract_hash = "sha256:not-a-digest";
    expect(() => parsePublicCommercialContract(payload)).toThrow(/contract_hash/);
  });

  it("throws when overdue policy could delete data", () => {
    const payload = validPublicPayload();
    payload.on_overdue = { ...COMMERCIAL_CONTRACT.onOverdue, deleteData: true };
    expect(() => parsePublicCommercialContract(payload)).toThrow(/on_overdue/);
  });

  it("throws when the claim allowlist is empty", () => {
    const payload = validPublicPayload();
    payload.claims = [];
    expect(() => parsePublicCommercialContract(payload)).toThrow(/claims/);
  });
});

describe("parseClaimDecisionPayload", () => {
  it("accepts a complete, self-consistent decision set", () => {
    const parsed = parseClaimDecisionPayload(validDecisionPayload());
    expect(parsed.surface).toBe("pricing");
    expect(parsed.decisions[0].render).toBe("claim");
    expect(parsed.decisions[0].contractVersion).toBe(COMMERCIAL_CONTRACT_VERSION);
  });

  it("throws when a decision is incomplete", () => {
    const decision = { ...validDecision() } as Record<string, unknown>;
    delete decision.claimId;
    expect(() => parseClaimDecisionPayload(validDecisionPayload([decision as unknown as ClaimDecision])))
      .toThrow(/claimId/);
  });

  it("throws on an unknown render value", () => {
    const decision = { ...validDecision(), render: "maybe" } as unknown as ClaimDecision;
    expect(() => parseClaimDecisionPayload(validDecisionPayload([decision])))
      .toThrow(/render/);
  });

  it("throws when a decision was evaluated against another contract version", () => {
    const decision = validDecision({ contractVersion: "0.9.0" });
    expect(() => parseClaimDecisionPayload(validDecisionPayload([decision])))
      .toThrow(/contractVersion/);
  });

  it("throws when a decision belongs to another surface", () => {
    const decision = validDecision({ surface: "invoice" });
    expect(() => parseClaimDecisionPayload(validDecisionPayload([decision])))
      .toThrow(/surface/);
  });
});