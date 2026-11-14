/**
 * Channel automation redesign — browser proof (ADR-0013, API_CONTRACT §2/§8/§9).
 *
 * Mock-only, like ai-reply-mode.spec.ts: every /api response is served by the
 * fixture below, so the suite proves the UI contract (testids, labels, narrow-
 * only options, badge honesty, OWNER-only writes) without a backend.
 *
 * Backend enforcement is proven separately (worker/meta-e2e/integration suites);
 * this file must not claim send behaviour it cannot observe.
 */

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

type Mode = 'AUTO' | 'DRAFT' | 'MANUAL';
type Role = 'owner' | 'staff' | 'manager';
type Badge = 'inherited' | 'overridden' | 'clamped' | 'stopped' | 'billingPaused';

const MODE_LABEL: Record<Mode, string> = {
  AUTO: 'Automatic replies',
  DRAFT: 'Drafts for review',
  MANUAL: 'Manual replies only',
};

const BADGE_LABEL: Record<Badge, string> = {
  inherited: 'Inherited',
  overridden: 'Overridden',
  clamped: 'Clamped by business',
  stopped: 'Stopped',
  billingPaused: 'Paused — billing',
};

const RANK: Record<Mode, number> = { AUTO: 1, DRAFT: 2, MANUAL: 3 };

interface ChannelFixture {
  id: string;
  displayName: string;
  overrides: {
    automation_mode?: Mode;
    confidence_threshold?: number;
    greeting?: { enabled: boolean; custom_text: string };
  };
  businessHours?: Record<string, unknown> | null;
  allowOrderCreation?: boolean;
  purposeLabel?: string | null;
  billingAiActive?: boolean;
  forceStop?: boolean;
  /** A warning the list payload cannot carry (it lives on the settings read). */
  warnings?: string[];
}

interface FixtureState {
  role: Role;
  businessMode: Mode;
  emergency: {
    active: boolean;
    at: string | null;
    by: string | null;
    source: 'merchant' | 'admin' | null;
    prior_mode: Mode | null;
  };
  channels: ChannelFixture[];
  inboxStop: boolean;
  conversationFetches: number;
  settingsPatches: Array<{ channelId: string; body: Record<string, unknown> }>;
  conversationPatches: Array<Record<string, unknown>>;
  stopPosts: number;
  resumePosts: number;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };

function makeShop(role: Role) {
  return {
    id: 'shop-1',
    unique_code: 'SHOP1',
    shop_name: 'Automation Test Shop',
    role,
    settings: { onboarding_completed: true },
  };
}

const mockBusinessInfo = {
  shopName: 'Automation Test Shop',
  phone: '01711000000',
  address: 'Dhaka, Bangladesh',
  openingHours: '9am-6pm',
  additionalInfo: '',
  socialLinks: {},
};

function freshState(role: Role = 'owner'): FixtureState {
  return {
    role,
    businessMode: 'AUTO',
    emergency: { active: false, at: null, by: null, source: null, prior_mode: null },
    channels: [
      {
        id: 'channel-inherited',
        displayName: 'Inherited Page',
        overrides: {},
      },
      {
        id: 'channel-overridden',
        displayName: 'Overridden Page',
        overrides: { automation_mode: 'DRAFT' },
      },
      {
        id: 'channel-clamped',
        displayName: 'Clamped Page',
        // Stored widening override: the runtime clamps it to the DRAFT ceiling.
        overrides: { automation_mode: 'AUTO' },
        warnings: ['override_clamped_by_business'],
      },
      {
        id: 'channel-stopped',
        displayName: 'Stopped Page',
        overrides: {},
        forceStop: true,
      },
      {
        id: 'channel-billing',
        displayName: 'Billing Page',
        overrides: {},
        billingAiActive: false,
      },
    ],
    inboxStop: false,
    conversationFetches: 0,
    settingsPatches: [],
    conversationPatches: [],
    stopPosts: 0,
    resumePosts: 0,
  };
}

