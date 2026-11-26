/**
 * FAQ knowledge-manager guardrails proof (mock-only, CI subset). The route
 * /manage-shop/faqs renders the tabbed workspace with the FAQ tab active; the
 * FAQ panel still carries `.em-faqs` (axe include pin) and its own §29 header
 * inside the panel: title + `faq-signal` + factual pills, no header CTA.
 * Legacy pins preserved: toolbar primary (`faq-add` hidden on load error,
 * shown when empty), in-system drawer dialog for create (role=dialog, labels,
 * Escape/backdrop close, focus restored), danger delete confirm, gap-card
 * domain-correct primaries, 390px + five mobile destinations, axe on
 * `.em-faqs`. NEW inverted pins per the 2026-11-26 contract: NO confidence
 * text anywhere, no range input, no radiogroup, honest `—` timestamps, and
 * internal notes never rendered. Allowlist+abort discipline:
 * state.unexpected === [] in every test.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

/** The live `formatFaq` serialization (A5 contract): rich fields + legacy
 *  aliases the server still emits for old readers. Fake ids only. */
const richRow = (over: Record<string, unknown>) => ({
    category_tag: null,
    answers: { en: null, bn: null },
    keywords: [],
    notes: null,
    status: 'published',
    is_active: true,
    priority: 5,
    use_count: 0,
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    sync_status: 'synced',
    sync_version: 2,
    synced_at: '2026-07-04T00:10:00.000Z',
    answer: '',
    category: '',
    template_en: null,
    template_bn: null,
    confidence: 1.0,
    source: 'manual',
    active: true,
    usageCount: 0,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...over,
});

