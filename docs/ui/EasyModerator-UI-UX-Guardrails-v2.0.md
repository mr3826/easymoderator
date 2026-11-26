# EasyModerator UI/UX Guardrails — v2.0

Owner: Product Design

Applies to: Coding agent, frontend engineers, designers, QA

Status: Source of truth for UI/UX decisions

Version: 2.0

Updated: 2026-11-26 (amended by the §29 header-removal addendum of the same date)

Supersedes: 2026-11-16 founder layout addendum

---

## 1. Purpose

These guardrails define how EasyModerator must look, behave, and communicate as a **merchant operations workspace**.

The product helps merchants carry out connected work across conversations, orders, products, customers, fulfillment, and related commerce workflows. The interface must support the merchant's current task, rather than make every screen look like a dashboard.

The design review must establish:

1. Why the merchant is in this workflow.
2. What the merchant can do or inspect now.
3. What happens after an action or where the work continues.
4. What trustworthy information or feedback establishes the current state.

These are **design questions, not required visible headings or page regions**. A page passes when the answers are apparent in its normal workflow.

Every screen must reduce confusion, protect merchant trust, and move the workflow forward without consuming useful work space with redundant framing.

---
## 2. Product Philosophy

EasyModerator is not a marketing site. It is an operational console.

### Action-first, not header-CTA-first

An action must be discoverable **where the merchant performs the work**. This does not imply that every screen needs a header CTA, a primary action bar, or even a write action.

Rules:

- Put actions next to the records, fields, conversation, or decision they affect.
- Use one visually dominant action **per decision context**, not one global button for an entire multi-action workspace.
- Row actions, a conversation composer, contextual selection actions, and a form's Save button can coexist when each has a distinct scope.
- Do not manufacture a CTA for a read-only report or for a screen that is primarily for scanning and selecting.
- Avoid decorative or explanatory elements that repeat information already clear from navigation, status, or content.
- For a waiting or blocked workflow, explain the blocker and an actionable recovery path, when one exists.

### Merchant-centric

Commerce decisions affect real merchants and their customers. The UI must show impact clearly.

Rules:

- Show relevant merchant, customer, order, channel, or product context at the point of decision.
- Explain consequences in plain language, especially for financial, customer-facing, or irreversible actions.
- Never present destructive actions as casual or irreversible without warning.
- Show evidence for high-impact claims; do not force an evidence panel onto ordinary lists and forms.

### Workflow-first

EasyModerator must support fast, repeatable workflows.

Rules:

- Preserve filters, selected records, scroll position, and draft content when navigating between tasks, where applicable.
- Support keyboard navigation for common execution tasks.
- Minimize full-page reloads during queue, table, and conversation work.
- Give feedback where the action occurred and preserve the work surface.
- Classify the screen's purpose before choosing layout or component hierarchy.

---
## 3. Primary Brand Direction

**Brand theme:** Midnight / Violet / Sunlight

**Visual concept:** Commerce Signal

**Emotional direction:** Calm control, clear priority, evidence-based trust.

### Brand meaning

| Color | Meaning |
|---|---|
| Midnight | Structure, stability, operational control |
| Violet | Intelligence, decision-making, primary action |
| Sunlight | Attention, merchant priority, needed action |

### Visual concept: Commerce Signal

EasyModerator should feel like a signal system for commerce health.

The interface must surface signals, not noise.

A signal is anything that tells the merchant or moderator:

- Something needs attention.
- Something is blocked.
- Something is safe to continue.
- Something requires evidence.
- Something has been resolved.

Use visual signals only when they help the user choose the next action.

---

## 4. Core Design Test — semantic, not a mandatory page layout

Every important screen must satisfy the following questions **through its interaction model**. Do not render the labels `WHY HERE`, `WHAT NOW`, `WHERE NEXT`, or `PROVEN RESULT` as page sections merely to satisfy the test.

| Design question | What must be understandable | Can be communicated by |
|---|---|---|
| **WHY HERE?** | Current object, view, task, state, or reason for attention | Selected navigation item, filter, record identity, row status, or setup step; an explanatory summary only if useful |
| **WHAT NOW?** | Available next work or useful interpretation | Search, filters, table rows, composer, scoped buttons, form fields, drilldowns, or clear read-only data |
| **WHERE NEXT?** | Destination or transition after interaction | Open detail, saved state, route, close drawer, next conversation, or continued view; a persistent footer is not required |
| **PROVEN RESULT** | Reliable status of data or outcome | Updated row state, provider status, persisted value, confirmation message, timestamp, audit event, or visible error; show after the event when appropriate |

### Interpretation rules

- The four questions belong in the **design specification and acceptance review**, not necessarily in visible UI copy.
- Before an action, `PROVEN RESULT` may mean the current known state; afterward, it must reflect the actual outcome. Never claim completion while an asynchronous result is pending.
- A data-only screen may have no primary write action. Browsing, filtering, or drilling into data can be its useful next step.
- Display only evidence relevant to the task. Ordinary Orders lists do not need policy references, audit banners, or merchant-impact essays.
- An action must not appear successful merely because a local UI state changed before the server confirmed persistence.
- If a question is genuinely not applicable, document **N/A with a reason** rather than adding artificial UI.

### Design-spec contract, not required React props

```ts
type DesignReview = {
  pageKind: PageKind;
  merchantGoal: string;
  whyHere: string;
  whatNow: string;
  whereNext: string;
  provenResult: string | "N/A — no action or outcome in this state";
  visiblePlacement: string; // where the UI actually communicates these
};
```

**Do not** require every page component to accept four string props. Those are review questions, not a universal UI component API.

---
## 5. Screen Anatomy — choose by page purpose

**Normative rule:** There is **no universal screen anatomy** for EasyModerator. The original five-band layout is a **dashboard/overview template only**. Never copy it automatically to Orders, Inbox, Products, Customers, details, settings, or reports.

### 5.1 Classify before drawing the layout

