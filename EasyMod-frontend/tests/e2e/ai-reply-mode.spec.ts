import { expect, test, type Page } from '@playwright/test';

type AiReplyMode = 'AUTO' | 'DRAFT' | 'MANUAL';
type MessageSender = 'customer' | 'agent' | 'ai';

const mockUser = {
  id: 'user-1',
  full_name: 'Test Owner',
  email: 'owner@shop.bd',
};

const mockShop = {
  id: 'shop-1',
  unique_code: 'SHOP1',
  shop_name: 'Mode Test Shop',
  role: 'owner',
  settings: { onboarding_completed: true },
};

const mockBusinessInfo = {
  shopName: 'Mode Test Shop',
  phone: '01711000000',
  address: 'Dhaka, Bangladesh',
  openingHours: '9am-6pm',
  additionalInfo: '',
  socialLinks: {},
};

const mockAISettings = {
  automation_mode: 'MANUAL' as AiReplyMode,
  confidence_threshold: 75,
  auto_reply_enabled: false,
  max_auto_order_value: 5000,
  ask_email: false,
  primary_language: 'mixed',
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
  greeting: { enabled: true, custom_text: 'Welcome' },
  closing: { enabled: true, custom_text: 'Thanks' },
};

const mockMetaChannel = {
  id: 'meta-channel-1',
  shopId: mockShop.id,
  platform: 'facebook',
  metaAssetId: 'page-1',
  displayName: 'Mode Test Page',
  pictureUrl: null,
  status: 'CONNECTED',
  lastError: null,
  tokenExpiresAt: null,
  tokenLastRefreshedAt: '2026-09-01T00:00:00.000Z',
  webhookSubscribedFields: ['messages'],
  webhookLastVerifiedAt: '2026-09-01T00:00:00.000Z',
  connectedAt: '2026-09-01T00:00:00.000Z',
  disconnectedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  purposeLabel: null,
};

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    customer_id: 'customer-1',
    customer: { id: 'customer-1', name: 'Ahmed Hassan' },
    channel: 'messenger',
    title: 'Product question',
    status: 'active',
    hitl: false,
    lastMessage: 'Is this available?',
    unreadCount: 0,
    created_at: isoFromNow(-60_000),
    updated_at: isoFromNow(-1_000),
    ...overrides,
  };
}

function makeMessage(
  id: string,
  sender: MessageSender,
  content: string,
  offsetMs: number,
  metadata?: Record<string, unknown>,
) {
  return {
    id,
    conversation_id: 'conv-1',
    content,
    sender,
    message_type: 'text',
    metadata,
    created_at: isoFromNow(offsetMs),
    updated_at: isoFromNow(offsetMs),
  };
}

const customerMessage = () => makeMessage(
  'customer-1',
  'customer',
  'Is this available?',
  -2_000,
);

const heldDraftMessage = () => makeMessage(
  'ai-held-1',
  'ai',
  'The draft reply is ready for your review.',
  -1_000,
  { delivered: false, held_reason: 'draft_mode' },
);

function jsonResponse(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: status < 400, data }),
  };
}

function errorResponse(message: string, status = 400) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { message } }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function isConversationMessagesPath(path: string): boolean {
  return /^\/api\/conversation\/[^/]+\/messages$/.test(path);
}

function isConversationPath(path: string): boolean {
  return /^\/api\/conversation\/[^/]+$/.test(path);
}

function isConversationReadPath(path: string): boolean {
  return /^\/api\/conversation\/[^/]+\/read$/.test(path);
}

function isKnownApiPath(path: string): boolean {
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
    '/api/conversation',
    '/api/conversation/events',
    '/api/templates',
    '/api/inbox/actions',
    '/api/channels/meta',
    '/api/audit',
    '/api/commercial/claims',
    '/api/public/commercial-contract',
  ].includes(path) || isConversationMessagesPath(path) || isConversationReadPath(path) || isConversationPath(path)
    || /^\/api\/channels\/meta\/[^/]+\/settings$/.test(path);
}