/** Effective configuration exactly as the server resolves it (narrow-only). */
function settingsFor(state: FixtureState, channel: ChannelFixture) {
  let mode: Mode = state.businessMode;
  let modeSource = 'business_default';
  const warnings = [...(channel.warnings ?? [])];

  if (state.emergency.active || channel.forceStop) {
    mode = 'MANUAL';
    modeSource = 'emergency_stop';
  } else if (channel.overrides.automation_mode) {
    if (RANK[channel.overrides.automation_mode] >= RANK[state.businessMode]) {
      mode = channel.overrides.automation_mode;
      modeSource = 'channel_override';
    } else {
      // Stored widening override: clamped, never silently rewritten.
      mode = state.businessMode;
      modeSource = 'business_default';
      if (!warnings.includes('override_clamped_by_business')) {
        warnings.push('override_clamped_by_business');
      }
    }
  }

  return {
    confidenceThresholdSend: 0.8,
    confidenceThresholdSuggest: 0.5,
    businessHours: channel.businessHours ?? null,
    allowOrderCreation: channel.allowOrderCreation !== false,
    purposeLabel: channel.purposeLabel ?? null,
    overrides: { ...channel.overrides },
    effective: {
      automation_mode: mode,
      confidence_threshold: channel.overrides.confidence_threshold ?? 75,
      greeting: { enabled: true, custom_text: 'Welcome' },
      business_hours: channel.businessHours ?? null,
      allow_order_creation: channel.allowOrderCreation !== false,
      purpose_label: channel.purposeLabel ?? null,
    },
    mode_source: modeSource,
    warnings,
    // `forceStop` lets one card represent the stopped state while the shop-level
    // block stays inactive for the others (per-channel badge visibility proof).
    emergency_stop: channel.forceStop
      ? { active: true, at: iso(), by: 'user-1', source: 'merchant', prior_mode: 'AUTO' }
      : { ...state.emergency },
    billing_ai_active: channel.billingAiActive !== false,
    deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
  };
}

function channelListRow(state: FixtureState, channel: ChannelFixture) {
  const settings = settingsFor(state, channel);
  return {
    id: channel.id,
    shopId: 'shop-1',
    platform: 'facebook',
    metaAssetId: `page-${channel.id}`,
    displayName: channel.displayName,
    pictureUrl: null,
    status: 'CONNECTED',
    isHealthy: true,
    needsReconnect: false,
    lastError: null,
    tokenExpiresAt: iso(90 * 86_400_000),
    tokenLastRefreshedAt: iso(-86_400_000),
    webhookSubscribedFields: ['messages'],
    webhookLastVerifiedAt: iso(-86_400_000),
    connectedAt: iso(-90 * 86_400_000),
    disconnectedAt: null,
    createdAt: iso(-90 * 86_400_000),
    updatedAt: iso(-86_400_000),
    purposeLabel: channel.purposeLabel ?? null,
    effective_mode: settings.effective.automation_mode,
    mode_source: settings.mode_source,
    override_count: Object.keys(channel.overrides).length,
    emergency_stop: settings.emergency_stop,
    billing_ai_active: settings.billing_ai_active,
  };
}

function aiSettingsFor(state: FixtureState) {
  return {
    automation_mode: state.businessMode,
    auto_reply_enabled: state.businessMode === 'AUTO',
    confidence_threshold: 75,
    max_auto_order_value: 5000,
    ask_email: false,
    primary_language: 'mixed',
    tone_persona: 'friendly_bd',
    greeting: { enabled: true, custom_text: 'Welcome' },
    closing: { enabled: true, custom_text: 'Thanks' },
    payment_methods: ['COD'],
    escalation_reply_template: 'Our team will follow up.',
    intent_confidence_map: {},
    required_fields: {
      customer_name: true,
      mobile_number: true,
      delivery_address: true,
      payment_method: true,
      email_address: false,
      special_instructions: false,
    },
    handoff_settings: {
      trigger_keywords: ['refund'],
      notification_channel: 'in_app',
      cooldown_minutes: 30,
    },
    emergency_stop: { ...state.emergency },
  };
}

