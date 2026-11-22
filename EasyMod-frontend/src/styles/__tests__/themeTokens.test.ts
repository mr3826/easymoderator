/**
 * Design-token correctness fixtures (Guardrails v2 §7 color, §18 focus, §31 enforcement).
 * Pure Node unit test (no DOM): parses the --em-* hex tokens from theme.css and
 * independently recomputes WCAG 2.2 contrast ratios. This kills the dead-utility
 * bug class at the token layer (every token must have a Tailwind @theme mapping)
 * and pins the measured contrast record so a future token edit fails loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs from the frontend project root; theme.css lives at src/styles.
const css = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");

// Parse `--em-<name>: #RRGGBB` definitions (the :root token block).
const tokenHex = new Map<string, string>();
for (const m of css.matchAll(/--em-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) {
  tokenHex.set(m[1], m[2].toUpperCase());
}
const tok = (name: string): string => {
  const v = tokenHex.get(name);
  if (!v) throw new Error(`missing --em-${name} hex token in theme.css`);
  return v;
};

// WCAG relative luminance + contrast ratio (sRGB linearization, 0.05 offsets).
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const chan = (i: number) => {
    const c = parseInt(h.substr(i, 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}
function ratio(a: string, b: string): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ["bg-surface", "bg-app", "bg-muted"] as const;

describe("theme tokens (Guardrails v2 §7/§18/§31)", () => {
  it("defines the expected core tokens", () => {
    for (const name of [
      "bg-surface", "bg-app", "bg-muted",
      "text-primary", "text-secondary", "text-disabled",
      "border-input", "warning-700", "warning-100",
      "focus-light", "focus-dark", "midnight-900", "midnight-950",
    ]) {
      expect(tokenHex.has(name), `--em-${name}`).toBe(true);
    }
  });

  it("every --em-* hex token has a matching @theme --color-em-* mapping (no dead utilities)", () => {
    for (const name of tokenHex.keys()) {
      expect(css, `--color-em-${name} mapping`).toContain(
        `--color-em-${name}: var(--em-${name})`,
      );
    }
  });

  it("does not define the retired dead-utility shades warning-600 / violet-400", () => {
    expect(tokenHex.has("warning-600")).toBe(false);
    expect(tokenHex.has("violet-400")).toBe(false);
  });

  it("text-primary and text-secondary meet AA 4.5:1 on every surface", () => {
    for (const s of SURFACES) {
      expect(ratio(tok("text-primary"), tok(s)), `text-primary on ${s}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok("text-secondary"), tok(s)), `text-secondary on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("text-disabled meets >=3:1 on every surface (AA-exempt disabled-control improvement)", () => {
    for (const s of SURFACES) {
      expect(ratio(tok("text-disabled"), tok(s)), `text-disabled on ${s}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("placeholder role (text-secondary) meets AA 4.5:1 on every surface", () => {
    for (const s of SURFACES) {
      expect(ratio(tok("text-secondary"), tok(s)), `placeholder on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("warning-700 on warning-100 meets AA 4.5:1", () => {
    expect(ratio(tok("warning-700"), tok("warning-100"))).toBeGreaterThanOrEqual(4.5);
  });

  it("border-input meets non-text 3:1 on every surface", () => {
    for (const s of SURFACES) {
      expect(ratio(tok("border-input"), tok(s)), `border-input on ${s}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("focus-light meets 3:1 on light surfaces", () => {
    expect(ratio(tok("focus-light"), tok("bg-surface"))).toBeGreaterThanOrEqual(3.0);
    expect(ratio(tok("focus-light"), tok("bg-app"))).toBeGreaterThanOrEqual(3.0);
  });

  it("focus-dark meets 3:1 on dark surfaces", () => {
    expect(ratio(tok("focus-dark"), tok("midnight-900"))).toBeGreaterThanOrEqual(3.0);
    expect(ratio(tok("focus-dark"), tok("midnight-950"))).toBeGreaterThanOrEqual(3.0);
  });

  it("ships a .dark-scoped :focus-visible rule using --em-focus-dark", () => {
    expect(css).toMatch(/\.dark\s+\.em-[a-z]+\s+:focus-visible/);
    expect(css).toMatch(/\.dark[\s\S]*?outline:\s*2px solid var\(--em-focus-dark\)/);
  });
});