/** Channel settings payload for the redesigned surfaces (ADR-0013 §2). */
function channelSettings(mode: AiReplyMode, overrides: Record<string, unknown> = {}) {
  return {
    confidenceThresholdSend: 0.8,
    confidenceThresholdSuggest: 0.5,
    businessHours: null,
    allowOrderCreation: true,
    purposeLabel: null,
    overrides,
    effective: {
      automation_mode: mode,
      confidence_threshold: 75,
      greeting: { enabled: true, custom_text: 'Welcome' },
      business_hours: null,
      allow_order_creation: true,
      purpose_label: null,
    },
    mode_source: Object.keys(overrides).length > 0 ? 'channel_override' : 'business_default',
    warnings: [],
    emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
    billing_ai_active: true,
    deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
  };
}

interface RouteOptions {
  mode?: AiReplyMode;
  conversations?: ReturnType<typeof makeConversation>[];
  messages?: ReturnType<typeof makeMessage>[];
  messagesByConversation?: Record<string, ReturnType<typeof makeMessage>[]>;
  sseBody?: string;
  holdSse?: boolean;
  createMessageStatus?: number;
}

interface RouteFixture {
  state: {
    mode: AiReplyMode;
    aiSettings: typeof mockAISettings;
    messages: Record<string, ReturnType<typeof makeMessage>[]>;
    readConversationIds: Set<string>;
    savedModes: Array<{ mode: unknown; auto_reply_enabled: unknown }>;
    createdMessages: Array<Record<string, unknown>>;
    conversationFetches: number;
    unexpectedApiRequests: string[];
  };
  sseRequested: Promise<void>;
  releaseSse: () => void;
  assertNoUnexpectedApiRequests: () => void;
}