| Page archetype | Merchant intent | Typical areas | Layout priority |
|---|---|---|---|
| **Overview / dashboard** | Understand shop health and choose a workflow | Dashboard, operational overview | Orientation, prioritized signals, action entry points |
| **Execution workspace** | Scan, find, select, process, or communicate | Orders list, Inbox, product/customer lists, fulfillment queue | Maximum usable work area, fast scanning, scoped actions |
| **Record detail / decision** | Understand or act on one entity | Order detail, conversation detail, customer or product record | Identity, relevant facts, contextual actions and outcome |
| **Configuration / editor** | Change controlled settings or content | Business and chat settings, product editor, automation editor | Field clarity, validation, save/publish state |
| **Analytics / investigation** | Compare data, find causes, inspect evidence | Reports, Growth OS analytics | Filters, definitions, comparable metrics, drilldown |
| **Setup / onboarding** | Complete a prerequisite sequence | Channel connection, initial setup | Progress, next step, prerequisites and recoverable errors |

These are **design archetypes**, not claims that each route or feature already exists. Use only workflows supported by the product implementation.

### 5.2 Overview / dashboard anatomy

Orientation on an overview page is owned by the persistent shell AppBar and by the prioritized work modules themselves — **not** by a page-level header band. The 2026-11-26 addendum (§29) retires the original signal band from this archetype too: permanent page-level signal headers are prohibited on **every** page, overviews included.

```text
+--------------------------------------------------------------+
| Compact page name (small visible heading, or screen-reader-   |
| only when the shell already shows the same name)              |
| Breadcrumb / context (only where deep context genuinely helps)|
+--------------------------------------------------------------+
| Prioritized work modules — attention queues and entry points  |
| live in their own rows, chips, and cards, never in a hero band |
+--------------------------------------------------------------+
| Operational evidence, metrics, and workflow modules           |
+--------------------------------------------------------------+
| Next-step or result area (only when context requires it)      |
+--------------------------------------------------------------+
```

Dashboard rules:

- No permanent global-status badge ("this shop's pulse"), no `WHY HERE` explanatory summary paragraph, and no generic top action band — on overview pages exactly as on execution pages.
- Page titles stay compact: a small visible heading, or an accessible screen-reader-only `<h1>` when the AppBar owns the visible name. One heading, never two visible page names.
- Surface a meaningful, prioritized next workflow **inside the work module it belongs to** (queue row, toolbar, workflow card) — never an arbitrary global CTA. Header-only CTAs move to that page's existing toolbar/workflow area; nothing invents a replacement band, and removal reserves no empty space.
- Make metrics actionable or clearly diagnostic; disclose stale or delayed data.
- Do not repeat a status or explanation in both a header and a card; status now lives on records, modules, and results only.
- A next-step footer is optional, not an empty region to be filled.

### 5.3 Execution workspace anatomy — Orders is the reference

The **Orders list does not require** a large page title, global status signal, `WHY HERE` paragraph, top-level primary action bar, `WHAT NOW` subtitle, or next-step footer.

```text
+--------------------------------------------------------------+
| Existing app navigation / active Orders section               |
+--------------------------------------------------------------+
| Search | status/date filters | tabs/views | compact counts    |
+--------------------------------------------------------------+
| Orders work surface: list/table/cards, sort, select, open     |
| Each record: identity, operational state, relevant actions   |
| [Bulk actions appear only when selection warrants them]      |
+--------------------------------------------------------------+
| Inline result / toast / detail drawer, only when triggered    |
+--------------------------------------------------------------+
```

Orders-specific rules:

- The **work surface is the page**. Put search, status filters, sorting, and useful records above editorial content.
- A small label such as `Orders` is acceptable when needed for orientation. It is **not** permission for a tall title-and-summary block. An accessible heading can be visually hidden when navigation already identifies the section.
- Show multiple order statuses **at record level**. Do not derive an artificial single page-wide status.
- Put order-specific actions in the row, selected-record drawer, or detail view. Show bulk actions only after valid selection, with affected count and confirmation where needed.
- If a legitimate global creation/import action exists, it may be a **compact toolbar control**, not a mandatory hero CTA. Do not invent a capability to fill the toolbar.
- Show updates or failed operations near the affected order and preserve filters, selection, and position.
- Preserve density without hiding payment, delivery, or fulfillment exceptions relevant to the merchant's task.

### 5.4 Conversation execution anatomy — Inbox

```text
+--------------------------------------------------------------+
| Compact view controls, inbox filters, and useful counts       |
+------------------+----------------------+--------------------+
| Conversation list| Active conversation  | Context / AI /      |
|                  | messages + composer  | order evidence      |
+------------------+----------------------+--------------------+
| Inline delivery, handoff, pending, or error feedback          |
+--------------------------------------------------------------+
```

Inbox rules:

- Preserve visible conversation and composer space. Do not add a header CTA or `WHY HERE` paragraph.
- Show channel, AI/human control, delivery status, or handoff signals **where the conversation decision occurs**.
- On small screens, adapt the columns to a navigable stack without losing the active draft.
- A status rail or panel is only justified when it supports the active conversation.

### 5.5 Record detail / decision anatomy

```text
+--------------------------------------------------------------+
| Compact identity: Order # / customer / status / back          |
+--------------------------------------------------------------+
| Primary record facts and evidence relevant to the task       |
| Contextual actions beside the affected field or state        |
+--------------------------------------------------------------+
| Related timeline, fulfillment/payment data, or history        |
+--------------------------------------------------------------+
| Result feedback where the change occurred                    |
+--------------------------------------------------------------+
```

A record **needs its own status** when that status affects a decision; this is different from the unnecessary **page-wide status signal** on the Orders list. For destructive or consequential decisions, show relevant evidence and impact close to the control.

### 5.6 Configuration / editor anatomy

Use concise context, grouped settings/fields, validation near inputs, and Save/Publish actions at a stable point of action. Show saved/unsaved state; scope changes to the correct channel, workspace, or conversation. Do not add a dashboard-style status summary or generic action band.

### 5.7 Analytics / investigation anatomy

Show date range, segment, metric definitions, comparison, and drilldown controls first. Present provenance, freshness, and important limitations near the numbers. Do not invent `WHAT NOW` CTAs or claim operational outcomes from a metric alone.

### 5.8 Setup / onboarding anatomy

Show current step, prerequisite, required input, recovery instructions, and a clear next/finish action. A step progress indicator is useful; a dashboard-style evidence panel or footer is not mandatory.