function conversationFor(state: FixtureState, overrides: Record<string, unknown> = {}) {
  const inboxStop = state.inboxStop || state.emergency.active;
  return {
    id: 'conv-1',
    customer_id: 'customer-1',
    customer: { id: 'customer-1', name: 'Ahmed Hassan' },
    channel: 'messenger',
    meta_channel_id: 'channel-overridden',
    metaChannel: { id: 'channel-overridden', displayName: 'Overridden Page', platform: 'facebook' },
    title: 'Product question',
    status: 'active',
    hitl: false,
    assignee_id: 'user-2',
    assignee: { id: 'user-2', name: 'Rahim' },
    lastMessage: 'Is this available?',
    unreadCount: 0,
    needs_merchant_reply: true,
    needs_merchant_reply_reason: 'HITL_REQUIRED',
    effective_ai_reply_mode: 'MANUAL',
    mode_source: 'business_default',
    emergency_stop: { ...state.emergency, active: inboxStop },
    billing_ai_active: true,
    created_at: iso(-60_000),
    updated_at: iso(-1_000),
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: status < 400, data }),
  };
}

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((res) => { resolve = res; });
  return { promise, resolve };
}

function knownApiPath(path: string): boolean {
  return [
    '/api/csrf',
    '/api/auth/me',
    '/api/auth/signin',
    '/api/setup/status',
    '/api/dashboard/metrics',
    '/api/dashboard/queue',
    '/api/order',
    '/api/subscription',
    '/api/notifications/in-app',
    '/api/notifications/telegram',
    '/api/shop/business-info',
    '/api/shop/ai-settings',
    '/api/shop/ai/emergency-stop',
    '/api/shop/ai/emergency-resume',
    '/api/conversation',
    '/api/conversation/events',
    '/api/templates',
    '/api/inbox/actions',
    '/api/channels/meta',
    '/api/audit',
    '/api/commercial/claims',
    '/api/public/commercial-contract',
  ].includes(path)
    || /^\/api\/channels\/meta\/[^/]+\/settings$/.test(path)
    || /^\/api\/conversation\/[^/]+$/.test(path)
    || /^\/api\/conversation\/[^/]+\/messages$/.test(path)
    || /^\/api\/conversation\/[^/]+\/read$/.test(path);
}

interface RouteFixture {
  state: FixtureState;
  sseRequested: Promise<void>;
  releaseSse: (body: string) => void;
  assertNoAbortedWrites: () => void;
}

