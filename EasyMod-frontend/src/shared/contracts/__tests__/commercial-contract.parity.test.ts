import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
  formatBdt,
  formatBdtBn,
  toBengaliNumerals,
  unitPriceDisplay,
  type PublicCommercialContract,
} from "../commercial-contract";
import fixture from "../__fixtures__/commercial-contract.fixture.json";

const publicContract = fixture.publicContract as PublicCommercialContract;

describe("commercial contract mirror — parity with backend fixture", () => {
  it("mirrors the contract version and hash identity", () => {
    expect(fixture.contractVersion).toBe(COMMERCIAL_CONTRACT_VERSION);
    expect(publicContract.contract_version).toBe(COMMERCIAL_CONTRACT_VERSION);
    expect(COMMERCIAL_CONTRACT.contractVersion).toBe(COMMERCIAL_CONTRACT_VERSION);
    expect(fixture.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(publicContract.contract_hash).toBe(fixture.contractHash);
    expect(fixture.registryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("mirrors the flat per-delivered-order price", () => {
    expect(COMMERCIAL_CONTRACT.model).toBe(publicContract.model);
    expect(COMMERCIAL_CONTRACT.currency).toBe(publicContract.currency);
    expect(COMMERCIAL_CONTRACT.trigger).toBe(publicContract.trigger);
    expect(COMMERCIAL_CONTRACT.unitPriceMinor).toBe(publicContract.unit_price_minor);
    expect(COMMERCIAL_CONTRACT.unitPriceMinor).toBe(1000);
    expect(publicContract.unit_price_bdt).toBe(10);
  });

  it("mirrors the fee-free, entitlement-free terms", () => {
    expect([...COMMERCIAL_CONTRACT.zeroRatedOutcomes]).toEqual(publicContract.zero_rated_outcomes);
    expect(COMMERCIAL_CONTRACT.subscriptionFeeMinor).toBe(publicContract.subscription_fee_bdt);
    expect(COMMERCIAL_CONTRACT.setupFeeMinor).toBe(publicContract.setup_fee_bdt);
    expect(COMMERCIAL_CONTRACT.monthlyMinimumMinor).toBe(publicContract.monthly_minimum_bdt);
    expect(COMMERCIAL_CONTRACT.conversationEntitlement).toBe(publicContract.conversation_entitlement);
    expect(COMMERCIAL_CONTRACT.cycle).toBe(publicContract.cycle);
    expect(COMMERCIAL_CONTRACT.payment).toBe(publicContract.payment);
  });

  it("mirrors the 7-day due window", () => {
    expect(COMMERCIAL_CONTRACT.dueDays).toBe(publicContract.due_days);
    expect(COMMERCIAL_CONTRACT.dueDays).toBe(7);
  });

  it("mirrors the overdue policy field for field", () => {
    // The backend payload reuses the frozen camelCase onOverdue object.
    expect(COMMERCIAL_CONTRACT.onOverdue).toEqual(publicContract.on_overdue);
    expect(COMMERCIAL_CONTRACT.onOverdue.deleteData).toBe(false);
  });

  it("mirrors the rendered price copy in both languages", () => {
    expect(formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor)).toBe("৳10.00");
    expect(formatBdtBn(COMMERCIAL_CONTRACT.unitPriceMinor)).toBe("৳১০.০০");
    expect(unitPriceDisplay("en")).toBe("৳10.00");
    expect(unitPriceDisplay("bn")).toBe("৳১০.০০");
    expect(toBengaliNumerals("1000")).toBe("১০০০");
    expect(publicContract.description.en).toContain(formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor));
    expect(publicContract.description.bn).toContain(formatBdtBn(COMMERCIAL_CONTRACT.unitPriceMinor));
  });

  it("carries the 24 forbidden token ids the claims scanner uses", () => {
    expect(fixture.forbiddenTokenIds).toHaveLength(24);
    expect(new Set(fixture.forbiddenTokenIds).size).toBe(24);
  });

  it("rejects non-finite money like the backend formatter", () => {
    expect(() => formatBdt(Number.NaN)).toThrow(TypeError);
  });
});