### 5.9 Mixed-purpose screens and exceptions

1. Classify by the **primary task for which the merchant entered the page**.
2. Keep secondary work in tabs, drawers, panels, or drilldowns only when this is simpler than navigation.
3. Do not use a page kind to hide mandatory safety context, permissions, critical errors, or irreversible-action confirmation.
4. Do not introduce extra headers, summaries, cards, or empty footer areas simply to satisfy the original template.
5. On mobile, prioritize the active work and accessible controls over preserving desktop geometry.

---
## 6. Information Hierarchy — conditional on task

Information priority depends on the merchant's intent. Do **not** apply one ordered hierarchy to every screen.

| Page kind | Recommended reading / working order |
|---|---|
| **Overview** | Attention signals → operational meaning → prioritized workflow → supporting data |
| **Orders / list execution** | Search and filters → scannable records → record status → contextual action → result |
| **Inbox / conversation execution** | Conversation selection → messages and customer context → composer/handoff controls → send/provider outcome |
| **Record detail** | Entity identity and relevant status → decision facts/evidence → contextual action → timeline/outcome |
| **Configuration** | Scope and setting name → fields and constraints → save/confirm → persisted state |
| **Analytics** | Time range and definition → key comparison → breakdown/drilldown → source and freshness |
| **Setup** | Step and prerequisite → required input → validation → next step and confirmation |

General rules:

- Critical customer or merchant impact must be visible **at the point of decision**.
- In a workspace, many rows may each have their own valid status and next action.
- Secondary operations must not visually compete with the action in the active decision context.
- History and audit belong near the record or action they explain, not on every page by default.

---
## 7. Color System

### Core palette

| Token | Hex | Role |
|---|---:|---|
| Midnight | `#17223B` | Primary text, dark shell, structural surfaces |
| Violet | `#7460D9` | Primary action, active state, decision focus |
| Sunlight | `#F4C35E` | Attention, merchant action needed, important highlight |

### Extended tokens

Use these derived tokens for implementation.

```css
:root {
  /* Midnight */
  --em-midnight-950: #0B1222;
  --em-midnight-900: #17223B;
  --em-midnight-800: #1E2C4D;
  --em-midnight-700: #26375F;
  --em-midnight-600: #324777;
  --em-midnight-200: #C8D2E7;
  --em-midnight-100: #E7ECF5;
  --em-midnight-50: #F5F7FB;

  /* Violet */
  --em-violet-900: #322763;
  --em-violet-700: #5D49BE;
  --em-violet-600: #7460D9;
  --em-violet-500: #8A78E3;
  --em-violet-300: #BBAFF2;
  --em-violet-100: #EEEBFB;
  --em-violet-50: #F8F7FE;

  /* Sunlight */
  --em-sunlight-700: #8A5E00;
  --em-sunlight-600: #C08A1E;
  --em-sunlight-500: #F4C35E;
  --em-sunlight-300: #F9DA96;
  --em-sunlight-100: #FCF1D9;
  --em-sunlight-50: #FEF9EE;

  /* Neutrals derived from Midnight */
  --em-bg-app: #F5F7FB;
  --em-bg-surface: #FFFFFF;
  --em-bg-muted: #EDF1F8;
  --em-border: #D7DEEB;
  --em-border-strong: #B8C4DA;
  --em-text-primary: #17223B;
  --em-text-secondary: #4C5B7A;
  --em-text-disabled: #8A97B0;

  /* Semantic */
  --em-success-700: #256D4F;
  --em-success-100: #E2F2EB;
  --em-warning-700: #9A5B00;
  --em-warning-100: #FDF0D7;
  --em-danger-700: #B3372F;
  --em-danger-100: #FBE8E6;
  --em-info-700: #324777;
  --em-info-100: #E7ECF5;
}
```

### Color usage rules

| Color | Use | Do not use for |
|---|---|---|
| Midnight | Text, navigation shell, headers, structural contrast | Large decorative gradients |
| Violet | Primary buttons, links, active filters, selected state | Error, warning, destructive states |
| Sunlight | Attention badges, merchant action needed, important highlights | Default buttons, backgrounds, body text |
| White text | On Midnight or Violet | On Sunlight |
| Midnight text | On Sunlight and light surfaces | White text replacement |

### Contrast rules

- Body text must meet WCAG AA contrast.
- White text on `#7460D9` is acceptable for buttons and badges.
- White text on `#F4C35E` is not acceptable. Use Midnight text.
- Sunlight must never be used as the only indicator of status.
- Disabled controls must still be readable, but clearly inactive.

---

## 8. Signal System

Use signals to communicate workflow state, not to decorate page headers.

| Signal | Meaning | Color treatment |
|---|---|---|
| Healthy | No action needed | Neutral or success |
| Attention | Merchant should review soon | Sunlight |
| Review | Decision required | Violet |
| Blocked | Action prevented until resolved | Danger |
| Resolved | Completed and verified | Neutral/success |
| Pending | Waiting for system or external response | Neutral/info |

### Signal rules

- Every signal must include a meaningful label, not only color.
- Every signal should include an icon when space allows and when it improves scanning.
- Use **one dominant signal per focal decision or record**, not necessarily one for the entire page. Since the 2026-11-26 addendum these signals live **in content** — record rows, module cards, result banners, validation, onboarding guidance, offline/emergency banners — never in a permanent page-level header badge.
- Lists may show different statuses on different rows; this is expected and must not be collapsed into a fabricated page-wide signal.
- Summaries belong in a dashboard or relevant operational aggregate, not automatically above every table.
- Signals must be readable by screen readers.
- Distinguish internal UI state from server/provider-confirmed state. Use `Pending` until the outcome is confirmed.

Example row label:

```text
[!] Payment review needed
```

Not:

```text
[yellow dot]
```

---
## 9. Typography

Use a clean system font stack.

```css
font-family:
  "Inter",
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  Roboto,
  Helvetica,
  Arial,
  sans-serif;
```

### Type scale

