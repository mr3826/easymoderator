import { describe, expect, it } from "vitest";
import * as planModule from "../subscriptionPlans";
import {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
  formatBdt,
  formatBdtBn,
  formatContractMoney,
  unitPriceDisplay,
} from "../subscriptionPlans";

describe("commercial billing metadata is contract-derived", () => {
  it("re-exports the single price authority", () => {
    expect(COMMERCIAL_CONTRACT.unitPriceMinor).toBe(1000);
    expect(COMMERCIAL_CONTRACT.currency).toBe("BDT");
    expect(COMMERCIAL_CONTRACT.model).toBe("DELIVERED_ORDER");
    expect(COMMERCIAL_CONTRACT.subscriptionFeeMinor).toBe(0);
    expect(COMMERCIAL_CONTRACT.setupFeeMinor).toBe(0);
    expect(COMMERCIAL_CONTRACT.monthlyMinimumMinor).toBe(0);
    expect(COMMERCIAL_CONTRACT.conversationEntitlement).toBeNull();
    expect(COMMERCIAL_CONTRACT.dueDays).toBe(7);
    expect(COMMERCIAL_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders money only through the contract formatters", () => {
    expect(formatBdt(1000)).toBe("৳10.00");
    expect(formatBdtBn(1000)).toBe("৳১০.০০");
    expect(unitPriceDisplay("en")).toBe("৳10.00");
    expect(unitPriceDisplay("bn")).toBe("৳১০.০০");
    expect(formatContractMoney(0, "en")).toBe("৳0.00");
    expect(formatContractMoney(0, "bn")).toBe("৳০.০০");
  });

  it("no longer exposes a retired plan catalog, price snapshot or prepaid credits", () => {
    expect((planModule as Record<string, unknown>).subscriptionPlans).toBeUndefined();
    expect((planModule as Record<string, unknown>).TOPUP_PACK_FALLBACK).toBeUndefined();
    expect((planModule as Record<string, unknown>).PARTNER_ORDER_TIERS_FALLBACK).toBeUndefined();
    expect((planModule as Record<string, unknown>).PUBLIC_PLAN_NAME_BY_CODE).toBeUndefined();
    expect((planModule as Record<string, unknown>).publicPlanToDefinition).toBeUndefined();
  });
});