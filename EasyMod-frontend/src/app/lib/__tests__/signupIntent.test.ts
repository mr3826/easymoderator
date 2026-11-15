import { describe, expect, it } from "vitest";
import {
  getSignupAttribution,
  getSignupSuccessPath,
  isGrowthUpgradeIntent,
} from "../signupIntent";

describe("signup intent", () => {
  it("preserves only the fixed Growth review destination and supported locale", () => {
    const params = new URLSearchParams("lang=bn&intent=growth-upgrade&returnTo=https%3A%2F%2Fevil.invalid");

    expect(isGrowthUpgradeIntent(params)).toBe(true);
    expect(getSignupSuccessPath(params, "en")).toBe(
      "/subscription?intent=growth-upgrade&lang=bn",
    );
  });

  it("sends ordinary and unsupported signup destinations to the dashboard", () => {
    expect(getSignupSuccessPath(new URLSearchParams("returnTo=https%3A%2F%2Fevil.invalid"), "en"))
      .toBe("/dashboard");
    expect(getSignupSuccessPath(new URLSearchParams("intent=anything&lang=bn"), "bn"))
      .toBe("/dashboard");
    expect(getSignupSuccessPath(new URLSearchParams("intent=growth-upgrade&lang=evil"), "en"))
      .toBe("/subscription?intent=growth-upgrade&lang=en");
  });

  it("rejects duplicate intent parameters", () => {
    const params = new URLSearchParams("intent=growth-upgrade&intent=growth-upgrade");

    expect(isGrowthUpgradeIntent(params)).toBe(false);
    expect(getSignupSuccessPath(params, "en")).toBe("/dashboard");
  });
});

describe("signup attribution", () => {
  it("captures the landing CTA source and offer slugs", () => {
    const params = new URLSearchParams("source=landing_zero&offer=delivered_10");

    expect(getSignupAttribution(params)).toEqual({
      source: "landing_zero",
      offer: "delivered_10",
    });
  });

  it("returns only the keys that are present", () => {
    expect(getSignupAttribution(new URLSearchParams("source=landing_zero"))).toEqual({
      source: "landing_zero",
    });
    expect(getSignupAttribution(new URLSearchParams())).toEqual({});
  });

  it("drops unsafe or oversized attribution values", () => {
    const params = new URLSearchParams(
      "source=" + encodeURIComponent("https://evil.invalid/x") +
      "&offer=" + encodeURIComponent("<script>") +
      "&extra=ignored",
    );

    expect(getSignupAttribution(params)).toEqual({});
    expect(getSignupAttribution(new URLSearchParams("source=" + "a".repeat(65)))).toEqual({});
    expect(getSignupAttribution(new URLSearchParams("source=UPPER"))).toEqual({});
  });
});