| Element | Size | Weight | Usage |
|---|---:|---:|---|
| Overview/page title | 24px | 600 | When a standalone visible title aids orientation, e.g., dashboard or setup |
| Compact workspace label | 16–20px | 600 | Optional identifier on Orders, Inbox, and similar execution pages |
| Section title | 18px | 600 | Panels, forms, cards |
| Card title | 16px | 600 | List items, modules |
| Body | 14px | 400 | Default content |
| Small text | 12px | 500 | Metadata, captions |
| Data/table text | 13px | 400/500 | Tables, operational logs |

### Typography rules

- Use sentence case, not title case.
- Use tabular numbers for IDs, dates, amounts, and counts.
- Avoid text below 12px.
- Avoid all caps except small status labels.
- Keep helper text visible when it prevents mistakes.
- Maintain an accessible heading structure, but **do not require a large visible title block** when the active app navigation already establishes the screen. A visually hidden heading is acceptable where appropriate.

---
## 10. Spacing and Layout

Use an 8px base grid.

### Spacing scale

```text
4px   micro spacing
8px   compact spacing
12px  related field spacing
16px  card padding, small section spacing
24px  panel spacing
32px  major section spacing
48px  page-level spacing (not mandatory on dense workspaces)
```

### Layout rules

- Use a 12-column grid for dashboard or content layouts **when it helps**. Do not force a table or Inbox into a 12-column card composition.
- Use `1440px` as a reference maximum for standard content pages, **not a hard cap** on dense Orders tables or multi-pane Inbox workflows. Those may use the available workspace width.
- Use readable line length for long text: `60ch` to `80ch`.
- Keep the **next task action** discoverable where it is performed; a global CTA does not have to appear above the fold.
- Tables may be dense, but interactive rows need at least `44px` touch/click height where practical; maintain usable mobile targets.
- Avoid large top padding and stacked banners that reduce the first-screen view of records.
- Use drawers and contextual panels when they preserve scanning context; do not open full-page routes for minor edits without reason.
- Respect safe areas, sticky controls, and scrolling behavior on small displays.

---
## 11. Buttons

Use **one visually dominant action per decision context**. A decision context may be a form, selected order, conversation composer, confirmation dialog, or single dashboard recommendation.

A multi-record execution workspace may contain many scoped actions. It does **not** need a single global primary button and must not hide essential operations to comply with an artificial one-per-page limit.

### Button hierarchy

| Variant | Use | Visual |
|---|---|---|
| Primary | Main safe action in the current decision context | Violet background, white text |
| Secondary | Alternative action | White background, Midnight border, Midnight text |
| Ghost | Low-emphasis action | Transparent background, Midnight/Violet text |
| Danger | Harmful or irreversible action | Danger background or danger outline |
| Attention | Merchant-facing priority, not default CTA | Sunlight background, Midnight text |

### Button labels

Use verb-first labels.

Good:

```text
Save changes
Confirm order
Request evidence
Assign conversation
```

Bad:

```text
Submit
OK
Confirm
Proceed
```

### Button rules

- Do not disable a button without explaining why.
- Do not use Sunlight for generic primary actions.
- Destructive actions require appropriate confirmation.
- Async actions must show loading, success, and error states.
- Show bulk controls only when selection makes them relevant; state the number of affected records.
- A header CTA must be justified by an actual cross-record workflow, not added because a template requires one.

---
## 12. Forms

Forms must prevent mistakes before they happen.

### Required form behavior

- Labels must always be visible.
- Do not rely on placeholder text as the only label.
- Show helper text when a field affects merchant outcomes.
- Validate inline near the field.
- Explain the consequence of the input.
- Preserve input when validation fails.

### Example

```text
Rejection reason
Required. This message will be shown to the merchant.

[Textarea]

The merchant will see this reason and can submit new evidence.
```

### Dangerous form rules

For irreversible actions:

- Show what will change.
- Show who is affected.
- Require explicit confirmation.
- Use danger styling.
- Do not make destructive action the default focused button.

---

## 13. Tables and Queues

EasyModerator is workflow-heavy. Tables and queues must support fast scanning.

### Column selection is domain-specific

The original moderation queue column pattern remains valid **only for an actual moderation/review queue**:

| Moderation queue column | Purpose |
|---|---|
| Signal | Priority/status |
| Item | What is being reviewed |
| Merchant | Merchant name or ID |
| Reason | Why it needs review |
| Updated | Last meaningful change |
| Action | Next available action |

Do **not** apply this column set to Orders, Products, Customers, or Inbox by default.

For an **Orders list**, select visible columns from the merchant's actual work, such as order identity, customer, relevant payment/fulfillment state, amount, update time, and contextual action. Include a field **only if the product has reliable data for it**. On narrow layouts, prioritize identity, decision-relevant status, and immediate access to details rather than horizontally compressing everything.

### Table rules

- Row click should open details when it does not conflict with row controls.
- Keyboard navigation must be supported.
- Use sticky headers for long queues when helpful.
- Use truncation with tooltip only when the full value is available elsewhere.
- Do not hide critical status only in icons.
- Support search, filtering, sorting, pagination or virtualization as justified by actual scale.
- Preserve selection, filters, and scroll position after contextual actions, where feasible.
- Batch operations must disclose affected count and partial failure, and avoid ambiguous silent skips.
- Use empty and error states **inside the work surface**; do not replace them with an unrelated dashboard banner.

---
## 14. Cards and Panels

Use cards to group related information or actions **when grouping helps**, not as a default wrapper for every table, filter, and work area.

### Card rules

- One card should have one job.
- Card title must describe the content.
- Card actions must be visible on focus/hover and accessible by keyboard.
- Do not place more than two actions inside a card unless in overflow menu.
- Favor direct table, split-pane, or field layouts over nested cards in high-frequency workflows.

### Evidence is proportional to the decision

For a high-impact moderation decision, relevant evidence may include:

- Item identity and merchant context
- Trigger and reason
- Rule or policy reference, **if applicable**
- Timestamp and signal source
- Supporting screenshot/log, if available

For an order, conversation, or product decision, use **commerce-specific evidence**, such as authoritative status, actor, timestamp, provider outcome, or before/after value. Do not require a policy reference, merchant ID panel, or separate evidence card on every execution screen.

---
## 15. Navigation

