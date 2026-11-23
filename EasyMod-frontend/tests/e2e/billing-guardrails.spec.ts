/**
 * Billing guardrails proof (mock-only, CI subset). Execution-class billing page
 * (§29): signal header + factual pills, the frozen delivered-order contract
 * (fail-closed price), invoices table with on-demand billing lines, the bKash
 * opt-in gate, 390px no-overflow, axe `.em-billing`. Claims are mocked with an
 * empty decision set (fail-closed) exactly as order-management does, so this
 * spec never depends on claim-registry copy.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const INVOICE_ID = '0f9b5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const invoices = [
    {
        id: INVOICE_ID, invoice_number: 'INV-1', billing_period: '2026-11', amount: 20,
        status: 'pending', invoice_type: 'delivered_order', created_at: '2026-11-14T00:00:00.000Z',
    },
];
const lines = [
    {
        id: 'line-1', invoiceId: INVOICE_ID, orderId: 'order-1', lineKind: 'DELIVERED_ORDER',
        outcome: 'DELIVERED', unitPriceMinor: 1000, amountMinor: 1000, currency: 'BDT',
        contractVersion: '1.0.0', createdAt: '2026-11-14T00:00:00.000Z',
    },
];

const CONTRACT = {
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
        blockCourierBooking: true, pauseAutomatedAi: true, keepInboxReadable: true,
        keepHistoryReadable: true, deleteData: false,
    },
    description: { en: 'Pay BDT 10.00 per provider-confirmed delivered order.', bn: 'প্রতি ডেলিভারি অর্ডারে ৳১০.০০।' },
    registry_hash: `sha256:${'a'.repeat(64)}`,
    // The fail-closed validator rejects an empty claims array; one descriptor is
    // the minimum valid payload (decisions may legitimately be empty).
    claims: [
        {
            id: 'billing.delivered_order',
            verified_scope: 'global',
            surfaces: ['pricing', 'subscription', 'landing'],
            i18n_key: { en: 'claims.billing.delivered_order.en', bn: 'claims.billing.delivered_order.bn' },
            fallback_i18n_key: null,
        },
    ],
    decisions: [],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/subscription/invoices', '/api/notifications/in-app',
    '/api/notifications/telegram', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/commercial/billing-lines', '/api/order', '/api/product',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

// A period whose usage the invoice job has already frozen into metadata. The
// default fixture deliberately has none, so the fail-closed empty state is what
// the original assertions see.
const usageInvoices = [
    {
        id: INVOICE_ID, invoice_number: 'INV-2', billing_period: '2026-10', amount: 640,
        status: 'pending', invoice_type: 'delivered_order', created_at: '2026-11-01T00:00:00.000Z',
        billing_period_start: '2026-10-01T00:00:00.000Z',
        billing_period_end: '2026-11-01T00:00:00.000Z',
        due_date: '2026-11-08T12:00:00.000Z',
        metadata: {
            deliveredCount: 64, zeroRatedCount: 9, grossMinor: 64000, creditMinor: 0, netMinor: 64000,
            lines: [{ orderId: 'order-1', kind: 'billable', outcome: 'DELIVERED', amountMinor: 1000, occurredAt: '2026-10-12' }],
        },
    },
];

async function setupRoutes(page: Page, opts: { withUsage?: boolean } = {}) {
    const state = { signedIn: false, unexpected: [] as string[], linesQueries: [] as string[] };
    const invoiceRows = opts.withUsage ? usageInvoices : invoices;
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
        if (path === '/api/subscription/invoices') return route.fulfill({ json: json(invoiceRows) });
        if (path === '/api/commercial/billing-lines') {
            state.linesQueries.push(url.searchParams.get('invoiceId') ?? '');
            return route.fulfill({ json: json({ invoiceId: INVOICE_ID, contractVersion: '1.0.0', lines }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/notifications/telegram') return route.fulfill({ json: json({ connected: false }) });
        if (path === '/api/order') return route.fulfill({ json: json([]) });
        if (path === '/api/product') return route.fulfill({ json: json([]) });
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json(CONTRACT) });
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
    await page.goto('/subscription');
    await expect(page.getByTestId('billing-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + billing signal + pills, and the frozen contract price', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await expect(page.getByTestId('billing-signal')).toContainText('Invoice due');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText('৳10.00')).toBeVisible();
    await expect(page.getByText('Contract version 1.0.0')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('invoices load their billing lines only on demand, scoped to the invoice', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('cell', { name: 'INV-1' })).toBeVisible();
    expect(state.linesQueries).toEqual([]);
    await page.getByRole('button', { name: /billing lines/i }).click();
    await expect.poll(() => state.linesQueries.length).toBe(1);
    expect(state.linesQueries[0]).toBe(INVOICE_ID);
    await expect(page.getByRole('cell', { name: 'order-1' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'DELIVERED_ORDER' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('bKash stays opt-in: the pay action is disabled with an honest reason', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const pay = page.getByRole('button', { name: /bKash payment is not available right now/i }).first();
    await expect(pay).toBeDisabled();
    await expect(page.getByText('bKash payment is not available right now.').first()).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('usage is read from the invoices already fetched — no extra request', async ({ page }) => {
    const state = await setupRoutes(page, { withUsage: true });
    await loginAndGo(page);
    await expect(page.getByText('Delivered orders billed')).toBeVisible();
    await expect(page.getByText(/Delivered billed: 64/)).toBeVisible();
    await expect(page.getByText(/1 Oct – 31 Oct/)).toBeVisible();
    await expect(page.getByText(/64 delivered · 9 zero-rated/)).toBeVisible();
    await expect(page.getByText(/Due 8 Nov 2026/)).toBeVisible();
    // Still strictly on demand: the usage panel must not prefetch any lines.
    expect(state.linesQueries).toEqual([]);
    await page.getByRole('button', { name: /billing lines/i }).click();
    await expect.poll(() => state.linesQueries.length).toBe(1);
    await expect(page.getByRole('columnheader', { name: 'Outcome date' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '12 Oct 2026' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal page overflow on the billing surface', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

// A6 G-UX09/G-UX09b additions (the 390px pin above is unchanged).
test('360px: no horizontal page overflow on the billing surface', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setupRoutes(page);
    await loginAndGo(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('200% zoom-equivalent (1280×1024 content at 640 CSS px): billing reflows with no page overflow', async ({ page }) => {
    // Same faithful emulation as the other A6 specs: 200% of a 1280×1024
    // window is a 640×512 CSS viewport with media queries re-evaluated
    // (CSS `zoom` alone would keep the desktop layout and hallucinate
    // overflow). The frozen contract price must remain visible.
    await page.setViewportSize({ width: 640, height: 512 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByText('৳10.00')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the billing surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-billing').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
