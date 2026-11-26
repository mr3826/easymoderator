/**
 * FAQ worklist lifecycle proofs (Business & FAQ redesign, A6 battery). Mock
 * server mirrors the LIVE A5 contract wire shapes exactly (formatFaq rich row
 * + legacy aliases; POST/PATCH settle to sync_status 'pending' + version++;
 * transitions use the status machine; restore only archived → disabled;
 * server search is published-only and NEVER matches internal notes). No fake
 * success: every mutation assertion follows the awaited server response, and
 * the async sync settle only ever happens on the NEXT list read.
 *
 * Pinned flows:
 * - create defaults DRAFT with an explicit Syncing (pending) chip
 * - publish transition (draft → published, is_active mirror true)
 * - search (server, published-only, notes-immune) + status/category filters
 *   with accurate per-status counts
 * - bulk enable/disable with affected counts + partial-failure disclosure
 * - archive → restore → disabled
 * - sync-failed row shows failed + retry (resync) settles
 * - edited answer replaces the stale index text (sync_version bump)
 * - internal notes NEVER rendered; no confidence text; honest '—' timestamps
 * Abort discipline: state.unexpected === [] in every test.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

/** Faithful `formatFaq` serialization (A5 contract §FaqRow). */
const richRow = (over: Record<string, unknown>) => {
    const status = (over.status as string) || 'published';
    const answers = (over.answers as { en: string | null; bn: string | null }) || { en: null, bn: null };
    return {
        category_tag: null,
        keywords: [],
        notes: null,
        priority: 5,
        use_count: 0,
        created_at: '2026-07-04T00:00:00.000Z',
        updated_at: '2026-07-04T00:00:00.000Z',
        sync_status: 'synced',
        sync_version: 2,
        synced_at: '2026-07-04T00:10:00.000Z',
        ...over,
        status,
        answers,
        is_active: status === 'published',
        // Legacy alias block (old readers).
        answer: (answers.en as string) || (answers.bn as string) || '',
        category: (over.question as string) || '',
        template_en: answers.en,
        template_bn: answers.bn,
        confidence: 1.0,
        source: 'manual',
        active: status === 'published',
        usageCount: (over.use_count as number) ?? 0,
        createdAt: (over.created_at as string) || '2026-07-04T00:00:00.000Z',
        updatedAt: over.updated_at === null ? null : (over.updated_at as string) || '2026-07-04T00:00:00.000Z',
    };
};

const draftRow = richRow({
    id: 'faq-draft',
    question: 'How long is delivery?',
    category_tag: 'Delivery',
    answers: { en: 'Usually 2-3 days.', bn: 'সাধারণত ২-৩ দিন।' },
    keywords: ['delivery', 'time'],
    notes: 'NOTE-MARKER-worklist — internal reminder',
    status: 'draft',
    sync_status: 'pending',
    sync_version: 1,
    synced_at: null,
    updated_at: '2026-09-01T09:00:00.000Z',
});
const reviewRow = richRow({
    id: 'faq-review',
    question: 'Do you ship gifts?',
    category_tag: 'Ordering',
    answers: { en: 'Yes, with a gift note.', bn: 'হ্যাঁ, উপহার নোটসহ।' },
    status: 'review',
});
const pubRow = richRow({
    id: 'faq-pub',
    question: 'What is the delivery time?',
    category_tag: 'Delivery',
    answers: { en: '2-3 days inside Dhaka.', bn: 'ঢাকার ভেতরে ২-৩ দিন।' },
    status: 'published',
    use_count: 12,
    sync_version: 3,
    updated_at: '2026-08-01T10:00:00.000Z',
});
const syncFailRow = richRow({
    id: 'faq-syncfail',
    question: 'Do you deliver outside Dhaka?',
    answers: { en: 'Yes, courier covers 64 districts.', bn: 'হ্যাঁ, ৬৪ জেলায় কুরিয়ার।' },
    status: 'published',
    sync_status: 'failed',
    sync_version: 4,
    synced_at: null,
    updated_at: '2026-08-02T10:00:00.000Z',
    use_count: 4,
});
const nullUpdatedRow = richRow({
    id: 'faq-nullupdated',
    question: 'Which courier do you use?',
    category_tag: 'Shipping',
    answers: { en: 'Pathao and Steadfast.', bn: 'পাঠাও ও স্টেডফাস্ট।' },
    status: 'published',
    updated_at: null,
    synced_at: '2026-07-05T00:00:00.000Z',
});
const disabledRow = richRow({
    id: 'faq-disabled',
    question: 'Is Cash on Delivery available?',
    answers: { en: 'Yes on orders under ৳10,000.', bn: 'হ্যাঁ, ৳১০,০০০-এর কম অর্ডারে।' },
    status: 'disabled',
});
const archivedRow = richRow({
    id: 'faq-arch',
    question: 'Old pricing question',
    category_tag: 'Ordering',
    answers: { en: 'Replaced by current pricing.', bn: 'বর্তমান মূল্যে প্রতিস্থাপিত।' },
    status: 'archived',
});
const longRow = richRow({
    id: 'faq-long',
    question: 'If I order a stitched salwar suit with extra fabric and request same-day dispatch together with exchange of a previously delivered item, will everything ship in one parcel or separately across multiple courier legs?',
    category_tag: 'Return & Exchange Policy Window For Stitched Items',
    answers: { en: 'Separate parcels — exchange and dispatch run independently.', bn: 'আলাদা পার্সেল।' },
    keywords: ['stitched', 'same-day', 'exchange', 'parcel'],
    status: 'published',
});