Navigation must answer: where am I, what can I do, where can I go next.

### Navigation requirements

- Show the active section in the app navigation.
- Use breadcrumbs **when hierarchy is deep or return context is ambiguous**; omit redundant breadcrumbs on top-level Orders and Inbox workspaces.
- Provide an accessible page or view name. It may come from navigation and a compact label rather than a large visible title block.
- Preserve filters, selected record, drafts, and scroll position when moving between a work surface and a record detail, where feasible.
- Provide clear back/close behavior for drawers and nested details.

### Navigation rules

- Do not use ambiguous labels.
- Do not create dead-end screens.
- Every empty state must offer a useful explanation and next step when one exists.
- After an action, keep the merchant in the current work context unless the next task requires navigation.
- Do not add `WHERE NEXT` footers to lists merely to satisfy the design review.

---
## 16. States

Every interactive component must define these states:

- Default
- Hover
- Focus
- Active
- Disabled
- Loading
- Error
- Success

### Loading

- Use skeletons for page-level loading.
- Preserve layout.
- Disable only actions that could cause inconsistent state.
- Show estimated wait time if the operation is slow.

### Empty

Empty states must explain:

1. Why the area is empty.
2. What the user can do.
3. What happens after the action.

Example:

```text
No items need review right now.
New merchant reports will appear here.
You can return to the dashboard or adjust filters.
```

### Error

Error messages must say:

1. What failed.
2. Why it matters.
3. What the user can do.

Example:

```text
Could not save rejection reason.
Your changes were not applied.
Retry, or copy your note and refresh the page.
```

### Success

Success messages must include evidence.

Example:

```text
Listing approved.
Listing ID: 8842-193
Status updated at 14:22 UTC.
Next: Merchant will be notified.
```

---

## 17. Feedback and Confirmation

Use feedback only when it helps the user trust the result.

### Toast rules

Use toasts for short, non-blocking confirmations.

Good:

```text
Evidence request sent.
```

Bad:

```text
Success!
```

### Confirmation modal rules

Use modals when the action is destructive, costly, or hard to undo.

A confirmation modal must include:

- Title with the action name
- Impact summary
- Evidence or affected count
- Cancel action
- Explicit confirm action

Example:

```text
Reject merchant payout?

This will block payout #7741 until new evidence is submitted.
The merchant will be notified.

Cancel          Reject payout
```

---

## 18. Accessibility

Accessibility is a launch requirement, not a polish task.

### Minimum requirements

- WCAG 2.1 AA contrast.
- Visible focus indicator on all interactive elements.
- Keyboard access for all actions.
- No information conveyed by color alone.
- Touch/click targets at least `44px` where practical.
- Form errors linked to fields.
- Modals trap focus and restore focus on close.
- Status changes announced politely to screen readers.

### Focus ring

```css
:root {
  --em-focus-light: #7460D9;
  --em-focus-dark: #F4C35E;
}
```

Use Violet focus on light surfaces.

Use Sunlight focus on dark surfaces.

---

## 19. Motion

Motion should explain change, not decorate.

### Motion rules

- Duration: `100ms` to `200ms` for micro interactions.
- Duration: `200ms` to `300ms` for panels and modals.
- Avoid parallax, bounce, or attention-grabbing animation.
- Respect reduced motion settings.

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 20. Content and Microcopy

Write in plain, operational language.

### Tone

- Calm
- Direct
- Evidence-based
- Non-blaming
- Merchant-aware

### Button formula

```text
[Verb] + [object] + [optional outcome]
```

Examples:

```text
Approve listing
Request evidence
Escalate to finance
Restore merchant access
```

### Status formula

```text
[State] + [reason] + [next step]
```

Example:

```text
Blocked: Missing tax document. Upload required before payout.
```

### Error formula

```text
What happened + impact + what to do
```

Example:

```text
Upload failed. Evidence was not saved. Try a file under 10 MB.
```

---

## 21. Page Templates — examples, not universal requirements

These templates describe **how to design a page kind if that workflow exists**. They are not a feature inventory and do not authorize agents to create unsupported moderation, payout, automation, analytics, or fulfillment capabilities.

### 21.1 Dashboard / Overview

Purpose: Show what needs attention now through prioritized work modules. No explanatory header band and no page-level status badge (2026-11-26 addendum).

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | Merchant is checking the current business state. |
| WHAT NOW? | Open the most important relevant workflow or investigate a signal. |
| WHERE NEXT? | Move to the selected task, queue, or report. |
| PROVEN RESULT | Data freshness and verified operational state are visible. |

Useful modules, when backed by reliable data:

- Attention needed
- Orders or conversations needing action
- Blocked/pending work
- Recently completed work
- Relevant activity summary

Rules:

- The §5.2 overview anatomy applies here — including its prohibition of a permanent page-level signal header. "Overview pages keep full anatomy" has meant, since 2026-11-26, full **content** anatomy: the header band is no longer part of it.
- Attention entry points are queue rows, chips and workflow cards, not a hero CTA.
- Do not show vanity metrics without meaning or action.
- Each actionable metric must link to a real workflow.
- Show stale data warnings if synchronization is delayed.

---

### 21.2 Review Queue (only if that workflow exists)

Purpose: Process review items quickly and safely.

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | The selected list and filters identify items needing review. |
| WHAT NOW? | Open an item, filter, or select eligible records. |
| WHERE NEXT? | Item detail or contextual batch result. |
| PROVEN RESULT | Row status and affected count update after confirmed action. |

Possible elements:

- Saved filters
- Bulk selection when supported
- Signal column when meaningful
- Row-level action
- Empty queue state

Rules:

- Use **execution workspace** anatomy, not the dashboard anatomy.
- Bulk actions must show affected count; destructive actions require confirmation.
- Preserve filters after returning from detail.

---

### 21.3 Record Detail / Decision

Purpose: Inspect one entity and make a supported decision.

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | Compact record identity and the selected state establish context. |
| WHAT NOW? | Show safe controls next to the facts they affect. |
| WHERE NEXT? | Stay on the updated detail, return to the list, or open a related record. |
| PROVEN RESULT | Persisted state and applicable audit/provider outcome are visible. |

Suggested layout:

