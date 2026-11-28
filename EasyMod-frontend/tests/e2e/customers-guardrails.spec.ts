/**
 * Customers-worklist guardrails proof (mock-only, CI subset). Execution-class
 * worklist (header-removal C1/C6): no permanent signal band — compact titles
 * survive, counts relocated to the tab strip (pilot) / search toolbar
 * (legacy); tabpanel semantics, docked detail sections, legacy CRUD and phone
 * contact, email clearing, pagination clamp, legacy create-dialog focus trap
 * + Escape, 390px no-overflow, axe `.em-customers`. The detailed
 * opportunity/confidence/deep-link contracts remain covered by
 * customer-intelligence.spec.ts.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role: 'owner' };
const json = (data: unknown, status = 200) => ({ success: status < 400, data });

const repeatBuyer = {
    id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', channel_type: 'messenger',
    state: 'REPEAT_BUYER', state_reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 2 } }],
    total_orders: 3, delivered_orders: 2, returned_orders: 0, delivered_value: 3000,
    last_activity_at: new Date().toISOString(), open_opportunity: null,
};

type LegacyCustomerFixture = {
    id: string;
    name: string;
    phone?: string | null;
    number?: string | null;
    email?: string | null;
    channel_type?: string;
    channel?: string;
    created_at: string;
};

const legacyCustomer: LegacyCustomerFixture = {
    id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', email: 'rahim@example.com',
    channel_type: 'messenger', created_at: '2026-01-01T00:00:00.000Z',
};

const manyLegacyCustomers = Array.from({ length: 21 }, (_, index): LegacyCustomerFixture => ({
    id: `cust-${index + 1}`,
    name: `Customer ${index + 1}`,
    phone: `017${String(index + 1).padStart(8, '0')}`,
    channel_type: 'manual',
    created_at: '2026-01-01T00:00:00.000Z',
}));

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const customerDetail = {
    customer: { ...repeatBuyer, last_inbound_at: iso(-3600000), page: { id: 'pg', name: 'Pilot Page', platform: 'facebook' } },
    contactability: { platform: 'facebook', window_open: true, window_closes_at: iso(23 * 3600000), reason: 'WITHIN_24H_WINDOW' },
    state: 'REPEAT_BUYER', state_reasons: repeatBuyer.state_reasons, state_rules_version: 'customer-state/1.0.0',
    summary: {
        total_orders: 3, delivered_orders: 2, returned_orders: 0, cancelled_orders: 1, in_progress_orders: 0,
        ordered_value: 3000, delivered_value: 3000, first_order_at: iso(-20 * 86400000), last_order_at: iso(-5 * 86400000),
        last_delivered_at: iso(-3 * 86400000),
    },
    rto_signal: { available: true, tier: 'clear', risk_score: 0, list: null, network: null },
    orders: [
        { id: 'ord-d1', order_number: 'ORD-100', created_at: iso(-10 * 86400000), total: 1000, order_status: 'delivered', payment_status: 'pending', delivery_status: 'delivered', delivery_provider: 'pathao', outcome: 'DELIVERED', link: 'CUSTOMER', confidence: null },
    ],
    conversations: [],
    opportunities: [],
    timeline: [
        { type: 'ORDER_DELIVERED', at: iso(-3 * 86400000), order_id: 'ord-d1', order_number: 'ORD-100' },
    ],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/notifications/in-app', '/api/notifications/telegram',
    '/api/rto-shield/settings', '/api/product', '/api/order', '/api/conversation',
    '/api/customer-intelligence/status', '/api/customer-intelligence/overview',
    '/api/customer-intelligence/customers', '/api/customer-intelligence/opportunities',
    '/api/commercial/claims', '/api/public/commercial-contract', '/api/customer', '/api/customer/tags',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/customer-intelligence\/customers\/[\w-]+$/,
    /^\/api\/customer\/[\w-]+(?:\/(?:notes|tags)(?:\/[\w-]+)?)?$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { pilot?: boolean; legacyCustomers?: LegacyCustomerFixture[]; shrinkLegacyTotalOnPageTwo?: boolean } = {}) {
    const pilot = options.pilot ?? true;
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        customerListRequests: [] as Array<Record<string, string>>,
        customerCreates: [] as Record<string, unknown>[],
        customerUpdates: [] as Array<{ id: string; body: Record<string, unknown> }>,
        customerDeletes: [] as string[],
    };
    let legacyCustomers = (options.legacyCustomers ?? [legacyCustomer]).map((customer) => ({ ...customer }));
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.fulfill({ json: json([]) });
        }
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/customer-intelligence/overview' && method === 'GET') {
            return route.fulfill({ json: json({
                total_records: 1, buyers: 1, repeat_buyers: 1, new_buyers: 0, open_opportunities: 0,
                scanned_orders: 4, total_linked_orders: 4, order_scan_cap: 100, coverage_complete: true,
                definitions: {
                    buyers: 'At least one delivered order in the scanned set.',
                    repeat_buyers: 'At least two delivered orders in the scanned set.',
                    new_buyers: 'First delivered order in the last 30 days; available only when order coverage is complete.',
                    open_opportunities: 'Open or actioned customer opportunities.',
                    order_linkage: 'Orders linked by customer or phone.',
                },
            }) });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } }) });
        }
        if (path === '/api/channels/meta' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
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
        if (path === '/api/setup/status') return route.fulfill({ json: json({ isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [] }) });
        if (path === '/api/dashboard/metrics') return route.fulfill({ json: json({}) });
        if (path === '/api/dashboard/queue') return route.fulfill({ json: json({}) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/notifications/telegram') return route.fulfill({ json: json({ connected: false }) });
        if (path === '/api/rto-shield/settings') return route.fulfill({ json: json({ contribute: true, enforce: true }) });
        if (path === '/api/product') return route.fulfill({ json: json([]) });
        if (path === '/api/order' || path === '/api/conversation') return route.fulfill({ json: json([]) });
        if (path === '/api/customer-intelligence/status') return route.fulfill({ json: json({ customer_intelligence: pilot, order_confidence_mode: pilot ? 'enforce' : 'off' }) });
        if (path === '/api/customer-intelligence/customers' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [repeatBuyer], total: 1, page: 1, pageSize: 20 }) });
        if (/^\/api\/customer-intelligence\/customers\/[\w-]+$/.test(path)) return route.fulfill({ json: json(customerDetail) });
        if (path === '/api/customer-intelligence/opportunities') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [], total: 0, page: 1, pageSize: 20 }) });
        if (path === '/api/customer/tags' && method === 'GET') return route.fulfill({ json: json({ data: [] }) });
        if (/^\/api\/customer\/[\w-]+\/notes$/.test(path) && method === 'GET') return route.fulfill({ json: json({ data: [], total: 0 }) });
        if (/^\/api\/customer\/[\w-]+\/tags$/.test(path) && method === 'GET') return route.fulfill({ json: json({ data: [] }) });
        if (path === '/api/customer' && method === 'GET') {
            const query = Object.fromEntries(url.searchParams.entries());
            state.customerListRequests.push(query);
            const search = (url.searchParams.get('search') ?? '').toLowerCase();
            const phone = url.searchParams.get('phone') ?? '';
            const channel = url.searchParams.get('channel_type') ?? '';
            const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? 1));
            const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
            if (options.shrinkLegacyTotalOnPageTwo && pageNumber > 1 && legacyCustomers.length > pageSize) {
                legacyCustomers = legacyCustomers.slice(0, pageSize);
            }
            const matching = legacyCustomers.filter((customer) => (
                (!search || customer.name.toLowerCase().includes(search))
                && (!phone || String(customer.phone ?? customer.number ?? '').includes(phone))
                && (!channel || (customer.channel ?? customer.channel_type) === channel)
            ));
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                success: true,
                data: matching.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
                total: matching.length,
                page: pageNumber,
                pageSize,
            }) });
        }
        if (path === '/api/customer' && method === 'POST') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.customerCreates.push(body);
            const created: LegacyCustomerFixture = {
                id: 'cust-created', name: String(body.name ?? ''), number: String(body.number ?? ''),
                email: typeof body.email === 'string' ? body.email : null,
                channel: String(body.channel ?? 'manual'), channel_type: String(body.channel ?? 'manual'),
                created_at: '2026-02-01T00:00:00.000Z',
            };
            legacyCustomers = [...legacyCustomers, created];
            return route.fulfill({ status: 201, json: json(created) });
        }
        const legacyCustomerMatch = path.match(/^\/api\/customer\/([\w-]+)$/);
        if (legacyCustomerMatch && method === 'GET') {
            const customer = legacyCustomers.find((item) => item.id === legacyCustomerMatch[1]);
            return route.fulfill({ status: customer ? 200 : 404, json: json(customer ?? {}) });
        }
        if (legacyCustomerMatch && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.customerUpdates.push({ id: legacyCustomerMatch[1], body });
            legacyCustomers = legacyCustomers.map((customer) => customer.id === legacyCustomerMatch[1]
                ? { ...customer, ...body, number: String(body.number ?? customer.number ?? customer.phone ?? '') }
                : customer);
            const updated = legacyCustomers.find((customer) => customer.id === legacyCustomerMatch[1]);
            return route.fulfill({ json: json(updated ?? {}) });
        }
        if (legacyCustomerMatch && method === 'DELETE') {
            state.customerDeletes.push(legacyCustomerMatch[1]);
            legacyCustomers = legacyCustomers.filter((customer) => customer.id !== legacyCustomerMatch[1]);
            return route.fulfill({ json: json({ deleted: true }) });
        }
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page, target = '/customers') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    const signinResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/auth/signin' && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: /sign in/i }).click();
    expect((await signinResponsePromise).ok()).toBeTruthy();
    await page.waitForURL(/\/(dashboard|inbox)/);
    if (target === '/customers') await page.getByRole('link', { name: 'Customers', exact: true }).click();
    else await page.goto(target);
    // Header-removal C6: the signal testid is gone on list and detail alike;
    // every surface keeps exactly one level-1 heading as the mount anchor.
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('pilot page: sr-only title (customer360.title == AppBar "Customers" in en+bn), no signal band or header CTA, tabpanel + honest counts', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: true });
    await loginAndGo(page);
    // C1 amendment: byte-identical to the AppBar nav name → srOnly legal; the
    // heading pin keeps passing via the preserved accessible name.
    await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
    // C6: the page-level signal badge must NOT exist any more.
    await expect(page.getByTestId('customers-signal')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // C4: the list total stays honest — relocated from the header pill to the
    // 'all' tab badge (mock total 1); the opportunities tab badges its count.
    await expect(page.getByTestId('customers-tab-all')).toContainText('1');
    await expect(page.getByTestId('customers-tab-opportunities')).toBeVisible();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('legacy worklist keeps its honest header + result count', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Customer Management', exact: true })).toBeVisible();
    await expect(page.getByTestId('customers-result-count')).toContainText('1 customers in this shop');
    await expect(page.getByTestId('customers-tab-opportunities')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('flag-off legacy customer can be created and viewed, with delete persisted by API', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    await expect(page.getByTestId('customer-table').getByRole('row').filter({ hasText: 'Rahim Uddin' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Customer' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Add Customer' });
    await createDialog.getByLabel('Name').fill('Created customer');
    await createDialog.getByLabel('Phone Number').fill('01712345678');
    await createDialog.getByLabel('Channel').selectOption('manual');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('customer-table').getByRole('row').filter({ hasText: 'Created customer' })).toBeVisible();
    expect(state.customerCreates[0]).toMatchObject({ name: 'Created customer', number: '01712345678', channel: 'manual' });

    const createdRow = page.getByTestId('customer-table').getByRole('row').filter({ hasText: 'Created customer' });
    await createdRow.getByRole('button', { name: 'View', exact: true }).click();
    const detailDrawer = page.getByRole('dialog', { name: 'Customer Details' });
    await expect(detailDrawer).toContainText('Created customer');
    await detailDrawer.getByRole('button', { name: 'Close' }).click();

    const deleteStatus = await page.evaluate(async (customerId) => {
        const response = await fetch(`/api/customer/${customerId}`, { method: 'DELETE' });
        return response.status;
    }, 'cust-created');
    expect(deleteStatus).toBe(200);
    await page.reload();
    await expect(createdRow).toHaveCount(0);
    expect(state.customerDeletes).toEqual(['cust-created']);
    expect(state.unexpected).toEqual([]);
});

test('flag-off customer drawer links the phone and edit clears the email', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    const row = page.getByTestId('customer-table').getByRole('row').filter({ hasText: 'Rahim Uddin' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'View', exact: true }).click();

    const drawer = page.getByRole('dialog', { name: 'Customer Details' });
    const phoneLink = drawer.getByRole('link', { name: '01711111111' });
    await expect(phoneLink).toHaveAttribute('href', 'tel:01711111111');
    const ordersButton = drawer.getByRole('button', { name: 'View orders for this phone' });
    await expect(ordersButton).toBeVisible();
    await drawer.getByRole('button', { name: 'Edit', exact: true }).click();

    const editDialog = page.getByRole('dialog', { name: 'Edit customer' });
    await editDialog.getByLabel('Email (Optional)').fill('');
    const updateResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/customer/cust-1' && response.request().method() === 'PATCH'
    ));
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await updateResponsePromise;
    await expect(editDialog).toHaveCount(0);
    await expect(drawer.getByText('Not provided', { exact: true })).toBeVisible();
    expect(state.customerUpdates).toEqual([{
        id: 'cust-1',
        body: { name: 'Rahim Uddin', number: '01711111111', email: null },
    }]);
    await ordersButton.click();
    await expect(page).toHaveURL(/\/orders\?search=01711111111$/);
    expect(state.unexpected).toEqual([]);
});

test('legacy pagination clamps when the server total shrinks below the current page', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false, legacyCustomers: manyLegacyCustomers, shrinkLegacyTotalOnPageTwo: true });
    await loginAndGo(page);
    const table = page.getByTestId('customer-table');
    const firstCustomerRow = table.getByRole('row').filter({ has: page.getByText('Customer 1', { exact: true }) });
    await expect(firstCustomerRow).toBeVisible();
    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    const pageTwoRequestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/customer' && request.method() === 'GET' && url.searchParams.get('page') === '2';
    });
    const clampedRequestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/customer' && request.method() === 'GET' && url.searchParams.get('page') === '1';
    });
    await page.getByRole('button', { name: 'Next page' }).click();
    await pageTwoRequestPromise;
    await clampedRequestPromise;

    await expect(firstCustomerRow).toBeVisible();
    await expect(page.getByText('20 customers in this shop', { exact: true })).toBeVisible();
    await expect(table.getByRole('row').filter({ has: page.getByText('Customer 21', { exact: true }) })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
    expect(state.customerListRequests[state.customerListRequests.length - 1]?.page).toBe('1');
    expect(state.unexpected).toEqual([]);
});

test('detail exposes the labelled commerce / risk / orders / timeline sections', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: true });
    await loginAndGo(page, '/customers/cust-1');
    await expect(page.getByTestId('customer-state')).toContainText('Repeat buyer');
    await expect(page.getByTestId('commerce-summary')).toContainText('3,000');
    await expect(page.getByTestId('rto-signal')).toBeVisible();
    await expect(page.getByTestId('customer-orders')).toContainText('#ORD-100');
    await expect(page.getByTestId('customer-timeline')).toBeVisible();
    await expect(page.getByTestId('reply-window')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('legacy create-customer dialog traps focus and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Add Customer' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: cards visible, table hidden, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page, { pilot: true });
    await loginAndGo(page);
    await expect(page.getByTestId('customer-list-mobile')).toBeVisible();
    await expect(page.getByTestId('customer-table')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the customers surface', async ({ page }) => {
    await setupRoutes(page, { pilot: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('customers-tab-all')).toBeVisible();
    await expect(page.getByTestId('customer-row-cust-1')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.em-customers').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
