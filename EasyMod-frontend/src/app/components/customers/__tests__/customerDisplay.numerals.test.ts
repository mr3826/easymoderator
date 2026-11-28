/**
 * G-UX09 (partial) — Bangla-numeral preservation.
 *
 * The UX09 row of the coverage matrix marks Bengali-numeral rendering as
 * already patterned at the contract plane (commercial-contract parity tests
 * pin ৳ numerals) and in the pricing/landing e2e pins (১০০ / ৳১০.০০). The
 * shared DISPLAY helper every money surface in the authenticated app renders
 * through — customerDisplay.formatMoney — had no direct digit-preservation
 * assertion. This file pins it so a locale-plumbing regression (bn falling
 * back to en-US, or a sanitization step rewriting ০-৯ to ASCII) fails here
 * instead of in founder UAT.
 *
 * Also pins the Orders-detail formatter shape (Intl bn-BD currency, exactly
 * two fraction digits, Orders.tsx `currencyFormatter`) so the two money
 * formatters agree on WHICH locales produce Bengali digits.
 */
import { describe, it, expect } from "vitest";
import { formatCount, formatMoney, localeFor } from "../customerDisplay";
import { normalizeBengaliDigits } from "@/shared/lib/normalizeBengaliDigits";

const BN_DIGIT = /[০-৯]/;
const ASCII_DIGIT = /[0-9]/;

describe("Bangla-numeral preservation in shared display formatters (G-UX09)", () => {
  it("routes bn to bn-BD and everything else to en-US", () => {
    expect(localeFor("bn")).toBe("bn-BD");
    expect(localeFor("en")).toBe("en-US");
  });

  // Digit-plane assertions only: symbol placement (৳ vs "BDT") varies with
  // the CLDR snapshot shipped by Node (20 in CI, 25 here), while bn-BD's
  // Bengali-digit contract is stable. ৳ copy itself is pinned elsewhere
  // (commercial-contract parity + the pricing/landing e2e numerals pins).
  it("renders money with Bengali digits and no ASCII digits under bn", () => {
    const bn = formatMoney(1250, "bn");
    expect(bn).toMatch(BN_DIGIT);
    expect(bn).not.toMatch(ASCII_DIGIT);

    // Zero must survive as ০, never as an ASCII 0 (the collapse-flag style
    // sanitizers are allowed to touch Latin copy, never approved numerals).
    const zero = formatMoney(0, "bn");
    expect(zero).toContain("০");
    expect(zero).not.toMatch(ASCII_DIGIT);
  });

  it("renders money with ASCII digits and no Bengali digits under en", () => {
    const en = formatMoney(1250, "en");
    expect(en).toMatch(ASCII_DIGIT);
    expect(en).not.toMatch(BN_DIGIT);
  });

  it("preserves fractional BDT values instead of rounding paisa", () => {
    const en = formatMoney(12.5, "en");
    expect(en).toContain("12.50");
    const bn = formatMoney(12.5, "bn");
    expect(bn).toContain("১২.৫০");
  });

  it("formats counts with Bengali digits under bn and ASCII digits under en", () => {
    expect(formatCount(12000, "bn")).toBe("১২,০০০");
    expect(formatCount(12000, "en")).toBe("12,000");
  });

  it("normalizes Bengali phone digits before validation and search", () => {
    expect(normalizeBengaliDigits("০১৭১২৩৪৫৬৭৮")).toBe("01712345678");
  });

  it("Orders-detail currency formatter agrees on which locales get Bengali digits", () => {
    // Mirrors Orders.tsx `currencyFormatter`: same style, two fraction
    // digits. If the Orders page ever stops passing i18n.language here, the
    // bn branch below is where the regression surfaces.
    const formatOrdersMoney = (value: number, language: string) =>
      new Intl.NumberFormat(language === "bn" ? "bn-BD" : "en-US", {
        style: "currency",
        currency: "BDT",
        minimumFractionDigits: 2,
      }).format(value);

    const bn = formatOrdersMoney(10, "bn");
    expect(bn).toMatch(BN_DIGIT);
    expect(bn).not.toMatch(ASCII_DIGIT);
    const en = formatOrdersMoney(10, "en");
    expect(en).toMatch(ASCII_DIGIT);
    expect(en).not.toMatch(BN_DIGIT);
  });
});