interface Options {
    withGaps?: boolean;
    extraRows?: Record<string, unknown>[];
    failPatchIds?: string[];
    putPoliciesFails?: boolean;
    initialPolicies?: Record<string, unknown>;
}

async function setupRoutes(page: Page, options: Options = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        created: 0,
        lastCreateBody: null as Record<string, unknown> | null,
        searchCalls: 0,
        lastSearchBody: null as Record<string, unknown> | null,
        resyncCalls: 0,
        archiveCalls: 0,
        restoreCalls: 0,
        patchBodies: [] as Record<string, unknown>[],
        lastPatchVersion: 0,
        listCalls: 0,
        faqs: [draftRow, reviewRow, pubRow, syncFailRow, nullUpdatedRow, disabledRow, archivedRow, ...(options.extraRows ?? [])].map(richRow) as Record<string, unknown>[],
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known =
            ['/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
                '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
                '/api/knowledge/faqs', '/api/knowledge/gap-suggestions', '/api/knowledge/faq/search', '/api/shop/business-policies',
                '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta', '/api/shop/business-info', '/api/shop/list']
                .includes(path) ||
            /^\/api\/knowledge\/faqs\/[\w-]+$/.test(path) ||
            /^\/api\/knowledge\/faqs\/[\w-]+\/(archive|restore|resync)$/.test(path) ||
            /^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss|publish)$/.test(path);
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } } });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } } });
        }
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: { success: true, data: [] } });
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
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/knowledge/gap-suggestions' && method === 'GET') {
            if (!options.withGaps) return route.fulfill({ status: 409, json: { success: false, error: { code: 'FEATURE_DISABLED' } } });
            return route.fulfill({ json: json([]) });
        }
        if (path === '/api/shop/business-info' && method === 'GET') {
            return route.fulfill({ json: json({ businessInfo: { shopName: 'My BD Shop' }, shop: mockShop }) });
        }
        if (path === '/api/shop/list') return route.fulfill({ json: json([mockShop]) });

        // ── FAQ endpoints ─────────────────────────────────────────────────────
        if (path === '/api/knowledge/faqs' && method === 'GET') {
            state.listCalls += 1;
            // Honest settle: a 'pending' row has finished its fire-and-forget
            // sync by the time the merchant lists again (mirrors queueFaqSync).
            state.faqs = state.faqs.map((f) => (f.sync_status === 'pending'
                ? { ...f, sync_status: 'synced', synced_at: new Date().toISOString() }
                : f));
            return route.fulfill({ json: json(state.faqs) });
        }
        if (path === '/api/knowledge/faqs' && method === 'POST') {
            state.created += 1;
            const body = request.postDataJSON() as Record<string, unknown>;
            state.lastCreateBody = body;
            // Server rule (A5): create starts at the requested status (the UI
            // sends 'draft'), sync_status 'pending', sync_version 1.
            const status = (body.status as string) || 'published';
            const answers = { en: (body.answer_en as string) ?? null, bn: (body.answer_bn as string) ?? null };
            const now = new Date().toISOString();
            const created = richRow({
                id: 'faq-new',
                question: (body.question as string) || '',
                category_tag: (body.category_tag as string) ?? null,
                answers,
                keywords: (body.keywords as string[]) ?? [],
                notes: (body.notes as string) ?? null,
                status,
                created_at: now,
                updated_at: now,
                sync_status: 'pending',
                sync_version: 1,
                synced_at: null,
                priority: (body.priority as number) ?? 0,
            });
            state.faqs = [created, ...state.faqs];
            return route.fulfill({ status: 201, json: json(created) });
        }
        // POST /faq/search — published-only, never matches internal_notes;
        // projections drop keywords + notes (FaqProjection shape).
        if (path === '/api/knowledge/faq/search' && method === 'POST') {
            state.searchCalls += 1;
            state.lastSearchBody = request.postDataJSON() as Record<string, unknown>;
            const q = String(state.lastSearchBody?.query ?? '').toLowerCase();
            const hits = state.faqs
                .filter((f) => f.status === 'published')
                .filter((f) => {
                    const hay = [f.question, f.category, (f.answers as Record<string, string | null>)?.en, (f.answers as Record<string, string | null>)?.bn]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase();
                    // keywords are matchable server-side but NEVER notes.
                    return hay.includes(q) || ((f.keywords as string[]) || []).some((k) => String(k).toLowerCase().includes(q));
                })
                .map((f) => {
                    const { keywords: _k, notes: _n, ...projection } = f;
                    return { ...projection, relevance_score: 0.9 };
                });
            return route.fulfill({ json: { success: true, data: hits, total: hits.length } });
        }
        const idMatch = path.match(/^\/api\/knowledge\/faqs\/([\w-]+)$/);
        if (idMatch && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.patchBodies.push(body);
            const id = idMatch[1];
            const row = state.faqs.find((f) => f.id === id);
            if (!row) return route.fulfill({ status: 404, json: { success: false, message: 'FAQ not found', code: 'NOT_FOUND' } });
            if (options.failPatchIds?.includes(id)) {
                return route.fulfill({ status: 500, json: { success: false, message: 'Knowledge service unavailable', code: 'SERVER_ERROR' } });
            }
            // Status machine (LIVE): reject transitions outside the table.
            const from = row.status as string;
            if (body.status !== undefined && body.status !== from) {
                const allowed: Record<string, string[]> = {
                    draft: ['review', 'published', 'archived'],
                    review: ['draft', 'published', 'archived'],
                    published: ['disabled', 'archived'],
                    disabled: ['published', 'archived'],
                    archived: ['disabled'],
                };
                if (!allowed[from]?.includes(body.status as string)) {
                    return route.fulfill({
                        status: 409,
                        json: { success: false, code: 'INVALID_STATUS_TRANSITION', message: `FAQ status cannot change from ${from} to ${body.status}`, details: { from, to: body.status, allowed: allowed[from] } },
                    });
                }
            }
            const now = new Date().toISOString();
            const status = (body.status as string) ?? from;
            const prevAnswers = row.answers as { en: string | null; bn: string | null };
            const answers = {
                en: body.answer_en !== undefined ? (body.answer_en as string) : prevAnswers?.en ?? null,
                bn: body.answer_bn !== undefined ? (body.answer_bn as string) : prevAnswers?.bn ?? null,
            };
            const updated = richRow({
                ...row,
                ...(body.question !== undefined ? { question: body.question } : {}),
                ...(body.category_tag !== undefined ? { category_tag: body.category_tag } : {}),
                ...(body.notes !== undefined ? { notes: body.notes } : {}),
                ...(body.keywords !== undefined ? { keywords: body.keywords } : {}),
                ...(body.priority !== undefined ? { priority: body.priority } : {}),
                answers,
                status,
                updated_at: now,
                sync_status: 'pending',
                sync_version: (row.sync_version as number) + 1,
            });
            state.lastPatchVersion = updated.sync_version as number;
            state.faqs = state.faqs.map((f) => (f.id === id ? updated : f));
            return route.fulfill({ json: json(updated) });
        }
        if (idMatch && method === 'DELETE') {
            state.faqs = state.faqs.filter((f) => f.id !== idMatch[1]);
            return route.fulfill({ json: json({ message: 'FAQ deleted successfully' }) });
        }
        const transMatch = path.match(/^\/api\/knowledge\/faqs\/([\w-]+)\/(archive|restore|resync)$/);
        if (transMatch && method === 'POST') {
            const id = transMatch[1];
            const action = transMatch[2];
            const row = state.faqs.find((f) => f.id === id);
            if (!row) return route.fulfill({ status: 404, json: { success: false, message: 'FAQ not found' } });
            if (action === 'archive') {
                state.archiveCalls += 1;
                const now = new Date().toISOString();
                const updated = richRow({ ...row, status: 'archived', updated_at: now, sync_status: 'pending', sync_version: (row.sync_version as number) + 1 });
                state.faqs = state.faqs.map((f) => (f.id === id ? updated : f));
                return route.fulfill({ json: json(updated) });
            }
            if (action === 'restore') {
                state.restoreCalls += 1;
                if (row.status === 'disabled') return route.fulfill({ json: json(row) }); // idempotent no-op
                if (row.status !== 'archived') {
                    return route.fulfill({ status: 409, json: { success: false, code: 'INVALID_STATUS_TRANSITION', message: 'Only archived FAQs can be restored', details: { reason: 'restore applies to archived FAQs only' } } });
                }
                const now = new Date().toISOString();
                const updated = richRow({ ...row, status: 'disabled', updated_at: now, sync_status: 'pending', sync_version: (row.sync_version as number) + 1 });
                state.faqs = state.faqs.map((f) => (f.id === id ? updated : f));
                return route.fulfill({ json: json(updated) });
            }
            // resync: pending + version++, updated_at NOT bumped (not content).
            state.resyncCalls += 1;
            const updated = richRow({ ...row, sync_status: 'pending', sync_version: (row.sync_version as number) + 1 });
            state.faqs = state.faqs.map((f) => (f.id === id ? updated : f));
            return route.fulfill({ json: json(updated) });
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
    await expect(page.getByTestId('faq-signal')).toBeVisible({ timeout: 15_000 });
}