async function setupRoutes(
  page: Page,
  state: FixtureState,
  options: { holdSse?: boolean } = {},
): Promise<RouteFixture> {
  let authenticated = false;
  let sseRequestedResolve!: () => void;
  const sseRequested = new Promise<void>((res) => { sseRequestedResolve = res; });
  const sseGate = deferred();

  await page.addInitScript(() => {
    window.localStorage.setItem('easymod_lang', 'en');
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
    window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
  });

  // Unknown API paths resolve to an empty success envelope; this is a fixture,
  // not a negative-path assertion (unlike ai-reply-mode.spec.ts).
  await page.route(
    (url) => new URL(url).pathname.startsWith('/api/') && !knownApiPath(new URL(url).pathname),
    (route) => route.fulfill(jsonResponse({})),
  );

  await page.route(
    (url) => knownApiPath(new URL(url).pathname),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const shop = makeShop(state.role);

      if (path === '/api/csrf') return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));

      if (path === '/api/auth/signin' && method === 'POST') {
        authenticated = true;
        return route.fulfill(jsonResponse({ user: mockUser, currentShop: shop, allShops: [shop] }));
      }

      if (path === '/api/auth/me') {
        return route.fulfill(authenticated
          ? jsonResponse({ user: mockUser, currentShop: shop, allShops: [shop] })
          : { status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) });
      }

      if (path === '/api/setup/status') {
        return route.fulfill(jsonResponse({ isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [] }));
      }
      if (path === '/api/dashboard/metrics') {
        return route.fulfill(jsonResponse({ metrics: { totalMessages: 0, activeProducts: 0, ordersToday: 0 }, analytics: { llm_calls: 0 } }));
      }
      if (path === '/api/dashboard/queue') {
        return route.fulfill(jsonResponse({ unread_count: 0, pending_payment_count: 0, at_risk_orders: [] }));
      }
      if (path === '/api/order') return route.fulfill(jsonResponse([]));
      if (path === '/api/subscription') {
        return route.fulfill(jsonResponse({
          subscription: { plan_code: 'MERCHANT', status: 'active', billing_model: 'per_order' },
          plan: { code: 'MERCHANT', name: 'Merchant', billing_model: 'per_order' },
          contract: 'DELIVERED_ORDER',
          contract_version: '1.0.0',
          contract_hash: `sha256:${'b'.repeat(64)}`,
          usage: { conversations: { used: 0, limit: -1 } },
          period: { start: iso(-86_400_000) },
        }));
      }
      if (path === '/api/notifications/in-app') return route.fulfill(jsonResponse([]));
      if (path === '/api/notifications/telegram') return route.fulfill(jsonResponse({ connected: false }));
      if (path === '/api/shop/business-info') {
        return route.fulfill(jsonResponse({ businessInfo: mockBusinessInfo, shop }));
      }
      if (path === '/api/audit' && method === 'POST') return route.fulfill(jsonResponse({ id: 'audit-1' }, 201));

      if (path === '/api/shop/ai-settings') {
        if (method === 'GET') return route.fulfill(jsonResponse(aiSettingsFor(state)));
        if (method === 'PUT') {
          const body = (request.postDataJSON() || {}) as Record<string, unknown>;
          if (typeof body.automation_mode === 'string') {
            state.businessMode = body.automation_mode as Mode;
          }
          return route.fulfill(jsonResponse(aiSettingsFor(state)));
        }
      }

      if (path === '/api/shop/ai/emergency-stop' && method === 'POST') {
        state.stopPosts += 1;
        state.emergency = {
          active: true,
          at: iso(),
          by: 'user-1',
          source: 'merchant',
          // Snapshot the business mode; engage also writes MANUAL (rollback belt).
          prior_mode: state.businessMode,
        };
        state.businessMode = 'MANUAL';
        return route.fulfill(jsonResponse({ ...state.emergency, already_active: false }));
      }

      if (path === '/api/shop/ai/emergency-resume' && method === 'POST') {
        state.resumePosts += 1;
        const prior = state.emergency.prior_mode;
        state.emergency = { active: false, at: null, by: null, source: null, prior_mode: null };
        // Mode deliberately stays MANUAL after resume.
        state.businessMode = 'MANUAL';
        return route.fulfill(jsonResponse({ active: false, automation_mode: 'MANUAL', prior_mode: prior }));
      }

      if (path === '/api/channels/meta' && method === 'GET') {
        return route.fulfill(jsonResponse(state.channels.map((channel) => channelListRow(state, channel))));
      }

      const settingsMatch = path.match(/^\/api\/channels\/meta\/([^/]+)\/settings$/);
      if (settingsMatch) {
        const channelId = settingsMatch[1];
        const channel = state.channels.find((row) => row.id === channelId);
        if (!channel) return route.fulfill(jsonResponse({}, 404));

        if (method === 'GET') return route.fulfill(jsonResponse(settingsFor(state, channel)));

        if (method === 'PATCH') {
          const body = (request.postDataJSON() || {}) as Record<string, unknown>;
          state.settingsPatches.push({ channelId, body });
          const patch = body.overrides as Record<string, unknown> | null | undefined;
          if (patch && typeof patch === 'object') {
            for (const [key, value] of Object.entries(patch)) {
              if (value === null) {
                delete (channel.overrides as Record<string, unknown>)[key];
              } else {
                (channel.overrides as Record<string, unknown>)[key] = value;
              }
            }
          }
          if (typeof body.allowOrderCreation === 'boolean') {
            channel.allowOrderCreation = body.allowOrderCreation;
          }
          return route.fulfill(jsonResponse(settingsFor(state, channel)));
        }
      }

      if (path === '/api/conversation' && method === 'GET') {
        state.conversationFetches += 1;
        return route.fulfill(jsonResponse({
          conversations: [conversationFor(state)],
          ai_reply_mode: state.businessMode,
          pagination: { total: 1, page: 1, pageSize: 50, totalPages: 1 },
        }));
      }

      if (path === '/api/conversation/events') {
        sseRequestedResolve();
        if (options.holdSse) {
          const body = await sseGate.promise;
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            headers: { 'Cache-Control': 'no-cache' },
            body,
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache' },
          body: 'retry: 10000\n\n',
        });
      }

      const messagesMatch = path.match(/^\/api\/conversation\/([^/]+)\/messages$/);
      if (messagesMatch && method === 'GET') {
        return route.fulfill(jsonResponse({
          messages: [{
            id: 'msg-1',
            conversation_id: 'conv-1',
            sender: 'customer',
            message_type: 'text',
            content: 'Is this available?',
            created_at: iso(-2_000),
          }],
          pagination: { page: 1, totalPages: 1 },
        }));
      }

      const readMatch = path.match(/^\/api\/conversation\/([^/]+)\/read$/);
      if (readMatch && method === 'POST') {
        return route.fulfill(jsonResponse({ ...conversationFor(state), unreadCount: 0 }));
      }

      const conversationMatch = path.match(/^\/api\/conversation\/([^/]+)$/);
      if (conversationMatch && method === 'PATCH') {
        const body = (request.postDataJSON() || {}) as Record<string, unknown>;
        state.conversationPatches.push(body);
        return route.fulfill(jsonResponse(conversationFor(state, {
          hitl: body.hitl === true,
          ...(body.hitl === true
            ? {
                needs_merchant_reply_reason: 'MANUAL_TAKEOVER',
                assigned: true,
              }
            : {}),
        })));
      }

      if (path === '/api/templates') return route.fulfill(jsonResponse([]));
      if (path === '/api/inbox/actions') {
        return route.fulfill(jsonResponse({
          items: [], counts: { total: 0 }, generated_at: iso(), partial: false,
        }));
      }

      if (path === '/api/commercial/claims') {
        const surface = new URL(request.url()).searchParams.get('surface') ?? 'usage-banner';
        const registryHash = `sha256:${'a'.repeat(64)}`;
        const decisions = surface === 'subscription'
          ? ['ai.draft_reply', 'ai.auto_reply'].map((claimId) => ({
              claimId,
              available: true,
              render: 'claim',
              textKey: `claims.${claimId}.en`,
              locale: 'en',
              surface,
              scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
              interpolation: {},
              mode: 'enforce',
              predicate: {
                code_present: true,
                merchant_enabled: true,
                production_verified: true,
                deprecated: false,
                internal_only: false,
                scope_match: true,
              },
              wouldBlock: false,
              contractVersion: '1.0.0',
              registryHash,
            }))
          : [];
        return route.fulfill(jsonResponse({ surface, locale: 'en', contractVersion: '1.0.0', registryHash, decisions }));
      }

      if (path === '/api/public/commercial-contract') {
        return route.fulfill(jsonResponse({
          contract_version: '1.0.0',
          contract_hash: `sha256:${'b'.repeat(64)}`,
          model: 'DELIVERED_ORDER',
          currency: 'BDT',
          trigger: 'ORDER_DELIVERED_PROVIDER_CONFIRMED',
          unit_price_minor: 1000,
          unit_price_bdt: 10,
          zero_rated_outcomes: ['RETURNED', 'CANCELLED', 'DRAFT', 'CONFIRMED'],
          subscription_fee_bdt: 0,
          setup_fee_bdt: 0,
          monthly_minimum_bdt: 0,
          conversation_entitlement: null,
          cycle: 'MONTHLY',
          payment: 'POSTPAID',
          due_days: 7,
          on_overdue: {
            blockCourierBooking: true,
            pauseAutomatedAi: true,
            keepInboxReadable: true,
            keepHistoryReadable: true,
            deleteData: false,
          },
          description: { en: 'Pay per delivered order.', bn: 'প্রতি ডেলিভারি অর্ডারে পেমেন্ট।' },
          registry_hash: `sha256:${'a'.repeat(64)}`,
          claims: [],
          decisions: [],
        }));
      }

      return route.fulfill(jsonResponse({}));
    },
  );

  return {
    state,
    sseRequested,
    releaseSse: (body: string) => sseGate.resolve(body),
    assertNoAbortedWrites: () => {
      // The fixture never aborts a write; this keeps the parity assertion
      // explicit in a spec that intentionally tolerates unknown reads.
      expect(state.settingsPatches.every((entry) => entry.channelId)).toBe(true);
    },
  };
}