```text
Header: compact record identity, relevant status, back
Main: primary facts and evidence
Contextual area: action and consequence, when needed
Related area: history, timeline, associations
```

Rules:

- Use the record-specific details appropriate to an order, customer, product, or conversation.
- Show confirmation and scope for destructive or high-impact actions.
- Do not automatically add a separate evidence rail or footer to low-risk details.

---

### 21.4 Merchant / Customer Profile

Purpose: Show relevant identity, history, and relationships when the product actually provides them.

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | A selected profile or linked record establishes identity. |
| WHAT NOW? | Inspect history or use supported profile actions. |
| WHERE NEXT? | Related order/conversation or back to filtered list. |
| PROVEN RESULT | Profile changes and applicable history reflect saved state. |

Possible modules, subject to permissions and data availability:

- Identity and contact context
- Linked conversations and orders
- Relevant status/history
- Notes or documents if supported

Rules:

- Do not display sensitive data without permission checks.
- Do not invent risk scores or unsupported profile actions.

---

### 21.5 Rules / Automation Editor (only if supported)

Purpose: Manage an automation or rule safely.

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | Selected rule and scope identify the object being edited. |
| WHAT NOW? | Configure, preview, test, or update a supported rule. |
| WHERE NEXT? | Save and return, or inspect its actual execution results. |
| PROVEN RESULT | Confirmed rule state, version, or test outcome is visible. |

Rules:

- Use **configuration/editor** anatomy, not an overview header and CTA stack.
- Show impact preview and affected scope when available and necessary.
- Confirm dangerous automation changes and preserve a safe recovery path.
- Do not imply execution success from configuration-save success.

---

### 21.6 Settings

Purpose: Configure a workspace, channel, business, or conversation safely.

Core Design Test:

| Question | Answer |
|---|---|
| WHY HERE? | Settings scope, selected channel, or conversation establishes context. |
| WHAT NOW? | Inspect or edit relevant fields. |
| WHERE NEXT? | Saved state or the affected workflow. |
| PROVEN RESULT | Persisted values, errors, and applicable actor/time are visible. |

Rules:

- Use **configuration/editor** anatomy, not a generic dashboard layout.
- Separate personal, workspace, channel, and conversation scopes where supported.
- Clearly identify the entity affected by the setting.
- Show permission level and validation.
- Use a danger zone only for irreversible operations.

---

### 21.7 Orders List / Orders Workspace

Purpose: Find, scan, and act on orders efficiently.

Required layout: **§5.3 execution workspace**.

- Start with relevant search, filters, views, counts, and the records themselves.
- Show order statuses in rows and details, not in a page-wide hero status.
- Place actions beside the selected order or in a contextual toolbar for selected records.
- Show server-confirmed changes, errors, and partial outcomes near affected records.
- Preserve list context when opening and returning from details.
- **Do not add** `WHY HERE` copy, `WHAT NOW` heading, universal action bar, tall page header, or forced result footer.

---

### 21.8 Inbox / Conversation Workspace

Purpose: Read, respond, hand off, and inspect relevant conversation context.

Required layout: **§5.4 conversation execution**.

- Prioritize conversation list, active message history, composer, and active customer/order context.
- Place channel/AI/handoff/delivery indicators near their operational control or message.
- Preserve drafts when changing panels or returning from related records.
- Avoid introductory summary copy and global header CTA.
- Use actual provider response as delivery evidence; never equate button click with delivery.

---

### 21.9 Products and Customers Lists

Purpose: Search, compare, select, and open records.

- Use **execution workspace** anatomy.
- Select table/card fields according to merchant tasks and reliable data.
- Use contextual row/detail actions; compact global controls are permitted only when justified.
- Do not copy the Orders column set, the review-queue template, or dashboard header into these modules.

---

### 21.10 Analytics / Growth Reports

Purpose: Explore performance and verified outcomes.

- Use **analytics/investigation** anatomy.
- Show scope, date range, metric definition, breakdown, and drilldown before decorative summaries.
- Distinguish observed data from inference or projected benefit.
- State freshness and limitations; provide no fake actionable CTA.

---

### 21.11 Connection / Onboarding Flows

Purpose: Complete prerequisite steps safely.

- Use **setup/onboarding** anatomy.
- Show the current step, required permissions/prerequisites, result, and recovery.
- Keep one main next-step action within the active step.
- Do not force dashboard metric cards or five-band anatomy into setup.

---
## 22. Visual Do / Don’t

### Do

- Use Midnight for structure.
- Use Violet for the active decision's primary control.
- Use Sunlight only for meaningful attention.
- Show relevant evidence at high-impact decision points.
- Use labels with status colors.
- Keep one dominant action **per decision context**.
- Prioritize work surface area on Orders, Inbox, and other execution pages.
- Use clear verbs and compact, contextual feedback.

### Don’t

- Don’t use Sunlight as the default button color.
- Don’t use color alone to communicate status.
- Don’t hide relevant merchant/customer impact.
- Don’t add decorative illustrations to high-frequency workflow surfaces.
- Don’t add multiple competing primary buttons to one decision panel.
- Don’t invent a global primary CTA, `WHY HERE` header, or next-step footer on execution pages.
- Don’t use vague action labels such as “Handle” or “Process”.
- Don’t show success without a confirmed result.

---
## 23. Coding Agent Decision Rules

When generating or modifying UI, the agent must follow this order:

1. Preserve user safety and data integrity.
2. Identify the page's **merchant goal and archetype** (§5.1).
3. Preserve and prioritize the actual work surface.
4. Place the next action **at its relevant task or record**.
5. Show contextual evidence and server/provider-confirmed results.
6. Maintain accessibility, responsiveness, and existing product behavior.
7. Apply brand styling and restrained visual polish.

### If requirements conflict

Choose in this order:

```text
Merchant safety and accurate outcomes
Task completion and workflow clarity
Accessibility and correct responsive behavior
Existing navigation and interaction consistency
Visual polish
```

### Before generating a page

The agent must determine:

