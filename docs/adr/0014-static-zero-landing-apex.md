# ADR-0014: Static Zero-Landing at the Apex — Founder Design, Contract-Anchored

Status: Accepted<br>
Date: 2026-11-15<br>
Owners: Founder + Engineering<br>
Amends: [ADR-0011](0011-delivered-order-commercial-contract.md) (apex surface only; the commercial contract itself is unchanged)

## Context

ADR-0011 made the merchant landing a contract-derived React surface
(`LandingV7`): prices render from `/api/public/commercial-contract`, claims are
registry-gated, and the page fails closed when the contract is unavailable.
That doctrine produced a truthful but design-constrained page. Separately, the
2026-11-14 apex landing outage (deploy `a4f9324a`, fixed by `9124b916` / PR #262)
was a missing `QueryClientProvider` on the marketing React entry — a runtime
wiring crash, not the fail-closed contract path — but it underscored the
fragility of a render-time-dependent apex surface.

On 2026-11-15 the founder ruled that the current apex landing needs major
design improvement and approved a replacement design: a self-contained Bengali
HTML page (variant `zero_v7`, "ডেলিভারি না হলে ৳০ / ডেলিভারি হলে ৳১০") with its
own CSS, animations, calculator, and FAQ. The instruction was to ship that
design verbatim — "same style and animation and all".

A static page cannot fetch the contract at runtime, so ADR-0011's core
guarantee — *a page that hardcodes a number is a defect* — needs a different
mechanism on this surface: the number must be anchored to the frozen contract
at gate time instead of render time.

## Decision

1. **Surface.** The apex `easymod.tech/` serves
   `EasyMod-frontend/public/landing-zero.html` through a hostname-scoped Caddy
   internal rewrite (`@apexroot path /` inside the apex marketing `handle`).
   The URL stays `/` (200, no redirect), matching the page's canonical tag.
   `app.easymod.tech/` is untouched — its `/` must keep serving the merchant
   SPA root loader. All other apex paths (`/pricing`, legal pages) still serve
   the React marketing entry.

2. **Contract anchoring.** `verify-claims` gains check **(h) static-landing**:
   the page must exist and carry the contract-derived Bengali unit price
   (`৳১০` today, computed from `COMMERCIAL_CONTRACT.unitPriceMinor`) and the
   zero-rated `৳০` mark. A contract price change fails the gate until the page
   is deliberately updated. Retired `FORBIDDEN_TOKENS` are already enforced on
   the file by check (a) — `public/` is inside the `EasyMod-frontend/` scan
   scope.

3. **What stays.** `LandingV7`, its claim registry wiring, and its e2e suites
   (`tests/landing/landing.spec.ts`, `tests/e2e/public-funnel-v7.spec.ts`)
   remain in-repo and green; they guard the dev-server marketing surface. A new
   smoke suite (`tests/landing/static-landing.spec.ts`) guards the static file
   (design markers, calculator, FAQ, drawer, reduced motion, axe-critical).
   The apex rewrite itself is proven post-deploy against production, not in
   dev-server e2e.

4. **Accepted consequences.** The apex landing is Bengali-only by design (the
   React landing's en/bn switch no longer applies at `/`). The page buffers
   analytics to `window.emEvents`/`dataLayer` only; server-side funnel
   telemetry and `source=landing_zero&offer=delivered_10` signup attribution
   are explicit follow-ups, not part of this decision. The footer's `/privacy`
   link is served by a 301 to `/privacy-policy`; `/support` has no page yet
   (renders the SPA NotFound) and is a follow-up.

## Consequences

- The apex landing has **no runtime API dependency** and cannot fail closed on
  a contract outage — the 2026-11-15 outage class is structurally removed from
  this surface.
- Price drift is a **gate failure**, not a silent copy bug: any change to
  `unitPriceMinor` forces a deliberate page update in the same PR.
- Two landing surfaces now exist (static apex, React dev/e2e). They must not
  diverge on price: check (h) anchors the static one, ADR-0011 checks anchor
  the React one, both to the same frozen contract.
- Follow-ups (not blocking): funnel telemetry wiring, signup attribution,
  English variant, `/support` page.
