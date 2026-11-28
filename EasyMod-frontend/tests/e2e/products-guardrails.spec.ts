/**
 * Products-catalog guardrails proof (mock-only, CI subset). Execution-class
 * worklist: server overview/coverage, stock filters, full-page add/edit routes,
 * image/variant read-only surfaces, upload dialog focus trap + Escape, category
 * impact counts, 390px no-overflow, axe `.em-products`.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const products = [
    { id: 'prod-1', name: 'Demo Hoodie', price: 1299, description: 'Comfort fit demo product', category: 'Apparel', sku: 'HD-1', status: 'active', is_active: true, quantity: 12, track_quantity: true, low_stock_threshold: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

const productForDetail = {
    ...products[0],
    category_id: 'cat-1',
    sku: 'HD-1',
    brand: 'North',
    tags: ['Featured'],
    images: ['https://example.com/hoodie.png'],
    image_url: 'https://example.com/hoodie.png',
    variants: [],
    product_variants: [
        { id: 'variant-1', option_name: 'Size', option_value: 'M', quantity: 4, is_active: true },
    ],
};

type CategoryFixture = {
    id: string;
    name: string;
    description?: string;
    is_active?: boolean;
    product_count?: number;
    affected_product_count?: number;
    subcategory_count?: number;
    subcategories?: CategoryFixture[];
};

const categoryFixture: CategoryFixture[] = [
    {
        id: 'cat-1', name: 'Apparel', is_active: true, product_count: 3,
        affected_product_count: 6, subcategory_count: 1,
        subcategories: [{ id: 'sub-1', name: 'Shirts', is_active: true, product_count: 2, affected_product_count: 4 }],
    },
];

// D2 fixtures for the stock-filter proofs: low (0 < 3 ≤ threshold 5) and
// out (0 ≤ 0) — disjoint by construction. The header/signal proofs keep their
// original single-product fixture so their "Catalog ready" pin stays valid.
const stockProducts = [
    ...products,
    { id: 'prod-2', name: 'Low Tee', price: 599, description: 'Basic tee', category: 'Apparel', sku: 'LT-1', status: 'active', is_active: true, quantity: 3, track_quantity: true, low_stock_threshold: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'prod-3', name: 'Out Cap', price: 450, description: 'Cap', category: 'Apparel', sku: 'OC-1', status: 'active', is_active: true, quantity: 0, track_quantity: true, low_stock_threshold: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

// A8 MAJOR-1 fixture: a RETIRED but still-tracked zero-stock product. The
// server exception scan is `is_active: true` — this row belongs in neither
// the exception count (badge) nor the ?stock= filter (list).
const retiredStockProducts = [
    ...stockProducts,
    { id: 'prod-4', name: 'Retired Cap', price: 350, description: 'Retired line', category: 'Apparel', sku: 'RC-1', status: 'inactive', is_active: false, quantity: 0, track_quantity: true, low_stock_threshold: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

interface StockExceptionPayload {
    outOfStock: number;
    lowStock: number;
    exceptions: number;
    coverageComplete: boolean;
}
const stockExceptionPayload = (fx?: Partial<StockExceptionPayload>) => ({
    outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true,
    generated_at: '2026-01-01T00:00:00.000Z', ...fx,
});

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/notifications/in-app', '/api/product',
    '/api/product/overview', '/api/category', '/api/order', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/product/images',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/product\/[\w-]+$/,
    /^\/api\/category\/[\w-]+$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

interface ProductRouteOptions {
    overview?: Partial<{ total: number; active: number; inactive: number; low_stock: number; out_of_stock: number; scanned: number; cap: number; coverage_complete: boolean }>;
    product?: typeof productForDetail;
    categories?: CategoryFixture[];
}

async function setupRoutes(
    page: Page,
    catalog: typeof products = products,
    exceptions?: Partial<StockExceptionPayload>,
    options: ProductRouteOptions = {},
) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        createPayloads: [] as Record<string, unknown>[],
        updatePayloads: [] as Record<string, unknown>[],
        categoryUpdates: [] as Array<{ id: string; body: Record<string, unknown> }>,
        categoryDeletes: [] as string[],
    };
    let currentProduct: Record<string, unknown> = { ...productForDetail, ...catalog.find((product) => product.id === 'prod-1'), ...options.product };
    let currentCategories = (options.categories ?? categoryFixture).map((category) => ({
        ...category,
        subcategories: category.subcategories?.map((subcategory) => ({ ...subcategory })),
    }));

    const findCategory = (id: string): CategoryFixture | undefined => (
        currentCategories.find((category) => category.id === id)
        ?? currentCategories.flatMap((category) => category.subcategories ?? []).find((subcategory) => subcategory.id === id)
    );
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
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: stockExceptionPayload(exceptions) }) });
        }
        if (path === '/api/product/overview' && method === 'GET') {
            return route.fulfill({ json: json({
                total: 1, active: 1, inactive: 0, low_stock: 0, out_of_stock: 0,
                scanned: 1, cap: 1000, coverage_complete: true, ...options.overview,
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
        if (path === '/api/product' && method === 'GET') {
            const query = Object.fromEntries(url.searchParams.entries());
            let rows: Array<typeof products[number] & { category_id?: string }> = [...catalog];
            if (query.is_active) rows = rows.filter((product) => String(product.is_active ?? product.status !== 'inactive') === query.is_active);
            if (query.category_id) rows = rows.filter((product) => product.category_id === query.category_id);
            if (query.min_price) rows = rows.filter((product) => Number(product.price) >= Number(query.min_price));
            if (query.max_price) rows = rows.filter((product) => Number(product.price) <= Number(query.max_price));
            if (query.search) rows = rows.filter((product) => product.name.toLowerCase().includes(query.search.toLowerCase()));
            return route.fulfill({ json: json(rows) });
        }
        if (path === '/api/product' && method === 'POST') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.createPayloads.push(body);
            return route.fulfill({ status: 201, json: json({ ...body, id: 'prod-new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }) });
        }
        if (path === '/api/product/images') return route.fulfill({ json: json({ url: 'https://example.com/img.png' }) });
        const productMatch = path.match(/^\/api\/product\/([\w-]+)$/);
        if (productMatch && method === 'GET') return route.fulfill({ json: json(currentProduct) });
        if (productMatch && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.updatePayloads.push(body);
            currentProduct = { ...currentProduct, ...body, updatedAt: '2026-01-02T00:00:00.000Z' };
            return route.fulfill({ json: json(currentProduct) });
        }
        if (path === '/api/category' && method === 'GET') {
            return route.fulfill({ json: json(currentCategories) });
        }
        const categoryMatch = path.match(/^\/api\/category\/([\w-]+)$/);
        if (categoryMatch && method === 'GET') return route.fulfill({ json: json(findCategory(categoryMatch[1]) ?? { id: categoryMatch[1], name: 'Unknown' }) });
        if (categoryMatch && method === 'PATCH') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.categoryUpdates.push({ id: categoryMatch[1], body });
            currentCategories = currentCategories.map((category) => category.id === categoryMatch[1]
                ? { ...category, ...body }
                : { ...category, subcategories: category.subcategories?.map((subcategory) => subcategory.id === categoryMatch[1] ? { ...subcategory, ...body } : subcategory) });
            return route.fulfill({ json: json(findCategory(categoryMatch[1]) ?? { id: categoryMatch[1], ...body }) });
        }
        if (categoryMatch && method === 'DELETE') {
            state.categoryDeletes.push(categoryMatch[1]);
            currentCategories = currentCategories
                .filter((category) => category.id !== categoryMatch[1])
                .map((category) => ({ ...category, subcategories: category.subcategories?.filter((subcategory) => subcategory.id !== categoryMatch[1]) }));
            return route.fulfill({ json: json({ deleted: true }) });
        }
        if (path === '/api/order') return route.fulfill({ json: json([]) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page, target = '/products') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    const signinResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/auth/signin' && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: /sign in/i }).click();
    expect((await signinResponsePromise).ok()).toBeTruthy();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto(target);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('page header: compact title + relocated count + table, no signal band, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    // Removal pinned: the page-level signal badge must not exist.
    await expect(page.getByTestId('products-signal')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible();
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // The filtered catalog count remains in the compact page header.
    await expect(page.getByTestId('products-filtered-count')).toContainText('1');
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('overview counts come from the server, expose partial coverage, and filter the catalog', async ({ page }) => {
    const overviewProducts = [
        ...stockProducts,
        { id: 'prod-inactive', name: 'Retired Hoodie', price: 799, description: '', category: 'Apparel', sku: 'RH-1', status: 'inactive', is_active: false, quantity: 2, track_quantity: true, low_stock_threshold: 5, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const state = await setupRoutes(page, overviewProducts, undefined, {
        overview: { total: 148, active: 121, inactive: 27, low_stock: 7, out_of_stock: 3, scanned: 500, cap: 1000, coverage_complete: false },
    });
    await loginAndGo(page);

    const overview = page.getByRole('region', { name: 'Product inventory overview' });
    await expect(overview.getByTestId('products-overview-total')).toContainText('148');
    await expect(overview.getByTestId('products-overview-active')).toContainText('121');
    await expect(overview.getByTestId('products-overview-low')).toContainText('7+');
    await expect(overview.getByTestId('products-overview-out')).toContainText('3+');
    // Locale-formatted interpolation (P2 fix): en-US grouping in en, Bangla
    // digits in bn — the screenshot packet pins the bn shape.
    await expect(page.getByTestId('products-overview-coverage-note')).toContainText('Stock checked for 500 of 1,000 products');

    await overview.getByTestId('products-overview-low').click();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toHaveCount(0);

    const activeRequestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/product' && url.searchParams.get('is_active') === 'true';
    });
    await overview.getByTestId('products-overview-active').click();
    const activeRequest = await activeRequestPromise;
    expect(new URL(activeRequest.url()).searchParams.get('is_active')).toBe('true');
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    await expect(page.getByText('Retired Hoodie')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('upload dialog is labelled, traps focus, and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    // 'products.import' rendered raw only while the locale key was missing
    // (screenshot P1); the resolved CTA is 'Import'.
    await page.getByRole('button', { name: /^(Upload Product File|Import)$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'products-upload-title');
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('full-page add route saves a product with only its required fields', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/products/add');
    await expect(page.getByRole('heading', { name: 'Add New Product' })).toBeVisible({ timeout: 15_000 });
    const createResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/product' && response.request().method() === 'POST'
    ));
    await page.getByLabel('Product Name').fill('New Product');
    await page.getByLabel('Selling Price').fill('100');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await createResponsePromise;
    await expect.poll(() => state.createPayloads.length).toBe(1);
    expect(state.createPayloads[0].name).toBe('New Product');
    expect(state.createPayloads[0].price).toBe(100);
    await expect(page).toHaveURL(/\/products$/);
    expect(state.unexpected).toEqual([]);
});

test('product details keep images read-only and persisted variants read-only in the edit route', async ({ page }) => {
    const state = await setupRoutes(page, [productForDetail], undefined, { product: productForDetail });
    await loginAndGo(page, '/products/prod-1');

    await expect(page.getByRole('heading', { name: 'Demo Hoodie', exact: true })).toBeVisible();
    const imageSection = page.getByRole('region', { name: 'Product Images' });
    await expect(imageSection.getByRole('img', { name: 'Product 1' })).toBeVisible();
    await expect(imageSection.getByRole('button')).toHaveCount(0);
    await expect(page.getByLabel('Choose Files')).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/products\/prod-1\/edit$/);
    await expect(page.getByText('Saved product variants are managed as separate records and take precedence over option groups here. They are read-only on this page.')).toBeVisible();
    await expect(page.getByText('Size: M')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Variant Group' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove variant group 1' })).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('edit route sends explicit clears for dirty optional product fields', async ({ page }) => {
    const state = await setupRoutes(page, [productForDetail], undefined, { product: productForDetail });
    await loginAndGo(page, '/products/prod-1/edit');
    await expect(page.getByLabel('Product Name')).toHaveValue('Demo Hoodie');

    await page.getByLabel('Description', { exact: true }).fill('');
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'No category' });
    await page.getByLabel('Low Stock Threshold').fill('');
    await page.getByRole('button', { name: /Additional Details/ }).click();
    await page.getByLabel('SKU', { exact: true }).fill('');
    await page.getByLabel('Brand / Manufacturer').fill('');
    await page.getByRole('button', { name: 'Remove tag: Featured' }).click();
    await page.getByRole('button', { name: 'Clear all images' }).click();

    const updateResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/product/prod-1' && response.request().method() === 'PATCH'
    ));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await updateResponsePromise;

    expect(state.updatePayloads).toEqual([{
        description: null,
        category_id: null,
        low_stock_threshold: null,
        sku: null,
        brand: null,
        tags: [],
        images: [],
        image_url: null,
    }]);
    await expect(page).toHaveURL(/\/products\/prod-1$/);
    expect(state.unexpected).toEqual([]);
});

test('categories show linked-product counts, reactivate inactive records, and disclose delete impact', async ({ page }) => {
    const categories: CategoryFixture[] = [
        ...categoryFixture,
        { id: 'cat-retired', name: 'Footwear', is_active: false, product_count: 0, affected_product_count: 2, subcategory_count: 0 },
    ];
    const state = await setupRoutes(page, products, undefined, { categories });
    const categoryRequestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/category' && request.method() === 'GET' && url.searchParams.has('include');
    });
    await loginAndGo(page, '/categories');
    const categoryRequest = await categoryRequestPromise;
    const categoryParams = new URL(categoryRequest.url()).searchParams;
    expect(categoryParams.get('include')).toBe('product_count');
    expect(categoryParams.get('include_inactive')).toBe('true');
    await expect(page.getByText('Active products: 3')).toBeVisible();
    await expect(page.getByText('Active products: 2')).toBeVisible();

    const reactivateResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/category/cat-retired' && response.request().method() === 'PATCH'
    ));
    await page.getByRole('button', { name: 'Reactivate Footwear' }).click();
    await reactivateResponsePromise;
    expect(state.categoryUpdates).toContainEqual({ id: 'cat-retired', body: { is_active: true } });
    const footwearHeading = page.getByRole('heading', { name: 'Footwear', exact: true });
    await expect(footwearHeading.locator('..').getByText('Active', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Apparel' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Active products linked under this category: 5');
    await expect(dialog).toContainText('All linked product records affected, including inactive and previously deleted: 10');
    await expect(dialog).toContainText('Subcategories affected: 1');
    const deleteResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/category/cat-1' && response.request().method() === 'DELETE'
    ));
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await deleteResponsePromise;
    expect(state.categoryDeletes).toEqual(['cat-1']);
    await expect(page.getByRole('heading', { name: 'Apparel', exact: true })).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow on the worklist', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the products surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('table')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.em-products').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});

// ── Phase 1 W2 (A4) / W3 (A6): merchant-controlled stock filter (D2) ─────────
test('W2 stock control: segmented exception toggles replace the old checkbox, seed + clear work', async ({ page }) => {
    const state = await setupRoutes(page, stockProducts);
    await loginAndGo(page);
    await expect(page.getByTestId('products-stock-exceptions')).toBeVisible({ timeout: 15_000 });
    // Old parent-only checkbox vocabulary is gone (replaced by the D2 tri-state).
    await expect(page.getByText('Low stock only')).toHaveCount(0);
    await expect(page.locator('#lowStockOnly')).toHaveCount(0);
    // All three D2 products start visible.
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    // ?stock=exceptions seed (badge destination parity): exceptions = low ∪ out.
    await page.goto('/products?stock=exceptions');
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Demo Hoodie')).toHaveCount(0);
    // Narrow to out-of-stock only.
    await page.getByTestId('products-stock-out').click();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Low Tee')).toHaveCount(0);
    // Low toggle replaces (single-select control), then clear restores all.
    await page.getByTestId('products-stock-low').click();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toHaveCount(0);
    await page.getByTestId('products-stock-clear').click();
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    // Honest aria descriptions on the exception controls.
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-label', 'Show only products that are out of stock or low on stock');
    expect(state.unexpected).toEqual([]);
});

test('W2 unknown ?stock= seed fails closed to the full list (mirrors Orders bucket seed)', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/products?stock=bogus');
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

// A8 MAJOR-1 badge↔list parity: the nav badge (server scan, `is_active: true`
// scope) and the ?stock=exceptions list (client predicate) must agree — a
// retired-but-tracked product appears in NEITHER the count nor the filter,
// yet stays a normal catalog row.
test('badge↔list parity: retired-but-tracked product is in neither the exception count nor the ?stock= filter', async ({ page }) => {
    const state = await setupRoutes(page, retiredStockProducts, { outOfStock: 1, lowStock: 1, exceptions: 2, coverageComplete: true });
    await loginAndGo(page);
    const rail = page.locator('aside nav').first();

    // Catalog truth: the retired row is still a product (visible unfiltered),
    // but it carries no exception claim (badge stays at the server's 2).
    await expect(page.getByText('Retired Cap')).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Products 2 products have stock exceptions' })).toBeVisible();

    // Badge destination parity: the filtered list rows == the badge count.
    await page.goto('/products?stock=exceptions');
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Retired Cap')).toHaveCount(0);
    await expect(page.getByText('Demo Hoodie')).toHaveCount(0);
    const filteredRows = await page.getByRole('table').locator('tbody tr').count();
    expect(filteredRows).toBe(2);
    expect(state.unexpected).toEqual([]);
});