```text
- What is the merchant trying to complete on this page?
- Which page archetype fits that task (overview / execution / detail /
  configuration / analytics / setup)?
- Which existing UI and backend capabilities actually support the task?
- What is the smallest useful context and where should it appear?
- What are the scoped actions, risks, and confirmation needs?
- What information proves the current state or completed action?
- Does the proposed layout preserve the useful work area?
- Which parts of the four-question design review are already satisfied
  by navigation, rows, content, or existing controls?
```

### Before generating a component

The agent must check:

```text
- Is this component necessary for the merchant's task?
- Is its placement contextual rather than template-driven?
- Does it have visible focus and accessible labeling?
- Are loading, disabled, error, and success states handled as relevant?
- Does it use approved tokens and avoid color-only meaning?
- Does it preserve existing state and workflows?
```

### Explicit rejection rules

A design or generated UI must be revised if it:

- Adds a dashboard-style `WHY HERE` / `WHAT NOW` header to Orders or Inbox.
- Adds a page-wide primary CTA just because a generic component requires one.
- Adds an artificial aggregate status above a list of independently statused records.
- Adds a footer/banner that duplicates row-level outcome feedback.
- Replaces an efficient table/split pane with stacked explanatory cards.
- Creates a feature or action not verified in the product implementation.

---
## 24. Component Contract — conditional composition

**These are illustrative UI contracts.** Reuse existing components when practical. Do not create or rewrite a component just to satisfy these type shapes.

### Screen kind

```ts
type PageKind =
  | "overview"
  | "execution"
  | "detail"
  | "configuration"
  | "analytics"
  | "setup";
```

### PageHeader — optional composition (slim, since 2026-11-26)

```ts
type PageHeaderProps = {
  title?: string;                    // compact visible heading or sr-only
  titleMode?: "compact" | "srOnly";  // default "compact"
  breadcrumb?: BreadcrumbItem[];     // only where deep context genuinely helps
  meta?: ReactNode;                  // record-level/contextual status only
};
```

The former `signal`, `whyHere`/`summary`, `primaryAction`, `secondaryActions` slots are **retired props — not optional, not permitted anywhere** (2026-11-26 addendum, §29): a page may not render a permanent global-status badge, explanatory summary paragraph, or generic action band. The `meta` row carries only record-level, server-confirmed contextual status (never a shop-wide pulse). The header renders nothing when it has no title, breadcrumb, or meta — removal reserves no vertical space. Page-scoped actions keep their existing toolbar/workflow homes. Execution pages may render no separate `PageHeader` at all if navigation and the work toolbar provide enough orientation.

### WorkbenchToolbar — execution pages

```ts
type WorkbenchToolbarProps = {
  search?: SearchControl;
  filters?: FilterControl[];
  views?: ViewOption[];
  counts?: CountMetric[];
  scopedActions?: Action[];
  selectionActions?: Action[]; // only when items are selected
};
```

Place this control region adjacent to the list or work surface, not inside a tall hero section.

### ContextEvidence — detail/decision pages

```ts
type ContextEvidenceProps = {
  subjectId?: string;
  status?: string;
  source?: string;
  timestamp?: string;
  providerOutcome?: string;
  policyReference?: string;  // only for relevant policy-driven decisions
  attachments?: Attachment[];
};
```

Not every page needs an evidence panel. Show fields supported by the actual workflow.

### ContextualAction — row, panel, detail, form, or composer

```ts
type ContextualActionProps = {
  action: Action;
  scope: "row" | "selection" | "record" | "form" | "conversation";
  confirmationRequired?: boolean;
  loading?: boolean;
  disabledReason?: string;
};
```

### ResultFeedback — inline first

```ts
type ResultFeedbackProps = {
  status: "success" | "error" | "pending";
  title: string;
  description?: string;
  evidenceId?: string;
  nextAction?: Action;
  placement?: "inline" | "toast" | "banner" | "dialog";
};
```

Prefer inline feedback on high-frequency work surfaces. A banner is **not mandatory** and should be used only if the result affects the wider view.

---
## 25. Acceptance Checklist — apply by page archetype

A screen is approved only when its applicable requirements pass. Mark a non-applicable item **N/A with a reason**; do not add UI to make an irrelevant item pass.

### Page classification and anatomy

- [ ] Primary merchant goal and page archetype are documented.
- [ ] Layout follows the selected archetype in §5, not the dashboard by default.
- [ ] No page — overview, execution, or configuration — renders a forced `WHY HERE` paragraph, `WHAT NOW`/primary-action band, dominant page-level status signal, or result footer.
- [ ] Filters, records, conversation content, or form controls occupy the appropriate first-screen space.
- [ ] No unsupported feature or action has been invented.

### Core Design Test (semantic)

- [ ] The task or current object is identifiable through navigation, record data, or useful context.
- [ ] The merchant can find the appropriate next interaction or interpret a read-only view.
- [ ] After an interaction, the continued workflow is clear.
- [ ] Current state and outcomes are supported by reliable data, and async outcomes are not falsely marked complete.

### Workflow

- [ ] Actions are scoped to the correct row, selection, conversation, record, or form.
- [ ] A single decision context does not have competing dominant actions.
- [ ] Destructive/high-impact actions provide proper confirmation and impact explanation.
- [ ] Async actions show pending, failure, and confirmed completion as relevant.
- [ ] Back navigation preserves useful work context and drafts, where feasible.

### Evidence and data

- [ ] Record identity and decision-relevant status are visible where needed.
- [ ] Only evidence relevant to that workflow is requested or shown.
- [ ] Merchant/customer/private data follows permission boundaries.
- [ ] Server/provider outcome and data freshness are shown when they affect trust.

### Accessibility

- [ ] Keyboard navigation works.
- [ ] Focus states are visible.
- [ ] Color is not the only meaning.
- [ ] Contrast passes WCAG AA.
- [ ] Form errors are specific and linked where forms exist.
- [ ] Semantic headings and controls remain accessible even with a compact workspace header.

### Visual

- [ ] Uses approved Midnight/Violet/Sunlight tokens.
- [ ] No unapproved colors.
- [ ] No decorative regions that distract from the task.
- [ ] Buttons use appropriate hierarchy for their decision context.
- [ ] Status indicators have labels.

---
## 26. Screen Spec Template

Use this **design specification** for each significant new screen or redesign. The four questions are answered in the spec; they are not required visible text labels.

