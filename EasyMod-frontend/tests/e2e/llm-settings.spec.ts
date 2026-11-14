/**
 * AI reply settings - Playwright system tests.
 *
 * These tests exercise the AI settings form on the business automation
 * defaults page (`/manage-shop/automation`, ADR-0013 §9) rather than the
 * removed standalone provider settings screen. The form itself is unchanged.
 */

import { expect, test, type Page } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

const mockBusinessInfo = {
    shopName: 'My BD Shop',
    phone: '01711000000',
    address: 'Dhaka, Bangladesh',
    additionalInfo: '',
    socialLinks: {},
};

const mockAISettings = {
    automation_mode: 'DRAFT',
    confidence_threshold: 75,
    auto_reply_enabled: false,
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
};

function jsonResponse(data: unknown, status = 200) {
    return {
        status,
        contentType: 'application/json',
        body: JSON.stringify({ success: status < 400, data }),
    };
}

async function setupRoutes(page: Page) {
    let authenticated = false;
    let persistedAI = structuredClone(mockAISettings);

    // Match API path segments only. '**/api/**' also matches Vite's
    // '/src/api/*' modules and prevents the application bundle from loading.
    await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const method = route.request().method();

        if (path === '/api/csrf') {
            return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill(jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }));
        }
        if (path === '/api/auth/me') {
            return route.fulfill(authenticated
                ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
                : jsonResponse({}, 401));
        }
        if (path === '/api/shop/business-info' && method === 'GET') {
            return route.fulfill(jsonResponse({ businessInfo: mockBusinessInfo, shop: mockShop }));
        }
        if (path === '/api/shop/ai-settings' && method === 'GET') {
            return route.fulfill(jsonResponse(persistedAI));
        }
        if (path === '/api/shop/ai-settings' && method === 'PUT') {
            persistedAI = { ...persistedAI, ...(route.request().postDataJSON() || {}) };
            return route.fulfill(jsonResponse(persistedAI));
        }
        if (path === '/api/notifications/telegram') {
            return route.fulfill(jsonResponse({ connected: false }));
        }
        if (path === '/api/notifications/in-app') {
            return route.fulfill(jsonResponse([]));
        }
        if (path.startsWith('/api/subscription')) {
            return route.fulfill(jsonResponse({ plan_code: 'SHURU', plan_name: 'Shuru', features: {} }));
        }

        return route.fulfill(jsonResponse({}));
    });
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill(mockUser.email);
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    // ADR-0013 §9: the reply settings form now lives on the business
    // automation defaults page; the business profile keeps identity only.
    await page.goto('/manage-shop/automation');
    await expect(page.getByRole('heading', { name: 'Reply Settings' })).toBeVisible({ timeout: 15_000 });
}

test('AI reply settings load with the canonical confidence default', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);

    await expect(page.getByRole('slider')).toHaveValue('75');
    await expect(page.getByRole('button', { name: 'Save Reply Settings' })).toBeDisabled();
});

test('AI settings survive save and reload', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);

    const maxOrderValue = page.locator('#max-auto-order-value');
    await maxOrderValue.fill('7500');

    const saveRequest = page.waitForRequest((request) =>
        request.url().endsWith('/api/shop/ai-settings') && request.method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save Reply Settings' }).click();

    const request = await saveRequest;
    expect(request.postDataJSON()).toEqual(expect.objectContaining({ max_auto_order_value: 7500 }));
    await expect(page.getByText('Reply settings saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Reply Settings' })).toBeVisible();
    await expect(page.locator('#max-auto-order-value')).toHaveValue('7500');
});
