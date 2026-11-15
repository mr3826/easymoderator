/**
 * /inbox guardrails proof (mock-only, CI subset). Mirrors the ai-reply-mode
 * fixture discipline: every /api/* path outside the allowlist is aborted and
 * recorded, so a redesign that invents backend calls fails here. Covers the
 * Core Design Test anatomy, single violet primary, keyboard focus, 390px
 * overflow, scoped axe, queue partial honesty and SSE-offline honesty.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const conv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    customer_id: `cust-${id}`,
    customer: { id: `cust-${id}`, name, channel_user_id: `psid-${id}` },
    channel: 'messenger',
    status: 'active',
    title: name,
    lastMessage: 'What is the price?',
    unreadCount: 0,
    created_at: iso(3_600_000),
    updated_at: iso(600_000),
    ...extra,
});

const baseConversations = [
    conv('conv-1', 'Alice'),
    conv('conv-2', 'Bob', {
        needs_merchant_reply: true,
        needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED',
        unreadCount: 2,
    }),
];

const customerMessage = (conversationId: string) => ({
    id: `msg-c-${conversationId}`,
    conversation_id: conversationId,
    sender: 'customer',
    content: 'What is the price?',
    message_type: 'text',
    created_at: iso(600_000),
    updated_at: iso(600_000),
    is_transcript_message: true,
});

const heldDraft = (conversationId: string) => ({
    id: `msg-d-${conversationId}`,
    conversation_id: conversationId,
    sender: 'ai',
    content: 'Here is the requested answer.',
    ai_suggestion: 'Here is the requested answer.',
    ai_confidence: 0.9,
    message_type: 'text',
    delivery_state: 'DRAFT_READY',
    metadata: { delivered: false, held_reason: 'draft_mode', suggestion_visibility: 'VISIBLE_DRAFT_REVIEW' },
    created_at: iso(300_000),
    updated_at: iso(300_000),
    is_transcript_message: false,
});

const json = (data: unknown) => ({ success: true, data });

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status',
    '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/shop/business-info',
    '/api/shop/ai-settings', '/api/conversation', '/api/conversation/events', '/api/templates',
    '/api/inbox/actions', '/api/channels/meta', '/api/audit', '/api/commercial/claims',
    '/api/public/commercial-contract',
]);
const KNOWN_PATTERNS = [
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/conversation\/[\w-]+\/read$/,
    /^\/api\/channels\/meta\/[\w-]+\/settings$/,
];

interface FixtureOptions {
    conversations?: ReturnType<typeof conv>[];
    messagesFor?: (conversationId: string) => unknown[];
    queuePartial?: boolean;
    queueItems?: unknown[];
    sseOffline?: boolean;
}

async function setupRoutes(page: Page, options: FixtureOptions = {}) {
    const state = { signedIn: false, unexpected: [] as string[], conversationFetches: 0 };
    const conversations = options.conversations ?? baseConversations;
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((pattern) => pattern.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        if (path === '/api/csrf') return route.fulfill({ json: json({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/setup/status') return route.fulfill({ json: json({ complete: true }) });
        if (path === '/api/subscription') {
            return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        }
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
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
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash, decisions }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/conversation' && method === 'GET') {
            state.conversationFetches += 1;
            return route.fulfill({
                json: json({
                    conversations,
                    ai_reply_mode: 'MANUAL',
                    pagination: { total: conversations.length, page: 1, pageSize: 50, totalPages: 1 },
                }),
            });
        }
        if (/^\/api\/conversation\/[\w-]+$/.test(path) && method === 'GET') {
            const id = path.split('/').pop();
            return route.fulfill({ json: json(conversations.find((c) => c.id === id) ?? conversations[0]) });
        }
        if (/^\/api\/conversation\/[\w-]+\/messages$/.test(path) && method === 'GET') {
            const id = path.split('/')[3];
            const messages = options.messagesFor?.(id) ?? [customerMessage(id)];
            return route.fulfill({ json: json({ messages, suggestions: [], pagination: { page: 1, totalPages: 1 } }) });
        }
        if (/^\/api\/conversation\/[\w-]+\/read$/.test(path) && method === 'POST') {
            const id = path.split('/')[3];
            const target = conversations.find((c) => c.id === id);
            return route.fulfill({ json: json({ ...target, unreadCount: 0 }) });
        }
        if (path === '/api/conversation/events') {
            if (options.sseOffline) return route.abort();
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: 'retry: 10000\n\n',
            });
        }
        if (path === '/api/templates') return route.fulfill({ json: json([]) });
        if (path === '/api/inbox/actions') {
            const items = options.queueItems ?? [];
            return route.fulfill({
                json: json({
                    items,
                    generated_at: iso(0),
                    partial: options.queuePartial === true,
                    counts: { total: items.length, views: { attention: items.length } },
                }),
            });
        }
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/inbox');
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('anatomy: title, one dominant signal, one primary above the fold', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Shared Inbox', level: 1 })).toBeVisible();
    const signal = page.getByTestId('inbox-signal');
    await expect(signal).toBeVisible();
    await expect(signal).toContainText('Needs review');
    const primary = page.getByTestId('inbox-primary-action');
    await expect(primary).toHaveCount(1);
    const box = await primary.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(720);
    await expect(page.locator('.em-inbox header p').first()).not.toHaveText('');
    expect(state.unexpected).toEqual([]);
});

test('primary opens the next reply task without refetching the list', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const primary = page.getByTestId('inbox-primary-action');
    await expect(primary).toContainText('Open next reply');
    const before = state.conversationFetches;
    await primary.click();
    await page.waitForURL(/conversation=conv-2/);
    await expect(page.getByRole('heading', { name: 'Bob', exact: true }).last()).toBeVisible();
    expect(state.conversationFetches).toBe(before);
    expect(state.unexpected).toEqual([]);
});

test('exactly one violet primary on the base screen', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('inbox-primary-action')).toBeVisible();
    const count = await page.evaluate(
        () => document.querySelectorAll('.em-inbox button.bg-em-violet-600').length,
    );
    expect(count).toBe(1);
});

test('held draft keeps one violet primary; approval is sunlight', async ({ page }) => {
    const state = await setupRoutes(page, {
        messagesFor: (id) => [customerMessage(id), heldDraft(id)],
    });
    await loginAndGo(page);
    await page.getByRole('button', { name: /Alice/ }).first().click();
    await expect(page.getByRole('button', { name: 'Send this', exact: true })).toBeVisible();
    const count = await page.evaluate(
        () => document.querySelectorAll('.em-inbox button.bg-em-violet-600').length,
    );
    expect(count).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('keyboard: visible focus ring on the primary action', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('inbox-primary-action')).toBeVisible();
    let focused = false;
    for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Tab');
        focused = await page.evaluate(
            () => document.activeElement?.getAttribute('data-testid') === 'inbox-primary-action',
        );
        if (focused) break;
    }
    expect(focused).toBe(true);
    await page.waitForTimeout(300);
    const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
});

test('390px: no horizontal overflow, single-pane swap and back', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('button', { name: /Bob/ }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: /Bob/ }).first().click();
    const back = page.getByRole('button', { name: 'Back to conversations' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.getByRole('button', { name: /Bob/ }).first()).toBeVisible();
});

test('axe: no critical or serious violations inside .em-inbox', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('inbox-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-inbox').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});

test('partial queue is labeled, never fabricated', async ({ page }) => {
    const state = await setupRoutes(page, {
        queuePartial: true,
        queueItems: [{
            bucket: 1,
            item_key: 'hitl:conv-2',
            reason_code: 'HITL_REQUIRED',
            source: { type: 'conversation', id: 'conv-2' },
            conversation_id: 'conv-2',
            customer_id: 'cust-conv-2',
            status: 'awaiting_human',
            owner: null,
            next_action: { type: 'open_conversation' },
            grounded_deadline: null,
            since: iso(7_200_000),
        }],
    });
    await loginAndGo(page);
    await expect(page.getByTestId('action-queue-partial')).toBeVisible();
    await expect(page.getByTestId('action-item')).toHaveCount(1);
    expect(state.unexpected).toEqual([]);
});

test('SSE offline is announced honestly', async ({ page }) => {
    await setupRoutes(page, { sseOffline: true });
    await loginAndGo(page);
    const rail = page.getByTestId('inbox-evidence-rail');
    await expect(rail).toBeVisible();
    await rail.locator('summary').click();
    await expect(rail.getByText('Live updates offline — reconnecting')).toBeVisible({ timeout: 15000 });
});
