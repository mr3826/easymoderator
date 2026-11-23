/**
 * G-UX04 — inbox → order → inbox continuity (mock-only Playwright, CI
 * registration deferred to A0/A7; runnable with `npm run test:e2e --
 * tests/e2e/inbox-order-continuity.spec.ts --workers=1`).
 *
 * Drives the REAL anchors (no invented selectors — all testids/params read
 * from CustomerContextPanel.tsx, Orders.tsx, InboxThreadDetail.tsx,
 * UnifiedInbox.tsx at this SHA):
 *  1. context-create-order hands off to /orders?create=1&… (WP-03 `channel`
 *     param + #301 fail-closed seeding): the create form opens PREFILLED and
 *     the params are consumed from the URL; NOTHING is posted — the handoff
 *     must not silently create an order (negative irreversible-effect check).
 *  2. context-order-row deep-links /orders?orderId=…, the detail opens, and
 *     the FE-08 verified-customer return link restores the SAME conversation
 *     in /inbox?conversation=… — and it survives a refresh.
 *  3. an unknown orderId fails closed: alert + retry, never a misleading
 *     empty-success, and the worklist stays honest.
 *  4. when the mocked shop context switches, no stale conversation/order from
 *     the previous context remains anywhere in the panel or list.
 *  5. unknown ?bucket=/?payment= values keep the default filters (#301
 *     fail-closed), while a valid bucket seeds the matching chip.
 *
 * Fixture discipline follows inbox-guardrails.spec.ts / mwv1-journeys.spec.ts
 * (allowlist + abort-unknown + unexpected[] assertions; synthetic BD data).
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShopA = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Shop A Continuity', role: 'owner' };
const mockShopB = { id: 'shop-2', unique_code: 'SHOP2', shop_name: 'Shop B Continuity', role: 'owner' };

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const json = (data: unknown) => ({ success: true, data });

const conv = (id: string, custId: string, name: string, shop: 'A' | 'B') => ({
    id,
    customer_id: custId,
    customer: { id: custId, name, channel_user_id: `psid-${custId}`, phone: '01799887766' },
    channel: 'messenger',
    status: 'active',
    title: name,
    lastMessage: 'order ta confirm korte chai',
    unreadCount: 0,
    created_at: iso(86_400_000),
    updated_at: iso(600_000),
});

const order = (id: string, number: string, custId: string, name: string) => ({
    id, order_number: number, customer_id: custId, customer_name: name, customer_phone: '01799887766',
    delivery_address: 'House 1, Dhanmondi, Dhaka', items: [{ product_name: 'Jamdani Saree', quantity: 1, price: 1490 }],
    total: 1490, status: 'confirmed', channel: 'messenger', payment_method: 'COD', payment_status: 'unpaid',
    fulfillment_status: 'unfulfilled', delivery_status: null, created_at: iso(3_600_000), metadata: {},
});

const SHOP_A = {
    conversations: [conv('conv-1', 'cust-1', 'Rina Akter', 'A'), conv('conv-2', 'cust-2', 'Farhana Begum', 'A')],
    orders: [order('o9', 'ORD-1001', 'cust-1', 'Rina Akter'), order('o10', 'ORD-1002', 'cust-2', 'Farhana Begum')],
};
const SHOP_B = {
    conversations: [conv('conv-b1', 'cust-b1', 'Karim Bhai', 'B')],
    orders: [order('o-b1', 'ORD-2002', 'cust-b1', 'Karim Bhai')],
};

interface FixtureState {
    signedIn: boolean;
    unexpected: string[];
    orderListCalls: (string | null)[];
    postedOrders: unknown[];
    shop: 'A' | 'B';
}

async function setupRoutes(page: Page): Promise<FixtureState> {
    const state: FixtureState = { signedIn: false, unexpected: [], orderListCalls: [], postedOrders: [], shop: 'A' };

    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}${url.search}`);
            return route.abort();
        }
        const dataset = state.shop === 'A' ? SHOP_A : SHOP_B;

        if (path === '/api/csrf') return route.fulfill({ json: json({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            const shop = state.shop === 'A' ? mockShopA : mockShopB;
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop, allShops: [shop] }) });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            const shop = state.shop === 'A' ? mockShopA : mockShopB;
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop, allShops: [shop] }) });
        }
        if (path === '/api/setup/status') return route.fulfill({ json: json({ complete: true }) });
        if (path === '/api/subscription') {
            return route.fulfill({ json: json({ subscription: { plan_code: 'PRO', plan_name: 'Pro', features: { advanced_ai: true, image_understanding: true } }, effective_conversation_limit: -1, usage: {}, period: { start: iso(86_400_000) } }) });
        }
        if (path === '/api/customer-intelligence/status') {
            return route.fulfill({ json: json({ customer_intelligence: true, action_queue: true, interaction_choices: true, knowledge_suggestions: false, order_confidence_mode: 'off' }) });
        }
        if (path.startsWith('/api/customer-intelligence/customers/')) {
            // The panel's gated relationship block (customer_intelligence is
            // on in this fixture) — a neutral synthetic 360, never real data.
            const custId = path.split('/').pop();
            const row = dataset.conversations.find((c) => c.customer_id === custId);
            return route.fulfill({ json: json({
                customer: { name: row?.customer?.name ?? 'Unknown' },
                contactability: { platform: 'messenger', window_open: true, reason: '' },
                state: 'BUYER', state_reasons: [],
                summary: { total_orders: 1, delivered_orders: 0, delivered_value: 0, ordered_value: 1490 },
                rto_signal: { available: false }, orders: [], conversations: [], opportunities: [], timeline: [],
            }) });
        }
        if (path === '/api/conversation' && method === 'GET') {
            const customerId = url.searchParams.get('customer_id');
            const rows = customerId
                ? dataset.conversations.filter((c) => c.customer_id === customerId)
                : dataset.conversations;
            return route.fulfill({ json: json({ conversations: rows, ai_reply_mode: 'MANUAL', pagination: { total: rows.length, page: 1, pageSize: 50, totalPages: 1 } }) });
        }
        if (/^\/api\/conversation\/[\w-]+$/.test(path) && method === 'GET') {
            const id = path.split('/').pop();
            return route.fulfill({ json: json(dataset.conversations.find((c) => c.id === id) ?? dataset.conversations[0]) });
        }
        if (/^\/api\/conversation\/[\w-]+\/messages$/.test(path) && method === 'GET') {
            const id = path.split('/')[3];
            return route.fulfill({
                json: json({
                    messages: [{
                        id: `msg-c-${id}`, conversation_id: id, sender: 'customer',
                        content: 'order ta confirm korte chai — A6 continuity fixture',
                        message_type: 'text', created_at: iso(600_000), updated_at: iso(600_000),
                        is_transcript_message: true,
                    }],
                    suggestions: [], pagination: { page: 1, totalPages: 1 },
                }),
            });
        }
        if (/^\/api\/conversation\/[\w-]+\/read$/.test(path) && method === 'POST') {
            const id = path.split('/')[3];
            return route.fulfill({ json: json({ ...dataset.conversations.find((c) => c.id === id) ?? dataset.conversations[0], unreadCount: 0 }) });
        }
        if (path === '/api/conversation/events') {
            return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 10000\n\n' });
        }
        if (path === '/api/templates') return route.fulfill({ json: json([]) });
        if (path === '/api/inbox/actions') {
            return route.fulfill({ json: json({ items: [], generated_at: iso(0), partial: false, counts: { total: 0, returned: 0, views: { attention: 0, unassigned: 0, mine: 0, handoff: 0, recovery: 0 } } }) });
        }
        if (path === '/api/order' && method === 'GET') {
            const customerId = url.searchParams.get('customer_id');
            state.orderListCalls.push(customerId);
            const rows = customerId ? dataset.orders.filter((o) => o.customer_id === customerId) : dataset.orders;
            return route.fulfill({ json: json(rows) });
        }
        if (path === '/api/order' && method === 'POST') {
            state.postedOrders.push(request.postData());
            return route.fulfill({ json: json({ id: 'should-never-be-created' }) });
        }
        if (path === '/api/order/counts') {
            return route.fulfill({ json: json({ total: dataset.orders.length, to_confirm: 1, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0 }) });
        }
        if (/^\/api\/order\/[^/]+$/.test(path) && method === 'GET') {
            const found = dataset.orders.find((o) => o.id === path.split('/').pop());
            return found
                ? route.fulfill({ json: json(found) })
                : route.fulfill({ status: 404, json: { success: false, error: { code: 'NOT_FOUND' } } });
        }
        if (/^\/api\/order-confidence\/orders\/[^/]+$/.test(path)) return route.fulfill({ json: json({ mode: 'off', decision: null }) });
        if (path === '/api/payment/config') return route.fulfill({ json: json([{ id: 'cod-config', gateway: 'cod', is_enabled: true }]) });
        if (path === '/api/product') return route.fulfill({ json: json([]) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/shop/agents') return route.fulfill({ json: json([{ id: 'user-1', full_name: 'Test Owner', role: 'owner' }]) });
        if (path === '/api/commercial/claims') {
            return route.fulfill({ json: json({ surface: url.searchParams.get('surface') ?? 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (/^\/api\/customer\/[\w-]+\/notes$/.test(path) && method === 'GET') return route.fulfill({ json: json({ data: [], total: 0 }) });
        if (/^\/api\/customer\/[\w-]+\/tags$/.test(path) && method === 'GET') return route.fulfill({ json: json({ data: [] }) });
        if (path === '/api/customer/tags' && method === 'GET') return route.fulfill({ json: json({ data: [] }) });
        if (path === '/api/audit') return route.fulfill({ json: json({ id: 'audit-1' }) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status',
    '/api/subscription', '/api/customer-intelligence/status',
    '/api/conversation', '/api/conversation/events', '/api/templates', '/api/inbox/actions',
    '/api/order', '/api/order/counts', '/api/payment/config', '/api/product',
    '/api/notifications/in-app', '/api/shop/agents', '/api/commercial/claims',
    '/api/public/commercial-contract', '/api/audit', '/api/customer/tags',
]);
const KNOWN_PATTERNS = [
    /^\/api\/customer-intelligence\/customers\/[^/]+$/,
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/conversation\/[\w-]+\/read$/,
    /^\/api\/order\/[^/]+$/,
    /^\/api\/order-confidence\/orders\/[^/]+$/,
    /^\/api\/customer\/[\w-]+\/notes$/,
    /^\/api\/customer\/[\w-]+\/tags$/,
];

async function loginAndGo(page: Page, path: string) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto(path);
}

async function openThreadAndPanel(page: Page, name: string) {
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await page.getByTestId('context-toggle').click();
    await expect(page.getByTestId('customer-context-panel')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('inbox → create-order handoff: WP-03 channel + contact seed, params consumed, zero POSTs', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/inbox');
    await openThreadAndPanel(page, 'Rina');

    await page.getByTestId('context-create-order').click();
    await expect(page).toHaveURL(/\/orders/);

    const modal = page.getByTestId('create-order-modal');
    await expect(modal).toBeVisible();
    // The name input has no htmlFor association — anchor on its real
    // placeholder instead (en.json orders.createModal.customerNamePlaceholder).
    await expect(modal.getByPlaceholder('Enter customer name')).toHaveValue('Rina Akter');

    const phone = modal.locator('#order-customer-phone'); // explicit id in Orders.tsx
    const phoneDigits = (await phone.inputValue()).replace(/\D/g, '');
    expect(phoneDigits).toBe('01799887766');

    // WP-03: the form channel comes from the conversation's authoritative
    // `channel` param ('messenger' → 'messenger'), never a guess. The
    // channel <select> is the first select inside the customer section.
    await expect(modal.locator('select').first()).toHaveValue('messenger');

    // The seed consumed the handoff params (no stale re-seed on refresh).
    await expect(page).not.toHaveURL(/create=1|customerName=|customerPhone=|channel=/);

    // Negative irreversible-effect: opening the seeded form must POST nothing.
    expect(state.postedOrders).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

test('inbox → order deep link → FE-08 return link restores the same conversation, refresh-stable', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/inbox');
    await openThreadAndPanel(page, 'Rina');
    // Association is by verified customer id (J1 contract), never a name.
    expect(state.orderListCalls).toContain('cust-1');

    await page.getByTestId('context-order-row').first().click();
    // Match /orders with OR without the seed param: consumption happens on
    // mount and can beat the first poll — the panel, not the URL, is the
    // settle gate here; the not.toHaveURL below proves it got cleaned up.
    await expect(page).toHaveURL(/\/orders(\?|$)/);
    const panel = page.getByTestId('order-detail-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('ORD-1001');
    // The deep-link param is consumed once the order resolves.
    await expect(page).not.toHaveURL(/orderId=/);

    // FE-08: chat snippet resolves ONLY through the verified customer id.
    const back = page.getByRole('button', { name: 'Open conversation in Inbox' });
    await expect(back).toBeVisible();
    await back.click();
    await page.waitForURL(/\/inbox\?conversation=conv-1/);
    await expect(page.getByRole('heading', { name: 'Rina Akter', exact: true }).last()).toBeVisible();

    // Refresh restores the SAME conversation selection (canonical deep link).
    await page.reload();
    await expect(page).toHaveURL(/conversation=conv-1/);
    await expect(page.getByRole('heading', { name: 'Rina Akter', exact: true }).last()).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('unknown orderId fails closed: alert + retry, no misleading empty-success, worklist intact', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/inbox');

    await page.goto('/orders?orderId=ghost-order');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('This order could not be loaded. It may be unavailable or outside this shop.');
    await expect(page.getByTestId('order-detail-panel')).toHaveCount(0);
    // Honest worklist: the shop's real rows are still listed (no fake empty
    // success), and the failing id is not silently opened.
    await expect(page.getByRole('button', { name: 'ORD-1001' })).toBeVisible();

    await alert.getByRole('button', { name: /retry/i }).click();
    await expect(alert).toBeVisible();
    await expect(page.getByTestId('order-detail-panel')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('shop context switch leaves no stale cross-context conversation/order behind', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/inbox');
    await openThreadAndPanel(page, 'Rina');
    await expect(page.getByTestId('context-order-row').first()).toContainText('ORD-1001');

    // Flip the mocked shop context and re-enter the inbox fresh.
    state.shop = 'B';
    state.signedIn = true; // auth/me now answers as Shop B
    await page.goto('/inbox');
    await expect(page.getByRole('button', { name: /Karim Bhai/ })).toBeVisible();
    await expect(page.getByText('Rina Akter')).toHaveCount(0);
    await expect(page.getByText('ORD-1001')).toHaveCount(0);

    await page.getByRole('button', { name: /Karim Bhai/ }).first().click();
    await page.getByTestId('context-toggle').click();
    const panel = page.getByTestId('customer-context-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('context-order-row').first()).toContainText('ORD-2002');
    await expect(panel).not.toContainText('Rina');
    await expect(panel).not.toContainText('ORD-1001');

    // Every order-list read after the switch was scoped to Shop B's customer
    // — the previous shop's id must not be re-queried in the new context.
    const callsAfterSwitch = state.orderListCalls.slice(state.orderListCalls.indexOf('cust-1') + 1);
    expect(callsAfterSwitch).not.toContain('cust-1');
    expect(state.orderListCalls).toContain('cust-b1');
    expect(state.unexpected).toEqual([]);
});

test('fail-closed worklist seed: unknown bucket/payment values keep defaults; valid bucket seeds the chip', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/inbox');

    await page.goto('/orders?bucket=nonsense&payment=not_a_payment');
    await expect(page.getByTestId('orders-signal')).toBeVisible();
    await expect(page.getByTestId('orders-bucket-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('orders-bucket-to_confirm')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'ORD-1001' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.goto('/orders?bucket=to_confirm');
    await expect(page.getByTestId('orders-bucket-to_confirm')).toHaveAttribute('aria-pressed', 'true');
    expect(state.unexpected).toEqual([]);
});