```markdown
# Screen: [Name]

## Merchant job
[What is the user actually trying to finish or learn?]

## Page archetype
[Overview | Execution | Detail | Configuration | Analytics | Setup]
[Why this type fits the entry intent]

## Existing capability boundary
[Verified data, actions, permissions, and unavailable functions]

## Core Design Test (semantic)
- WHY HERE: [How the current object/task is understood]
- WHAT NOW: [Which existing interaction or reading task is useful]
- WHERE NEXT: [Navigation or continued workflow after action]
- PROVEN RESULT: [Persisted/provider evidence or N/A with reason]
- Placement: [Where each answer appears without forced headings]

## Screen regions (only the ones needed)
[Toolbar, work surface, composer, detail, side panel, form, etc.]

## Contextual actions
[Action, scope, permission, and consequence]

## Data and evidence
[Actual fields, freshness, outcomes, and sources]

## States
- Loading:
- Empty:
- Error:
- Pending:
- Success:

## Responsive and accessibility notes
[Keyboard, focus, mobile work surface and navigation]

## Analytics / audit events (only where relevant)
[Events, privacy limits, and result evidence]

## Explicit omissions
[What header/banner/CTA/panel is intentionally not present and why]
```

---
## 27. Definition of Done

A UI change is done when:

- Its primary merchant job and page archetype are documented.
- The Core Design Test is satisfied **without forced visible labels or sections**.
- The workflow is faster, clearer, or safer than before, with no loss of existing capability.
- Orders/Inbox and other execution pages preserve usable work surface area.
- Relevant merchant/customer impact is clear at decision points.
- Outcomes are provable and async operations are not prematurely represented as successful.
- Accessibility and responsive behavior pass.
- The agent introduced no unapproved colors, unsupported actions, redundant dashboard headers, or dead ends.

---
## 28. Final Rule

**Design for the job, not a shared screenshot template.** When unsure, give the merchant more usable space for the active task, place the next safe action in context, and show only evidence that changes the decision.

---
## 29. Precedence, migration, and version history

### Source-of-truth precedence

This version **integrates and supersedes** the founder addendum dated 2026-11-16. It also replaces the old universal §5 five-band anatomy, old §24 mandatory header props, and old §25 universal checklist requirements. It is itself amended — normatively and in its favor — by the 2026-11-26 header-removal addendum recorded at the end of this section.

When this document appears to conflict with an existing UI design:

1. Protect correctness, safety, accessibility, and merchant data.
2. Determine the user's primary task and select the correct §5 archetype.
3. Use the archetype-specific rules in §§5, 6, 21, 24, and 25.
4. Reuse the existing verified workflow; do not invent functionality to match an illustration.
5. Treat the original dashboard anatomy as applicable **only to overview pages** — and since 2026-11-26, only to their content modules; the header band itself is retired everywhere.

### Migration guidance for existing screens

- **Dashboard:** Retain an overview structure where it helps priority selection. Remove redundant explanations **and the permanent header signal/summary/action band**; useful signals survive where they were always actionable — queue rows, module cards, results, and banners.
- **Orders:** Remove tall summary/header/action bands that repeat navigation or list state. Put search, filters, order records, and contextual actions first.
- **Inbox:** Keep the list, conversation, composer, handoff state, and evidence in the working area. Remove header essays and global CTAs.
- **Record details:** Keep compact identity, decision-relevant statuses, actions, and history; do not strip information needed for consequential decisions.
- **Settings / editors / analytics:** Apply their own archetypes rather than borrowing the dashboard.

### Version 2.0 — 2026-11-21

- Replaced one-size-fits-all anatomy with six page archetypes.
- Explicitly established **Orders as an execution workspace** with no mandatory `WHY HERE`, `WHAT NOW`, page-level primary action bar, or result footer.
- Kept the dashboard anatomy as an overview-specific pattern.
- Integrated the Inbox execution exception from the founder addendum into the normative rules.
- Corrected the four-question design test so its answers are semantic, not four required React props or visible headings.
- Revised hierarchy, buttons, statuses, navigation, components, and QA checklists to avoid contradictory global requirements.
- Preserved the established Midnight/Violet/Sunlight brand tokens, accessibility baseline, content tone, and core trust requirements.

### Header-removal addendum to Version 2.0 — 2026-11-26

Founder mission 2026-11-26, governed by `docs/header-removal/03_CONTRACT.md` (A0 ruling). Where any clause in §§5, 8, 21, 24, 25, or this section conflicts, **this addendum controls**. It amends §5.2, §8 (placement), §21.1, §24, and §25 above rather than rewriting the Version 2.0 history:

- **Prohibition:** permanent page-level signal headers — a global status badge, a `WHY HERE` explanatory summary, and a generic top action band — are prohibited on **all** merchant-facing pages, overview/dashboard pages included. "Overview pages keep full anatomy" now means full **content** anatomy.
- **Titles:** compact page and record titles remain legal — one heading per page, visible small (`titleMode="compact"`, required on record pages and where no AppBar-equivalent name exists) or screen-reader-only (`titleMode="srOnly"`) where the sticky shell AppBar already shows the same name. Breadcrumbs only where deep context genuinely helps.
- **Meta:** a compact header meta row may carry only record-level, server-confirmed contextual status — never a shop-wide pulse.
- **Actions:** header-exclusive affordances relocate into each page's existing toolbar/workflow area. No page may invent a replacement band, and removal reserves no empty space (no placeholder wrappers, no min-height).
- **Signals (§8 semantics unchanged, placement normed):** record-level and contextual signals — per-row chips, module tiles, result banners, validation errors, onboarding guidance, offline/emergency-stop banners — keep their exact meanings and now live exclusively in content.
- **Tests:** signal-testid assertions are absence pins (`toHaveCount(0)` / `queryByTestId(...) === null`) that lock the removal; functional, safety, accessibility, overflow, and axe gates stay at full strength.
- **i18n:** header-exclusive key groups (per-module `*.signal.*`, `dashboard.pulse.primary.*`, dead pill/narrative keys) are deleted from BOTH locales in lockstep; surviving shared groups are pruned key-by-key with parity preserved.

---
