# Header Removal — A0 Contract Ruling (binding for all writers)

Founder mission 2026-11-26: remove the permanent page-level signal header from ALL
merchant-facing pages. Inventories: 00_SHARED / 01_PAGE_USAGE / 02_TESTS_AND_GUARDRAILS.
This file is the single integration contract; writers do NOT re-litigate it.

## C1 — PageHeader v2 (shared/dashboard/PageHeader.tsx)
New slim shape (props): `title?`, `breadcrumb?`, `meta?` (ReactNode), `titleMode?: 'compact' | 'srOnly'` (default 'compact').
- REMOVED props + rendering: `signal`, `whyHere`, `primaryAction`, `secondaryActions`,
  `loading`, `signalTestId`, `primaryTestId`, `signalAnnounce`. No global status badge,
  no explanatory summary, no action band — anywhere, including overview pages.
- Render: optional breadcrumb nav (only where deep context genuinely helps, e.g. record
  pages) + ONE `<h1>` + optional `meta` row (record-level/contextual status only —
  server-confirmed, never a global shop pulse).
- `titleMode='compact'`: visible small heading (text-base/lg) — REQUIRED for record
  pages (Customer360, channel detail) and where no AppBar-equivalent title exists.
- `titleMode='srOnly'`: heading exists in the accessibility tree but is visually
  hidden — used on list/overview pages whose sticky AppBar already shows the same
  name (kills the visual redundancy while keeping the a11y landmark; existing unit
  pins that query the level-1 heading keep passing because the accessible name stays).
- Vertical: `mb-3` max; no reserved space when meta/breadcrumb absent (conditional
  rendering only).

### C1 amendment (round-1 review, 2026-11-26) — unified title rule

- `srOnly` is legal ONLY when the resolved h1 text is BYTE-IDENTICAL to the
  sticky AppBar's visible name for that route (DashboardLayout `pageTitle` =
  matched nav item name, or the `/manage-shop` fallback `nav.settings`),
  verified in BOTH shipped locales (en.json + bn.json). Any DIFFERENT page
  title — even a near-duplicate ("Shared Inbox" vs "Inbox", "Today's work" vs
  "Home", "Delivery Settings" vs "Delivery") — MUST render
  `titleMode="compact"`.
- Rationale: with srOnly the only visible page title is the AppBar, so a
  hidden title that says something different silently deletes the page's
  identity; hiding one that is byte-equal to the AppBar is pure de-duplication.
- Flips applied by this amendment: Dashboard ("Today's work"→compact, both
  states), UnifiedInbox ("Shared Inbox"→compact; the meta row's px inset moved
  to the header wrapper so the compact line aligns — inbox-guardrails geometry
  pins header <80px / workbench y <220px hold with thresholds UNCHANGED),
  DeliverySettings ("Delivery Settings"≠"Delivery"→compact), PaymentSettings
  ("Payment Settings"≠"Payment"→compact), PoliciesTab ("Business Policies" ≠
  AppBar on either host route →compact), Customer360Page (tabbed customer hub:
  `customer360.title` = "Customers"/"কাস্টমার" == `nav.customers`
  byte-for-byte → srOnly; the record page CustomerDetailPage keeps its visible
  record-name h1), SettingsHub ("Settings" == AppBar fallback `nav.settings` →
  sr-only h1 via PageHeader, matching NotificationSettings).
- Verified-kept srOnly: Orders, Subscription ("Billing"=="Billing" both
  locales), Notifications, FaqSettings/FaqTab ("FAQs"), BusinessInfoSettings/
  ProfileTab (same `nav.*` key as the AppBar). Recorded residual:
  `orders.title` is byte-identical to `nav.orders` in EN but differs in BN
  only by the plural marker ("অর্ডার" vs "অর্ডারসমূহ"); it keeps srOnly
  because flipping would double-render the identical EN title — the honest
  long-term fix is a separate i18n alignment (bn `orders.title` wording), a
  founder call outside this branch. Tab-workspace aliasing
  (`/manage-shop/faqs` and `/manage-shop/business-info` render the same
  BusinessFaqWorkspace): tab h1s pair with their canonical nav route; on the
  alias route the visible tablist orients — accepted residual.
- Verified-kept compact: Products ("Products & Inventory" ≠ "Products"),
  Customers-list ("Customer Management" ≠ "Customers"), ChannelsOverview
  ("Channels & Automation" ≠ "Chat"), BusinessAutomationDefaults
  ("Automation defaults" ≠ "Chat"), FirstTimeSetupDashboard ×3 (onboarding
  titles ≠ "Home"), CustomerDetailPage (record name). No PageHeader site may
  add `srOnly` without the byte-identity proof for both locales.

## C2 — ActionBar.tsx deleted
Sole importer was PageHeader. Primary CTAs keep their existing homes: Refresh in
EvidenceFooter (Dashboard/FTS), Create in the Orders/Customers toolbars, Save inside
settings cards/workspaces. If any page had a CTA ONLY in the header, relocate it to
that page's most relevant existing toolbar/workflow area (per 01 inventory) — never a
new band.

## C3 — derive.ts modules
Per-module `*Signal` (and header-only `*PrimaryAction`/`whatNow` when header-fed only)
deleters: remove the function + dead tests + dead keys. KEEP anything with non-header
consumers: narratives feeding EvidenceFooter/InboxRail, AttentionQueue work groups,
record-level signals (ConnectionHealth pendingBadge, FTS task badges, AiStatusChip,
result banners, offline/emergency-stop banners, validation, onboarding guidance).

## C4 — What stays untouched
Top AppBar + sidebar + nav badges + AiStatusChip (shell); ResultBanner/error alert
regions; per-record chips inside worklists; design tokens/typography; i18n mechanism
(Bangla numerals rule); routes. Chat Settings: header removal only, zero functional
change.

## C5 — i18n discipline
Writers MUST NOT edit en.json/bn.json (single-owner sweep). Return `orphanKeys[]`
(prefix lists are fine, e.g. `orders.signal.*`) — W5 deletes after all callers are
gone and runs the translation-coverage gate. Until the sweep, orphan keys are
harmless.

## C6 — Tests: flip presentation pins, never weaken functional ones
- Signal-testid assertions (`*-signal`) flip from "renders" to "must NOT exist"
  (locator count 0) — this pins the removal itself.
- h1 pins: keep when titleMode srOnly/compact (accessible name unchanged); only
  adjust where a title genuinely goes away.
- Guardrail e2e keep-list: payload-exclusion rules, CSRF/no-CTA-in-header (superseded
  by no-header), retry/error recovery, 390/360 no-overflow, axe per scope, badge-in-body,
  navigation counts. Remove: band heights/summary copy/signal classes/action-bar
  presence pins.
- Writers run: `npx tsc --noEmit` + vitest for their own touched suites (threads pool
  if Windows forks trap). Full Playwright sweep happens in the verify wave, not per
  writer.

## C7 — Space reclamation
After removing the band, page content starts at the container top; no empty wrapper,
no min-height, no placeholder comment blocks. Verify via 390px overflow specs in the
sweep.

## C8 — Guardrails doc (W5)
Rewrite §5.2 (docs/ui/EasyModerator-UI-UX-Guardrails-v2.0.md ~164–188) which permits
the overview signal band; add an explicit prohibition: no permanent page-level signal
headers on ANY page incl. overview pages; compact page/record titles allowed per C1;
amend §29 page-purpose language so "overview pages keep full anatomy" no longer
implies a header band. Record-level signals §8 semantics unchanged (they live in
content now).
