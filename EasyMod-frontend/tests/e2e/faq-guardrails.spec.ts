/**
 * FAQ knowledge-manager guardrails proof (mock-only, CI subset). Execution
 * page (§29): title + signal + pills header, work-area toolbar primary,
 * in-system dialogs for create/delete, gap-card domain-correct primaries.
 * Allowlist+abort discipline: a redesign that invents backend calls fails here.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const faqRow = {
    id: 'faq-1',
    question: 'What is the delivery charge?',
    answer: 'Inside Dhaka delivery is 80 BDT.',
    category: 'Delivery',
    confidence: 1,
    source: 'manual',
    active: true,
    usage_count: 3,
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
};

const gaps = [
    {
        id: 'gap-pay-1', display_question: 'How do I pay with bKash?', owner_domain: 'PAYMENT',
        status: 'OPEN', evidence_count: 7, first_seen_at: '2026-10-01T00:00:00Z', last_seen_at: '2026-10-24T00:00:00Z',
        resolved_faq_id: null, published_at: null, authoritative_action: 'open_payment_settings',
    },
    {
        id: 'gap-pol-1', display_question: 'Can I return a dress if it does not fit?', owner_domain: 'POLICY',
        status: 'OPEN', evidence_count: 3, first_seen_at: '2026-10-01T00:00:00Z', last_seen_at: '2026-10-24T00:00:00Z',
        resolved_faq_id: null, published_at: null, authoritative_action: 'author_faq',
    },
];

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/knowledge/faqs', '/api/knowledge/gap-suggestions',
]);
const KNOWN_PATTERNS = [
    /^\/api\/knowledge\/faqs\/[\w-]+$/,
    /^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss|publish)$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { withGaps?: boolean } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        created: 0,
        deleted: 0,
        published: 0,
        faqs: [faqRow],
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
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
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
            const registryHash = `sha256:${'a'.repeat(64)}`;
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/knowledge/gap-suggestions' && method === 'GET') {
            if (!options.withGaps) return route.fulfill({ status: 409, json: { success: false, error: { code: 'FEATURE_DISABLED' } } });
            return route.fulfill({ json: json(gaps) });
        }
        if (/^\/api\/knowledge\/gap-suggestions\/[\w-]+\/publish$/.test(path) && method === 'POST') {
            state.published += 1;
            return route.fulfill({ json: json({ faq_id: 'faq-9', status: 'PUBLISHED' }) });
        }
        if (/^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss)$/.test(path) && method === 'POST') {
            return route.fulfill({ json: json({ status: 'IN_REVIEW' }) });
        }
        if (path === '/api/knowledge/faqs' && method === 'GET') {
            return route.fulfill({ json: json(state.faqs) });
        }
        if (path === '/api/knowledge/faqs' && method === 'POST') {
            state.created += 1;
            const body = request.postDataJSON() as Record<string, unknown>;
            const created = { ...faqRow, ...body, id: 'faq-new' };
            state.faqs = [created, ...state.faqs];
            return route.fulfill({ status: 201, json: json(created) });
        }
        if (/^\/api\/knowledge\/faqs\/[\w-]+$/.test(path) && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.faqs = state.faqs.map((f) => (f.id === path.split('/').pop() ? { ...f, ...body } : f));
            return route.fulfill({ json: json(state.faqs.find((f) => f.id === path.split('/').pop())) });
        }
        if (/^\/api\/knowledge\/faqs\/[\w-]+$/.test(path) && method === 'DELETE') {
            state.deleted += 1;
            state.faqs = state.faqs.filter((f) => f.id !== path.split('/').pop());
            return route.fulfill({ json: json({ message: 'deleted' }) });
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
    await page.goto('/manage-shop/faqs');
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + signal + pills, no header CTA; toolbar holds the primary', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'FAQs', level: 1 })).toBeVisible();
    const signal = page.getByTestId('faq-signal');
    await expect(signal).toContainText('Knowledge ready');
    await expect(page.getByTestId('faq-add')).toHaveCount(1);
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByTestId('inbox-primary-action')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('create flows through a labelled dialog and lands in the list', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('faq-add').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Question', { exact: true }).fill('Do you ship to Chattogram?');
    await dialog.getByLabel('Answer', { exact: true }).fill('Yes, 2-3 days via courier.');
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Do you ship to Chattogram?')).toBeVisible();
    expect(state.created).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('delete asks through an in-system danger confirm dialog', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Delete FAQ' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Delete this answer?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.deleted).toBe(0);
    await page.getByRole('button', { name: 'Delete FAQ' }).click();
    await page.getByTestId('faq-delete-confirm').click();
    await expect(page.getByText('What is the delivery charge?')).toHaveCount(0);
    expect(state.deleted).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('gap cards keep domain-correct primaries and publish through the FAQ authority', async ({ page }) => {
    const state = await setupRoutes(page, { withGaps: true });
    await loginAndGo(page);
    await expect(page.getByTestId('gap-suggestions')).toBeVisible();
    await expect(page.getByTestId('gap-suggestion-gap-pay-1').getByTestId('gap-open-settings')).toBeVisible();
    const policyCard = page.getByTestId('gap-suggestion-gap-pol-1');
    await policyCard.getByRole('button', { name: /Write answer/i }).click();
    const answerBox = page.locator('textarea').last();
    await answerBox.fill('7-day exchange on unused items with original packaging.');
    await policyCard.getByTestId('gap-publish').click();
    await expect(policyCard).toHaveCount(0);
    expect(state.published).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and six mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('faq-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the FAQ surface', async ({ page }) => {
    await setupRoutes(page, { withGaps: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('faq-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-faqs').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