async function setupRoutes(page: Page, options: RouteOptions = {}): Promise<RouteFixture> {
  let authenticated = false;
  const mode = options.mode ?? 'MANUAL';
  const sseGate = deferred();
  const sseRequested = deferred();
  const state: RouteFixture['state'] = {
    mode,
    aiSettings: {
      ...mockAISettings,
      automation_mode: mode,
      auto_reply_enabled: mode === 'AUTO',
    },
    messages: options.messagesByConversation ?? {
      'conv-1': options.messages ?? [customerMessage()],
    },
    readConversationIds: new Set<string>(),
    savedModes: [],
    createdMessages: [],
    conversationFetches: 0,
    unexpectedApiRequests: [],
  };

  await page.addInitScript(() => {
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
    window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
  });

  // Keep the fallback API-only. A broad API glob also matches Vite's /src/api
  // modules and prevents the application bundle from loading.
  await page.route(
    (url) => {
      const path = new URL(url).pathname;
      return path.startsWith('/api/') && !isKnownApiPath(path);
    },
    async (route) => {
      const request = route.request();
      state.unexpectedApiRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort();
    },
  );

  await page.route(
    (url) => isKnownApiPath(new URL(url).pathname),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();

      if (path === '/api/csrf' && method === 'GET') {
        return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
      }

      if (path === '/api/auth/signin' && method === 'POST') {
        authenticated = true;
        return route.fulfill(jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }));
      }

      if (path === '/api/auth/me' && method === 'GET') {
        return route.fulfill(authenticated
          ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
          : errorResponse('Unauthorized', 401));
      }

      if (path === '/api/setup/status' && method === 'GET') {
        return route.fulfill(jsonResponse({
          isComplete: true,
          completedCount: 4,
          totalCount: 4,
          progressPercent: 100,
          tasks: [],
        }));
      }

      if (path === '/api/dashboard/metrics' && method === 'GET') {
        return route.fulfill(jsonResponse({
          metrics: {
            totalMessages: 0,
            activeProducts: 0,
            ordersToday: 0,
            weeklyChange: 0,
            conversionRate: 0,
          },
          analytics: { llm_calls: 0 },
        }));
      }

      if (path === '/api/dashboard/queue' && method === 'GET') {
        return route.fulfill(jsonResponse({ unread_count: 0, pending_payment_count: 0, at_risk_orders: [] }));
      }

      if (path === '/api/order' && method === 'GET') {
        return route.fulfill(jsonResponse([]));
      }

      if (path === '/api/subscription' && method === 'GET') {
        return route.fulfill(jsonResponse({
          subscription: {
            plan_code: 'MERCHANT',
            status: 'active',
            billing_model: 'per_order',
            current_period_start: '2026-09-01T00:00:00.000Z',
          },
          plan: { code: 'MERCHANT', name: 'Merchant', billing_model: 'per_order' },
          contract: 'DELIVERED_ORDER',
          contract_version: '1.0.0',
          contract_hash: `sha256:${'b'.repeat(64)}`,
          usage: { conversations: { used: 0, limit: -1 } },
          period: { start: '2026-09-01T00:00:00.000Z' },
        }));
      }

      if (path === '/api/notifications/in-app' && method === 'GET') {
        return route.fulfill(jsonResponse([]));
      }

      if (path === '/api/notifications/telegram' && method === 'GET') {
        return route.fulfill(jsonResponse({ connected: false }));
      }

      if (path === '/api/shop/business-info' && method === 'GET') {
        return route.fulfill(jsonResponse({ businessInfo: mockBusinessInfo, shop: mockShop }));
      }

      if (path === '/api/shop/ai-settings') {
        if (method === 'GET') return route.fulfill(jsonResponse(state.aiSettings));
        if (method === 'PUT') {
          const body = (request.postDataJSON() || {}) as Record<string, unknown>;
          state.mode = body.automation_mode as AiReplyMode;
          state.aiSettings = { ...state.aiSettings, ...body, automation_mode: state.mode } as typeof mockAISettings;
          state.savedModes.push({
            mode: body.automation_mode,
            auto_reply_enabled: body.auto_reply_enabled,
          });
          return route.fulfill(jsonResponse(state.aiSettings));
        }
      }

      if (path === '/api/conversation' && method === 'GET') {
        state.conversationFetches += 1;
        const configuredConversations = options.conversations ?? [makeConversation()];
        return route.fulfill(jsonResponse({
          conversations: configuredConversations.map((conversation) => (
            state.readConversationIds.has(conversation.id)
              ? { ...conversation, unreadCount: 0 }
              : conversation
          )),
          ai_reply_mode: state.mode,
          pagination: { total: configuredConversations.length, page: 1, pageSize: 50, totalPages: 1 },
        }));
      }

      if (path === '/api/conversation/events' && method === 'GET') {
        sseRequested.resolve();
        if (options.holdSse) await sseGate.promise;
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache' },
          body: options.sseBody ?? 'retry: 10000\n\n',
        });
      }

      if (isConversationMessagesPath(path)) {
        const conversationId = path.split('/')[3];
        if (method === 'GET') {
          return route.fulfill(jsonResponse({
            messages: state.messages[conversationId] ?? [],
            pagination: { page: 1, totalPages: 1 },
          }));
        }
        if (method === 'POST') {
          const body = (request.postDataJSON() || {}) as Record<string, unknown>;
          state.createdMessages.push(body);
          if (options.createMessageStatus) {
            return route.fulfill(errorResponse('Message delivery failed', options.createMessageStatus));
          }
          return route.fulfill(jsonResponse({
            id: 'agent-message-1',
            conversation_id: conversationId,
            content: String(body.content ?? ''),
            sender: 'agent',
            message_type: 'text',
            metadata: { delivery_status: 'sent' },
            created_at: isoFromNow(0),
            updated_at: isoFromNow(0),
          }, 201));
        }
      }

      if (isConversationReadPath(path) && method === 'POST') {
        const conversationId = path.split('/')[3];
        state.readConversationIds.add(conversationId);
        return route.fulfill(jsonResponse({
          ...makeConversation({ id: conversationId }),
          unreadCount: 0,
          lastReadMessageId: (request.postDataJSON() as Record<string, unknown>)?.message_id,
        }));
      }

      if (isConversationPath(path) && method === 'PATCH') {
        const body = (request.postDataJSON() || {}) as Record<string, unknown>;
        return route.fulfill(jsonResponse({
          ...makeConversation(),
          hitl: body.hitl,
        }));
      }

      if (path === '/api/templates' && method === 'GET') {
        return route.fulfill(jsonResponse([]));
      }

      // P+03 action-queue read model: mounted by the inbox strip, not part of
      // the AI reply-mode contract under test. Empty queue renders nothing.
      if (path === '/api/inbox/actions' && method === 'GET') {
        return route.fulfill(jsonResponse({
          items: [],
          counts: { total: 0 },
          generated_at: isoFromNow(0),
          partial: false,
        }));
      }

      if (path === '/api/channels/meta' && method === 'GET') {
        return route.fulfill(jsonResponse([mockMetaChannel]));
      }

      const channelSettingsMatch = path.match(/^\/api\/channels\/meta\/([^/]+)\/settings$/);
      if (channelSettingsMatch) {
        if (method === 'GET') {
          return route.fulfill(jsonResponse(channelSettings(state.mode as AiReplyMode)));
        }
        if (method === 'PATCH') {
          const body = (request.postDataJSON() || {}) as { overrides?: Record<string, unknown> };
          return route.fulfill(jsonResponse(
            channelSettings(state.mode as AiReplyMode, body.overrides || {}),
          ));
        }
      }

      if (path === '/api/audit' && method === 'POST') {
        return route.fulfill(jsonResponse({ id: 'audit-1' }, 201));
      }

      // ADR-0011: the authenticated dashboard mounts the billing-standing banner,
      // whose ClaimProvider evaluates claims for the usage-banner surface. An
      // empty decision set is fail-closed: the banner renders nothing.
      //
      // The inbox's AI controls (draft suggestion, "AI is replying", Take over)
      // are gated by useSubscriptionFeatures, which now resolves the
      // `ai.draft_reply` claim on the `subscription` surface rather than the
      // retired plan's advanced_ai feature flag. This suite exercises a shop
      // whose AI draft capability is available, so the subscription surface
      // returns that one claim; every other surface stays fail-closed.
      if (path === '/api/commercial/claims' && method === 'GET') {
        const surface = new URL(request.url()).searchParams.get('surface') ?? 'usage-banner';
        const registryHash = `sha256:${'a'.repeat(64)}`;
        const decisions = surface === 'subscription'
          ? [{
              claimId: 'ai.draft_reply',
              available: true,
              render: 'claim',
              textKey: 'claims.ai.draft_reply.en',
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
            }]
          : [];
        return route.fulfill(jsonResponse({
          surface,
          locale: 'en',
          contractVersion: '1.0.0',
          registryHash,
          decisions,
        }));
      }

      // The dashboard also resolves the public commercial contract (terms/price).
      if (path === '/api/public/commercial-contract' && method === 'GET') {
        return route.fulfill(jsonResponse({
          contract_version: '1.0.0',
          contract_hash: `sha256:${'b'.repeat(64)}`,
          model: 'DELIVERED_ORDER',
          currency: 'BDT',
          trigger: 'ORDER_DELIVERED_PROVIDER_CONFIRMED',
          unit_price_minor: 1000,
          unit_price_bdt: 10,
          zero_rated_outcomes: ['RETURNED', 'CANCELLED', 'DRAFT', 'CONFIRMED', 'BOOKED', 'IN_TRANSIT', 'FAILED'],
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
          description: { en: 'Pay BDT 10.00 per provider-confirmed delivered order.', bn: 'প্রতি ডেলিভারি অর্ডারে ৳১০.০০।' },
          registry_hash: `sha256:${'a'.repeat(64)}`,
          claims: [],
          decisions: [],
        }));
      }

      state.unexpectedApiRequests.push(`${method} ${path}`);
      await route.abort();
    },
  );

  return {
    state,
    sseRequested: sseRequested.promise,
    releaseSse: sseGate.resolve,
    assertNoUnexpectedApiRequests: () => {
      expect(state.unexpectedApiRequests, 'unexpected API requests').toEqual([]);
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

async function expectAiActiveCleared(page: Page): Promise<void> {
  await expect(page.getByText(/AI is replying/)).toHaveCount(0);
}

test('Scenario A: Manual, Draft, and Auto render in order and save the canonical mode', async ({ page }) => {
  const fixture = await setupRoutes(page, { mode: 'DRAFT' });
  // ADR-0013 §9: reply mode moved off the business profile to the business
  // automation defaults page. The radiogroup contract is unchanged.
  await loginAndGo(page, '/manage-shop/automation');

  const group = page.getByTestId('ai-reply-mode');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(group.locator('[role="radio"]')).toHaveCount(3);
  const optionIds = await group.locator('[data-testid^="ai-reply-mode-"]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-testid'))
  ));
  expect(optionIds).toEqual([
    'ai-reply-mode-manual',
    'ai-reply-mode-draft',
    'ai-reply-mode-auto',
  ]);

  for (const mode of ['MANUAL', 'DRAFT', 'AUTO'] as const) {
    const radio = page.getByTestId(`ai-reply-mode-${mode.toLowerCase()}`);
    await radio.click();
    await expect(radio).toHaveAttribute('aria-checked', 'true');

    const saveResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/shop/ai-settings' && response.request().method() === 'PUT';
    });
    await page.getByRole('button', { name: 'Save Reply Settings', exact: true }).click();
    await saveResponse;
    await expect(page.getByText('Reply settings saved.', { exact: true })).toBeVisible();
  }

  expect(fixture.state.savedModes).toEqual([
    { mode: 'MANUAL', auto_reply_enabled: false },
    { mode: 'DRAFT', auto_reply_enabled: false },
    { mode: 'AUTO', auto_reply_enabled: true },
  ]);
  await page.reload();
  await expect(page.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'true');
  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario B: the mode control is accessible; channels expose a labeled narrow-only override, never a legacy toggle', async ({ page }) => {
  const fixture = await setupRoutes(page, { mode: 'MANUAL' });
  await loginAndGo(page, '/manage-shop/automation');

  const group = page.getByTestId('ai-reply-mode');
  await expect(group).toHaveAttribute('aria-labelledby', 'ai-reply-mode-label');
  const manual = page.getByTestId('ai-reply-mode-manual');
  const draft = page.getByTestId('ai-reply-mode-draft');
  await expect(manual).toHaveAttribute('role', 'radio');
  await expect(manual).toHaveAttribute('aria-checked', 'true');
  await manual.press('ArrowRight');
  await expect(draft).toBeFocused();
  // Radix's roving-focus radio group moves focus on arrow keys and only
  // auto-selects the newly focused item on a real browser input event; a
  // Space activates the standard, framework-independent path.
  await draft.press('Space');
  await expect(draft).toHaveAttribute('aria-checked', 'true');

  // ADR-0013 §9: the legacy chat-settings route redirects to the channel
  // workspace. No legacy Page-level AI participation toggle may survive.
  await page.goto('/manage-shop/chat-settings');
  await expect(page).toHaveURL(/\/manage-shop\/channels$/);
  await expect(page.getByRole('heading', { name: 'Channels & Automation' })).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByText(/Page AI participation/i)).toHaveCount(0);

  // The per-channel control is a labeled, narrow-only override with explicit
  // inherit -> override -> revert affordances (never a second enablement path).
  await page.goto('/manage-shop/channels/meta-channel-1');
  await expect(page.getByTestId('channel-effective-mode')).toContainText('Manual replies only');
  await expect(page.getByTestId('channel-mode-source')).toContainText('Business default');
  await expect(page.getByTestId('channel-mode-override')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);

  await page.getByRole('button', { name: 'Override for this channel' }).click();
  const override = page.getByTestId('channel-mode-override');
  await expect(override).toHaveAttribute('role', 'radiogroup');
  // MANUAL business ceiling: only MANUAL may be stored for this channel.
  await expect(override.locator('input[value="MANUAL"]')).toHaveCount(1);
  await expect(override.locator('input[value="AUTO"]')).toHaveCount(0);
  await expect(page.getByText(/cannot be more automated than the business default/i)).toBeVisible();
  await expect(page.getByTestId('channel-override-revert-automation_mode')).toBeVisible();

  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario C: Manual mode suppresses the automatic-reply claim while keeping Inbox controls available', async ({ page }) => {
  const fixture = await setupRoutes(page, { mode: 'MANUAL' });
  await loginAndGo(page, '/inbox');

  await expect(page.getByRole('heading', { name: 'Shared Inbox' })).toBeVisible();
  await expect(page.getByTestId('inbox-ai-reply-mode')).toContainText('Manual replies only');
  await expectAiActiveCleared(page);

  const composer = page.getByPlaceholder('Type your reply here...', { exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();

  const hitlControl = page.getByRole('button', { name: /Take over/ });
  await expect(hitlControl).toBeVisible();
  const hitlResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/conversation/conv-1' && response.request().method() === 'PATCH';
  });
  await hitlControl.click();
  // ADR-0013 §8: "Take over" now asks for an optional fixed-list reason before
  // the pause is written. The takeover PATCH contract is unchanged; only the
  // confirmation step is new.
  const takeoverDialog = page.getByRole('dialog', { name: 'Take over this conversation?' });
  await expect(takeoverDialog).toBeVisible();
  await takeoverDialog.getByRole('button', { name: 'Take over' }).click();
  await hitlResponse;
  await expect(page.getByRole('button', { name: /Resume AI/ })).toBeVisible();
  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario D: Draft mode shows draft-ready only when an undelivered held message exists', async ({ page }) => {
  const fixture = await setupRoutes(page, { mode: 'DRAFT' });
  await loginAndGo(page, '/inbox');

  await expect(page.getByTestId('inbox-ai-reply-mode')).toContainText('Drafts for review');
  await expect(page.getByText('Draft ready for review', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send this', exact: true })).toHaveCount(0);

  fixture.state.messages['conv-1'] = [customerMessage(), heldDraftMessage()];
  await page.reload();
  await expect(page.getByText('Draft ready for review', { exact: true })).toBeVisible();
  await expect(page.getByText('"The draft reply is ready for your review."', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send this', exact: true })).toBeVisible();
  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario E: an SSE mode change updates Inbox without polling or reload', async ({ page }) => {
  const fixture = await setupRoutes(page, {
    mode: 'AUTO',
    holdSse: true,
    sseBody: [
      'retry: 10000',
      'event: ai_reply_mode_changed',
      'data: {"mode":"MANUAL"}',
      '',
      '',
    ].join('\n'),
  });
  await loginAndGo(page, '/inbox');

  await expect(page.getByText(/AI is replying/)).toBeVisible();
  await fixture.sseRequested;
  await fixture.releaseSse();
  const conversationFetchesBeforeSse = fixture.state.conversationFetches;
  await expect(page.getByTestId('inbox-ai-reply-mode')).toContainText('Manual replies only');
  await expectAiActiveCleared(page);
  expect(fixture.state.conversationFetches).toBe(conversationFetchesBeforeSse);
  fixture.assertNoUnexpectedApiRequests();
});

test.describe('Scenario F: terminal activity clears from Inbox', () => {
  test('after a merchant sends a reply', async ({ page }) => {
    const fixture = await setupRoutes(page, { mode: 'AUTO' });
    await loginAndGo(page, '/inbox');

    await expect(page.getByText(/AI is replying/)).toBeVisible();
    const composer = page.getByPlaceholder('Type your reply here...', { exact: true });
    await composer.fill('Thanks, it is available.');
    const sendResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/conversation/conv-1/messages' && response.request().method() === 'POST';
    });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await sendResponse;
    await expectAiActiveCleared(page);
    expect(fixture.state.createdMessages).toHaveLength(1);
    fixture.assertNoUnexpectedApiRequests();
  });

  test('after an SSE delivery failure', async ({ page }) => {
    const fixture = await setupRoutes(page, {
      mode: 'AUTO',
      messages: [
        customerMessage(),
        makeMessage(
          'ai-pending-1',
          'ai',
          'Pending automatic reply',
          -1_000,
          { delivery_state: 'SEND_PENDING', delivery_status: 'pending', delivered: false },
        ),
      ],
      holdSse: true,
      sseBody: [
        'retry: 10000',
        'event: delivery_failed',
        'data: {"conversation_id":"conv-1","message_id":"ai-pending-1","reason":"provider rejected"}',
        '',
        '',
      ].join('\n'),
    });
    await loginAndGo(page, '/inbox');

    await expect(page.getByText(/AI is replying/)).toBeVisible();
    await fixture.sseRequested;
    await fixture.releaseSse();
    await expectAiActiveCleared(page);
    fixture.assertNoUnexpectedApiRequests();
  });

  test('after human takeover cancels automatic activity', async ({ page }) => {
    const fixture = await setupRoutes(page, {
      mode: 'AUTO',
      holdSse: true,
      sseBody: [
        'retry: 10000',
        'event: hitl_changed',
        'data: {"conversation_id":"conv-1","hitl":true}',
        '',
        '',
      ].join('\n'),
    });
    await loginAndGo(page, '/inbox');

    await expect(page.getByText(/AI is replying/)).toBeVisible();
    await fixture.sseRequested;
    await fixture.releaseSse();
    await expectAiActiveCleared(page);
    fixture.assertNoUnexpectedApiRequests();
  });
});