const rowChip = (page: Page, id: string) => page.getByTestId(`faq-status-chip-${id}`);
const syncChip = (page: Page, id: string) => page.getByTestId(`faq-sync-chip-${id}`);

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('create lands as DRAFT with a pending sync chip — saved ≠ live for AI', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('faq-add').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Question', { exact: true }).fill('Do you take advance payment?');
    await dialog.getByLabel('Answer (English)').fill('50% advance on custom orders.');
    await dialog.getByLabel('Internal notes').fill('NOTE-MARKER-create never customer-visible');
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.created).toBe(1);
    // Contract: the editor defaults new FAQs to DRAFT — creating must not
    // silently make a row AI-eligible.
    expect(state.lastCreateBody?.status).toBe('draft');
    expect(state.lastCreateBody).not.toHaveProperty('category');
    expect(state.lastCreateBody).not.toHaveProperty('confidence');
    // Server-confirmed row: Draft lifecycle chip + Syncing (pending) sync chip.
    await expect(rowChip(page, 'faq-new')).toHaveText('Draft');
    await expect(syncChip(page, 'faq-new')).toHaveText('Syncing');
    // Honest toast: "Saved — syncing", never "live".
    await expect(page.getByText('Saved — syncing to AI knowledge')).toBeVisible();
    // Internal notes never render on the list surface.
    await expect(page.getByText('NOTE-MARKER-create never customer-visible')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('publish transitions draft → published with the is_active mirror', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(rowChip(page, 'faq-draft')).toHaveText('Draft');
    await page.getByRole('button', { name: /^Publish: How long is delivery\?/ }).click();
    await expect(rowChip(page, 'faq-draft')).toHaveText('Published');
    expect(state.patchBodies.at(-1)).toEqual({ status: 'published' });
    const stored = state.faqs.find((f) => f.id === 'faq-draft') as Record<string, unknown>;
    expect(stored.is_active).toBe(true); // mirror rule on every write
    await expect(page.getByText('FAQ published')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('server search is published-only, immune to internal notes; filters carry accurate counts', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    // Accurate per-status chips (draft row counts as draft, archived excluded
    // from "All").
    await expect(page.getByTestId('faq-filter-all')).toContainText('(6)');
    await expect(page.getByTestId('faq-filter-draft')).toContainText('(1)');
    await expect(page.getByTestId('faq-filter-review')).toContainText('(1)');
    await expect(page.getByTestId('faq-filter-published')).toContainText('(3)');
    await expect(page.getByTestId('faq-filter-disabled')).toContainText('(1)');
    await expect(page.getByTestId('faq-filter-archived')).toContainText('(1)');

    // The draft's INTERNAL NOTE mentions "worklist" — searching that term must
    // return nothing (published-only AND notes never matchable).
    await page.getByTestId('faq-search').fill('worklist');
    await expect.poll(() => state.searchCalls).toBe(1);
    await expect(page.getByText('No FAQs match these filters')).toBeVisible();
    expect(state.lastSearchBody?.query).toBe('worklist');

    // "deliver" hits two PUBLISHED rows but not the draft whose question also
    // contains it (server search is published-only).
    await page.getByTestId('faq-search').fill('deliver');
    await expect.poll(() => state.searchCalls).toBe(2);
    await expect(page.getByTestId('faq-row-faq-pub')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-syncfail')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-draft')).toHaveCount(0);
    // notes/keywords never appear on search result chips either (projections)
    // — keyword chips only render for loaded rows whose keywords survived.

    // Clear search → client view returns.
    await page.getByTestId('faq-search').fill('');
    await expect(page.getByTestId('faq-row-faq-draft')).toBeVisible();

    // Category filter incl. Uncategorized.
    await page.getByTestId('faq-filter-category').selectOption('Shipping');
    await expect(page.getByTestId('faq-row-faq-nullupdated')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-pub')).toHaveCount(0);
    await page.getByTestId('faq-filter-category').selectOption('__uncategorized__');
    await expect(page.getByTestId('faq-row-faq-syncfail')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-disabled')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-pub')).toHaveCount(0);
    await page.getByTestId('faq-filter-category').selectOption('all');

    // Status filter: archived only, with the restore affordance.
    await page.getByTestId('faq-filter-archived').click();
    await expect(page.getByTestId('faq-row-faq-arch')).toBeVisible();
    await expect(page.getByTestId('faq-restore-faq-arch')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-pub')).toHaveCount(0);
    await page.getByTestId('faq-filter-all').click();
    // Archived leaves the default list.
    await expect(page.getByTestId('faq-row-faq-arch')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('bulk enable/disable: affected counts first, server reload after, partial failure disclosed', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    // Select disabled + review (both enable-able to published) and one
    // published (only disable-able) → counts must be affected-subset aware.
    await page.getByLabel(/Select: Is Cash on Delivery available\?/).check();
    await page.getByLabel(/Select: Do you ship gifts\?/).check();
    await expect(page.getByTestId('faq-bulk-bar')).toBeVisible();
    await expect(page.getByTestId('faq-bulk-enable')).toContainText('(2)');
    await expect(page.getByTestId('faq-bulk-disable')).toContainText('(0)');
    await expect(page.getByTestId('faq-bulk-disable')).toBeDisabled();
    await page.getByTestId('faq-bulk-enable').click();
    await expect(page.getByRole('status')).toContainText('Publish 2 selected FAQs for AI replies?');
    await page.getByTestId('faq-bulk-confirm').click();
    await expect(page.getByText('2 FAQs updated')).toBeVisible();
    // Server-confirmed: the list was re-read, selection cleared.
    await expect(page.getByTestId('faq-bulk-bar')).toHaveCount(0);
    await expect(rowChip(page, 'faq-disabled')).toHaveText('Published');
    await expect(rowChip(page, 'faq-review')).toHaveText('Published');
    expect(state.unexpected).toEqual([]);
});

test('bulk partial failure names both sides — no blanket success claim', async ({ page }) => {
    const state = await setupRoutes(page, { failPatchIds: ['faq-syncfail'] });
    await loginAndGo(page);
    await page.getByLabel(/Select: What is the delivery time\?/).check();
    await page.getByLabel(/Select: Do you deliver outside Dhaka\?/).check();
    await expect(page.getByTestId('faq-bulk-disable')).toContainText('(2)');
    await page.getByTestId('faq-bulk-disable').click();
    await page.getByTestId('faq-bulk-confirm').click();
    await expect(page.getByText('1 updated, 1 failed')).toBeVisible();
    await expect(page.getByText('2 FAQs updated')).toHaveCount(0);
    // The failed row keeps its server truth (still published) after the reload;
    // the successful one moved to disabled.
    await expect(rowChip(page, 'faq-syncfail')).toHaveText('Published');
    await expect(rowChip(page, 'faq-pub')).toHaveText('Disabled');
    expect(state.unexpected).toEqual([]);
});

test('archive leaves the default list; restore returns the row as disabled', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('faq-archive-faq-nullupdated').click();
    await expect.poll(() => state.archiveCalls).toBe(1);
    await expect(page.getByTestId('faq-row-faq-nullupdated')).toHaveCount(0);
    await expect(page.getByText('FAQ archived')).toBeVisible();
    await page.getByTestId('faq-filter-archived').click();
    await expect(rowChip(page, 'faq-nullupdated')).toHaveText('Archived');
    await page.getByTestId('faq-restore-faq-nullupdated').click();
    await expect.poll(() => state.restoreCalls).toBe(1);
    await expect(page.getByText('FAQ restored as disabled')).toBeVisible();
    await page.getByTestId('faq-filter-disabled').click();
    await expect(rowChip(page, 'faq-nullupdated')).toHaveText('Disabled');
    // Restore lands on disabled — never silently republishes.
    const stored = state.faqs.find((f) => f.id === 'faq-nullupdated') as Record<string, unknown>;
    expect(stored.status).toBe('disabled');
    expect(stored.is_active).toBe(false);
    expect(state.unexpected).toEqual([]);
});

test('sync-failed row shows failed and retry (owner resync) settles to synced', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(syncChip(page, 'faq-syncfail')).toHaveText('Sync failed');
    await expect(page.getByTestId('faq-resync-faq-syncfail')).toBeVisible();
    await page.getByTestId('faq-resync-faq-syncfail').click();
    await expect.poll(() => state.resyncCalls).toBe(1);
    // Response = SAVED for resync purposes: pending + version++ (5), honest
    // updated_at untouched (resync is not a content edit).
    const afterResync = state.faqs.find((f) => f.id === 'faq-syncfail') as Record<string, unknown>;
    expect(afterResync.sync_status).toBe('pending');
    expect(afterResync.sync_version).toBe(5);
    expect(afterResync.updated_at).toBe('2026-08-02T10:00:00.000Z');
    await expect(syncChip(page, 'faq-syncfail')).toHaveText('Syncing');
    await expect(page.getByTestId('faq-resync-faq-syncfail')).toHaveCount(0);
    await expect(page.getByText('Sync retry started')).toBeVisible();
    // The fire-and-forget sync settles between reads → next list shows synced.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(syncChip(page, 'faq-syncfail')).toHaveText('Synced');
    expect(state.unexpected).toEqual([]);
});

test('editing an answer replaces the stale row text and bumps sync_version', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const before = state.faqs.find((f) => f.id === 'faq-pub') as Record<string, unknown>;
    expect(before.sync_version).toBe(3);
    await page.getByRole('button', { name: /^Edit FAQ: What is the delivery time\?/ }).click();
    const dialog = page.getByRole('dialog');
    // Edit BOTH language slots (the row preview is bn-first, 02 §2).
    await dialog.getByLabel('Answer (English)').fill('48 hours now — updated answer.');
    await dialog.getByLabel('Answer (Bangla)').fill('এখন ৪৮ ঘণ্টা — হালনাগাদ।');
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(dialog).toHaveCount(0);
    // PATCH body: only changed fields — the untouched status never rides,
    // and the shadowing legacy keys are structurally absent (F9/F3).
    const body = state.patchBodies.at(-1) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['answer_bn', 'answer_en']);
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('category');
    expect(body).not.toHaveProperty('confidence');
    expect(body).not.toHaveProperty('usageCount');
    expect(state.lastPatchVersion).toBe(4); // stale index replaced, version bumped
    await expect(page.getByTestId('faq-row-faq-pub')).toContainText('এখন ৪৮ ঘণ্টা — হালনাগাদ।');
    await expect(syncChip(page, 'faq-pub')).toHaveText('Syncing');
    await expect(page.getByText('Saved — syncing to AI knowledge')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('honest timestamps: never-edited rows show an em dash, no relative-time lies', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('faq-row-faq-nullupdated')).toContainText('Updated —');
    await expect(page.getByTestId('faq-row-faq-nullupdated')).toContainText('Created');
    await expect(page.getByText(/ago|just now/i)).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('360px worklist: long question rows, chips and bulk bar reflow without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const state = await setupRoutes(page, { extraRows: [longRow] });
    await loginAndGo(page);
    await expect(page.getByTestId('faq-row-faq-long')).toBeVisible();
    await expect(page.getByTestId('faq-row-faq-long')).toContainText('If I order a stitched salwar suit');
    // Chips wrap (long category tag must not push a horizontal scrollbar).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Bulk bar at 360 still fits.
    await page.getByLabel(/Select: Which courier do you use\?/).check();
    await expect(page.getByTestId('faq-bulk-bar')).toBeVisible();
    const overflowBulk = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowBulk).toBeLessThanOrEqual(0);
    expect(state.unexpected).toEqual([]);
});

test('axe: open editor drawer inside the FAQ surface has no critical/serious violations', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await page.getByTestId('faq-add').click();
    await expect(page.getByTestId('faq-editor-drawer')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-faqs').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
    expect(state.unexpected).toEqual([]);
});