async function loginAndGo(page: Page, path: string): Promise<void> {
  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(mockUser.email);
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(path);
}

function badgeFor(channelId: string) {
  return `channel-badge-${channelId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Business profile / defaults split
// ─────────────────────────────────────────────────────────────────────────────

test('business profile has no AI controls and links to automation defaults', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/business-info');

  await expect(page.getByTestId('business-info-automation-link')).toBeVisible();
  await expect(page.getByTestId('ai-reply-mode')).toHaveCount(0);
  await expect(page.getByText('Save Reply Settings', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/AI is replying/)).toHaveCount(0);
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
});

test('automation defaults host the unchanged reply-mode radiogroup and save canonically', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/automation');

  await expect(page.getByRole('heading', { name: 'Reply Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Automation defaults' })).toBeVisible();

  const group = page.getByTestId('ai-reply-mode');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(group.locator('[role="radio"]')).toHaveCount(3);
  // The business-wide emergency stop is mounted on this page too.
  await expect(page.getByTestId('emergency-stop-slot')).toBeVisible();
  await expect(page.getByTestId('emergency-stop-button')).toBeVisible();

  const auto = page.getByTestId('ai-reply-mode-auto');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'true');

  const saveRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === '/api/shop/ai-settings'
    && request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save Reply Settings', exact: true }).click();
  const request = await saveRequest;
  expect(request.postDataJSON()).toMatchObject({ automation_mode: 'AUTO' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overview — honest badges
// ─────────────────────────────────────────────────────────────────────────────

test('overview renders Inherited / Overridden / Clamped / Stopped / PAUSED-billing badges', async ({ page }) => {
  const state = freshState();
  state.businessMode = 'DRAFT';
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels');

  await expect(page.getByRole('heading', { name: 'Channels & Automation' })).toBeVisible();

  await expect(page.getByTestId(badgeFor('channel-inherited'))).toHaveText(BADGE_LABEL.inherited);
  await expect(page.getByTestId(badgeFor('channel-overridden'))).toHaveText(BADGE_LABEL.overridden);
  // Stored AUTO under a DRAFT ceiling is clamped, not honoured.
  await expect(page.getByTestId(badgeFor('channel-clamped'))).toHaveText(BADGE_LABEL.clamped);
  await expect(page.getByTestId(badgeFor('channel-stopped'))).toHaveText(BADGE_LABEL.stopped);
  await expect(page.getByTestId(badgeFor('channel-billing'))).toHaveText(BADGE_LABEL.billingPaused);

  // The clamped channel surfaces a warning; the effective mode is the ceiling.
  await expect(page.getByTestId('channel-card-channel-clamped')).toContainText(
    'A stored channel override is clamped by the business default.',
  );
  await expect(page.getByTestId('channel-card-channel-clamped')).toContainText(MODE_LABEL.DRAFT);
});

test('overview shows the emergency stop banner when the shop is stopped', async ({ page }) => {
  const state = freshState();
  state.emergency = {
    active: true, at: iso(), by: 'user-1', source: 'merchant', prior_mode: 'AUTO',
  };
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels');

  await expect(page.getByTestId('emergency-stop-banner')).toBeVisible();
  await expect(page.getByTestId('emergency-resume-button')).toBeVisible();
  await expect(page.getByTestId(badgeFor('channel-inherited'))).toHaveText(BADGE_LABEL.stopped);
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel detail — narrow-only override, revert, isolation
// ─────────────────────────────────────────────────────────────────────────────

test('detail offers only modes at or below the business ceiling and saves the override', async ({ page }) => {
  const state = freshState();
  state.businessMode = 'DRAFT';
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels/channel-inherited');

  await expect(page.getByTestId('channel-effective-mode')).toContainText(MODE_LABEL.DRAFT);
  await expect(page.getByTestId('channel-mode-source')).toContainText('Business default');

  // Inherited: no editor until the merchant opts into an override.
  await expect(page.getByTestId('channel-mode-override')).toHaveCount(0);
  await page.getByRole('button', { name: 'Override for this channel' }).click();

  const group = page.getByTestId('channel-mode-override');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  // Business DRAFT ceiling: Channels may store DRAFT or MANUAL, never AUTO.
  await expect(group.locator('input[value="AUTO"]')).toHaveCount(0);
  await expect(group.locator('input[value="DRAFT"]')).toHaveCount(1);
  await expect(group.locator('input[value="MANUAL"]')).toHaveCount(1);
  await expect(page.getByText(/cannot be more automated than the business default/i)).toBeVisible();

  const patchRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === '/api/channels/meta/channel-inherited/settings'
    && request.method() === 'PATCH');
  await group.locator('input[value="MANUAL"]').check();
  const request = await patchRequest;
  expect(request.postDataJSON()).toEqual({ overrides: { automation_mode: 'MANUAL' } });

  // Effective mode updates from the post-write payload.
  await expect(page.getByTestId('channel-effective-mode')).toContainText(MODE_LABEL.MANUAL);
  await expect(page.getByTestId('channel-mode-source')).toContainText('Channel override');
  await expect(page.getByTestId('channel-override-revert-automation_mode')).toBeVisible();
});

test('revert removes the override, restores inheritance and returns focus to the section', async ({ page }) => {
  const state = freshState();
  state.businessMode = 'DRAFT';
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels/channel-overridden');

  await expect(page.getByTestId('channel-effective-mode')).toContainText(MODE_LABEL.DRAFT);
  await expect(page.getByTestId('channel-mode-source')).toContainText('Channel override');

  const revertRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === '/api/channels/meta/channel-overridden/settings'
    && request.method() === 'PATCH');
  await page.getByTestId('channel-override-revert-automation_mode').click();
  const request = await revertRequest;
  expect(request.postDataJSON()).toEqual({ overrides: { automation_mode: null } });

  await expect(page.getByTestId('channel-mode-override')).toHaveCount(0);
  await expect(page.getByTestId('channel-mode-source')).toContainText('Business default');
  // Focus returns to the OverrideControl section (tabIndex -1) so keyboard
  // users are not dropped at the document body after the editor unmounts.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe('SECTION');
  expect(state.channels.find((c) => c.id === 'channel-overridden')?.overrides.automation_mode)
    .toBeUndefined();
});

test('saving Page A does not change Page B', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels/channel-inherited');

  await page.getByRole('button', { name: 'Override for this channel' }).click();
  const group = page.getByTestId('channel-mode-override');
  await group.locator('input[value="MANUAL"]').check();
  await expect(page.getByTestId('channel-mode-source')).toContainText('Channel override');

  await page.goto('/manage-shop/channels/channel-overridden');
  await expect(page.getByTestId('channel-effective-mode')).toContainText(MODE_LABEL.DRAFT);
  await expect(page.getByTestId('channel-mode-source')).toContainText('Channel override');
  await expect(page.locator('input[value="MANUAL"]')).toHaveCount(0);

  // Only the intended channel was patched.
  expect(state.settingsPatches.map((patch) => patch.channelId))
    .toEqual(['channel-inherited']);
});

test('staff sees the channel settings read-only with an accurate reason', async ({ page }) => {
  const state = freshState('staff');
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels/channel-overridden');

  await expect(page.getByTestId('channel-read-only-reason')).toBeVisible();
  await expect(page.getByTestId('channel-read-only-reason')).toContainText(/Only the shop owner/);
  await expect(page.getByRole('button', { name: 'Override for this channel' })).toHaveCount(0);
  await expect(page.getByTestId('channel-mode-override')).toHaveCount(0);
  // No write was attempted.
  expect(state.settingsPatches).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Emergency stop — confirm, resume keeps MANUAL
// ─────────────────────────────────────────────────────────────────────────────

test('emergency stop confirms, then resume keeps the business mode MANUAL', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels');

  await page.getByTestId('emergency-stop-button').click();
  const dialog = page.getByRole('dialog', { name: 'Stop all AI replies?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Your team can still reply');
  await dialog.getByRole('button', { name: 'Yes, stop AI replies' }).click();

  await expect(page.getByTestId('emergency-stop-banner')).toBeVisible();
  await expect(page.getByTestId('emergency-resume-button')).toBeVisible();
  expect(state.stopPosts).toBe(1);
  expect(state.businessMode).toBe('MANUAL');

  await page.getByTestId('emergency-resume-button').click();
  await expect(page.getByTestId('emergency-stop-button')).toBeVisible();
  expect(state.resumePosts).toBe(1);

  // Resume never re-enables AUTO: the defaults editor shows MANUAL selected.
  await page.goto('/manage-shop/automation');
  await expect(page.getByTestId('ai-reply-mode-manual')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'false');
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbox — owner chip, reason label, takeover reason, SSE stop banner
// ─────────────────────────────────────────────────────────────────────────────

test('inbox shows the owner chip and literal reason label', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/inbox');

  await page.getByText('Ahmed Hassan').first().click();
  await expect(page.getByTestId('inbox-owner-chip').first()).toContainText('Rahim');
  await expect(page.getByTestId('inbox-handoff-reason').first())
    .toHaveText('Human takeover required');
  await expect(page.getByTestId('inbox-ai-reply-mode')).toContainText('Manual replies only');
});

test('takeover asks for a fixed-list reason and sends it with hitl', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/inbox');

  await page.getByText('Ahmed Hassan').first().click();
  await page.getByRole('button', { name: 'Take over' }).click();

  const dialog = page.getByRole('dialog', { name: 'Take over this conversation?' });
  await expect(dialog).toBeVisible();
  const select = page.getByTestId('takeover-reason-select');
  await expect(select.locator('option')).toHaveCount(5);
  await select.selectOption('customer_request');
  await dialog.getByRole('button', { name: 'Take over' }).click();

  await expect.poll(() => state.conversationPatches.length).toBe(1);
  expect(state.conversationPatches[0]).toEqual({
    hitl: true,
    handoff_reason: 'customer_request',
  });
});

test('an SSE emergency_stop_changed event re-reads the inbox and shows the stop banner', async ({ page }) => {
  const state = freshState();
  const fixture = await setupRoutes(page, state, { holdSse: true });
  await loginAndGo(page, '/inbox');

  await fixture.sseRequested;
  await expect(page.getByTestId('emergency-stop-banner')).toHaveCount(0);
  const fetchesBefore = state.conversationFetches;

  // Merchant (or platform admin) stops AI elsewhere; the shop-scoped SSE
  // event must invalidate and re-render without polling.
  state.inboxStop = true;
  state.emergency = {
    active: true, at: iso(), by: 'user-1', source: 'merchant', prior_mode: 'AUTO',
  };
  fixture.releaseSse('event: emergency_stop_changed\ndata: {"active":true}\n\n');

  await expect(page.getByTestId('emergency-stop-banner')).toBeVisible();
  await expect.poll(() => state.conversationFetches > fetchesBefore).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Responsive + accessibility
// ─────────────────────────────────────────────────────────────────────────────

for (const width of [360, 390]) {
  test(`overview and detail fit ${width}px without horizontal page scroll`, async ({ page }) => {
    const state = freshState();
    await setupRoutes(page, state);
    await loginAndGo(page, '/manage-shop/channels');
    await page.setViewportSize({ width, height: 800 });

    await expect(page.getByTestId('channel-card-channel-inherited')).toBeVisible();
    const overviewOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overviewOverflow.scrollWidth).toBeLessThanOrEqual(overviewOverflow.clientWidth + 1);

    await page.goto('/manage-shop/channels/channel-inherited');
    await expect(page.getByTestId('channel-effective-mode')).toBeVisible();
    const detailOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(detailOverflow.scrollWidth).toBeLessThanOrEqual(detailOverflow.clientWidth + 1);
  });
}

test('overview has no critical or serious axe violations', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels');
  await expect(page.getByTestId('channel-card-channel-inherited')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking).toEqual([]);
});

test('channel detail has no critical or serious axe violations', async ({ page }) => {
  const state = freshState();
  await setupRoutes(page, state);
  await loginAndGo(page, '/manage-shop/channels/channel-overridden');
  await expect(page.getByTestId('channel-mode-override')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking).toEqual([]);
});