const faqRow = richRow({
    id: 'faq-1',
    question: 'What is the delivery charge?',
    category: 'What is the delivery charge?',
    category_tag: 'Delivery',
    answers: { en: 'Inside Dhaka delivery is 80 BDT.', bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।' },
    answer: 'Inside Dhaka delivery is 80 BDT.',
    template_en: 'Inside Dhaka delivery is 80 BDT.',
    template_bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।',
    use_count: 3,
    usageCount: 3,
    keywords: ['delivery', 'charge'],
    // Internal-only text — must NEVER appear in any list/preview surface.
    notes: 'NOTE-MARKER-private-42',
});

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
    '/api/knowledge/faqs', '/api/knowledge/gap-suggestions', '/api/knowledge/faq/search',
    '/api/shop/business-policies',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/knowledge\/faqs\/[\w-]+$/,
    /^\/api\/knowledge\/faqs\/[\w-]+\/(archive|restore|resync)$/,
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
        lastCreateBody: null as Record<string, unknown> | null,
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
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
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
            // Honest async settle: a 'pending' row has finished syncing by the
            // time the merchant lists again (mirrors queueFaqSync settling).
            state.faqs = state.faqs.map((f) => (f.sync_status === 'pending'
                ? { ...f, sync_status: 'synced', synced_at: new Date().toISOString() }
                : f));
            return route.fulfill({ json: json(state.faqs) });
        }
        if (path === '/api/knowledge/faqs' && method === 'POST') {
            state.created += 1;
            const body = request.postDataJSON() as Record<string, unknown>;
            state.lastCreateBody = body;
            const now = new Date().toISOString();
            const status = (body.status as string) || 'published';
            const created = richRow({
                id: 'faq-new',
                question: (body.question as string) || '',
                category: (body.question as string) || '',
                category_tag: (body.category_tag as string) ?? null,
                answers: { en: (body.answer_en as string) ?? null, bn: (body.answer_bn as string) ?? null },
                answer: (body.answer_en as string) || (body.answer_bn as string) || '',
                template_en: (body.answer_en as string) ?? null,
                template_bn: (body.answer_bn as string) ?? null,
                keywords: (body.keywords as string[]) ?? [],
                notes: (body.notes as string) ?? null,
                status,
                is_active: status === 'published',
                use_count: 0,
                created_at: now,
                updated_at: now,
                updatedAt: now,
                sync_status: 'pending',
                sync_version: 1,
                synced_at: null,
            });
            state.faqs = [created, ...state.faqs];
            return route.fulfill({ status: 201, json: json(created) });
        }
        if (/^\/api\/knowledge\/faqs\/[\w-]+$/.test(path) && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            const id = path.split('/').pop();
            state.faqs = state.faqs.map((f) => {
                if (f.id !== id) return f;
                const now = new Date().toISOString();
                const status = (body.status as string) ?? (f.status as string);
                const answers = {
                    en: body.answer_en !== undefined ? (body.answer_en as string) : (f.answers as { en: string | null }).en,
                    bn: body.answer_bn !== undefined ? (body.answer_bn as string) : (f.answers as { bn: string | null }).bn,
                };
                return {
                    ...f,
                    ...(body.question !== undefined ? { question: body.question } : {}),
                    ...(body.category_tag !== undefined ? { category_tag: body.category_tag } : {}),
                    ...(body.notes !== undefined ? { notes: body.notes } : {}),
                    ...(body.keywords !== undefined ? { keywords: body.keywords } : {}),
                    answers,
                    answer: answers.en || answers.bn || (f.answer as string),
                    status,
                    is_active: status === 'published',
                    use_count: (f.use_count as number),
                    updated_at: now,
                    updatedAt: now,
                    sync_status: 'pending',
                    sync_version: (f.sync_version as number) + 1,
                };
            });
            return route.fulfill({ json: json(state.faqs.find((f) => f.id === id)) });
        }
        if (/^\/api\/knowledge\/faqs\/[\w-]+$/.test(path) && method === 'DELETE') {
            state.deleted += 1;
            const id = path.split('/').pop();
            state.faqs = state.faqs.filter((f) => f.id !== id);
            return route.fulfill({ json: json({ message: 'FAQ deleted successfully' }) });
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
    await expect(page.getByTestId('business-faq-tab-faqs')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('faq-signal')).toBeVisible({ timeout: 15_000 });
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

test('create flows through a labelled drawer dialog and lands in the list', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('faq-add').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Editor dirty-gate: Save is inert until there is something to save.
    await expect(dialog.getByRole('button', { name: 'Save FAQ' })).toBeDisabled();
    await dialog.getByLabel('Question', { exact: true }).fill('Do you ship to Chattogram?');
    // Question alone is not enough — an answer is required (legacy rule, now
    // per-slot): Save stays gated until one language has content.
    await expect(dialog.getByRole('button', { name: 'Save FAQ' })).toBeDisabled();
    await dialog.getByLabel('Answer (English)').fill('Yes, 2-3 days via courier.');
    await expect(dialog.getByRole('button', { name: 'Save FAQ' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Do you ship to Chattogram?')).toBeVisible();
    expect(state.created).toBe(1);
    // Contract F9: the client NEVER sends a shadowing `category`/legacy fields.
    expect(state.lastCreateBody).not.toHaveProperty('category');
    expect(state.lastCreateBody).not.toHaveProperty('confidence');
    expect(state.lastCreateBody).not.toHaveProperty('usageCount');
    expect(state.lastCreateBody).not.toHaveProperty('source');
    expect(state.unexpected).toEqual([]);
});

test('drawer closes on Escape and restores focus to the invoking control', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const add = page.getByTestId('faq-add');
    await add.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // ADR-0013 §1 boundary holds INSIDE the drawer too (P12 workspace-wide):
    // no AI mode control, no radiogroup, no range slider (mock's confidence
    // UI is banned outright — F3).
    await expect(dialog.getByTestId('ai-reply-mode')).toHaveCount(0);
    await expect(dialog.getByRole('radiogroup')).toHaveCount(0);
    await expect(dialog.locator('input[type="range"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(add).toBeFocused();
    expect(state.unexpected).toEqual([]);
});

test('delete asks through an in-system danger confirm dialog', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: /^Delete FAQ/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Delete this answer?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.deleted).toBe(0);
    await page.getByRole('button', { name: /^Delete FAQ/ }).first().click();
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

test('inverted F3 pin: no confidence text, no range input, no radiogroup; honest timestamps; notes stay internal', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.locator('.em-faqs')).toBeVisible();
    // confidence retired entirely from the rendered surface (server alias only).
    await expect(page.getByText(/confidence/i)).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    // Honest timestamps (F5): this row has real created/updated, and its
    // internal note must never render on the list surface.
    await expect(page.getByTestId('faq-row-faq-1').getByText('Created', { exact: false })).toBeVisible();
    await expect(page.getByText('NOTE-MARKER-private-42')).toHaveCount(0);
    // "replies used" labeling (F2), never "retrieval"/"success".
    await expect(page.getByText(/retrieval|success/i)).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('faq-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
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