test('Scenario G: a merchant-requested AI suggestion is visible and explicitly unsent', async ({ page }) => {
  const fixture = await setupRoutes(page, {
    mode: 'MANUAL',
    messages: [
      customerMessage(),
      makeMessage(
        'ai-requested-1',
        'ai',
        'Here is the requested answer.',
        -1_000,
        {
          delivery_state: 'HELD',
          delivered: false,
          held_reason: 'human_active',
          suggestion_visibility: 'VISIBLE_MERCHANT_REQUESTED',
        },
      ),
    ],
  });
  await loginAndGo(page, '/inbox');

  await expect(page.getByText('Human review required', { exact: true })).toBeVisible();
  await expect(page.getByText('AI suggestion — NOT SENT', { exact: true })).toBeVisible();
  await expect(page.getByText('"Here is the requested answer."', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send this', exact: true })).toBeVisible();
  await expect(page.getByText('AI Assistant', { exact: true })).toHaveCount(0);
  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario H: a Messenger quoted reply renders its resolved reference once', async ({ page }) => {
  const quotedMessage = makeMessage(
    'customer-quoted-1',
    'customer',
    'Large please',
    -1_000,
    {
      reply_to: {
        provider_message_id: 'mid-previous-1',
        status: 'resolved',
        sender: 'agent',
        content: 'Which size would you like?',
        message_type: 'text',
      },
    },
  );
  const fixture = await setupRoutes(page, {
    mode: 'MANUAL',
    messages: [
      makeMessage('agent-previous-1', 'agent', 'Previous Messenger reply', -2_000),
      quotedMessage,
    ],
  });
  await loginAndGo(page, '/inbox');

  await expect(page.getByText('Replying to:', { exact: false })).toBeVisible();
  await expect(page.getByText(/Replying to:\s*Which size would you like\?/)).toBeVisible();
  await expect(page.getByText('Previous Messenger reply', { exact: true })).toBeVisible();
  await expect(page.getByText('Large please', { exact: true })).toHaveCount(1);
  fixture.assertNoUnexpectedApiRequests();
});

test('Scenario I: read state and message identity stay isolated across two Messenger Pages', async ({ page }) => {
  const pageAConversation = makeConversation({
    id: 'conv-page-a',
    customer_id: 'customer-page-a',
    customer: { id: 'customer-page-a', name: 'Page A Customer' },
    meta_channel_id: 'meta-page-a',
    unreadCount: 1,
  });
  const pageBConversation = makeConversation({
    id: 'conv-page-b',
    customer_id: 'customer-page-b',
    customer: { id: 'customer-page-b', name: 'Page B Customer' },
    meta_channel_id: 'meta-page-b',
    unreadCount: 1,
  });
  const pageAMessage = { ...customerMessage(), id: 'page-a-message', conversation_id: 'conv-page-a', content: 'Page A private message' };
  const pageBMessage = { ...customerMessage(), id: 'page-b-message', conversation_id: 'conv-page-b', content: 'Page B private message' };
  const fixture = await setupRoutes(page, {
    mode: 'MANUAL',
    conversations: [pageAConversation, pageBConversation],
    messagesByConversation: {
      'conv-page-a': [pageAMessage],
      'conv-page-b': [pageBMessage],
    },
  });
  const firstRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/conversation/conv-page-a/read' && response.request().method() === 'POST';
  });
  await loginAndGo(page, '/inbox');
  await firstRead;

  await expect(page.getByRole('heading', { name: 'Page A Customer', exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('unread-badge')).toHaveCount(1);
  await expect(page.getByText('Page B Customer', { exact: true }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Page A Customer', exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('unread-badge')).toHaveCount(1);

  await page.getByRole('heading', { name: 'Page B Customer', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Page B Customer', exact: true }).last()).toBeVisible();
  await expect(page.getByText('Page B private message', { exact: true })).toBeVisible();
  await expect(page.getByText('Page A private message', { exact: true })).toHaveCount(0);

  fixture.assertNoUnexpectedApiRequests();
});
