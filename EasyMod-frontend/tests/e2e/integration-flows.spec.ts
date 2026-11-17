import { expect, test, type Page } from '@playwright/test';

const mockUser = {
  id: 'user-qa-2',
  full_name: 'QA Integration User',
  email: 'integration@example.com',
};

const mockShop = {
  id: 'shop-qa-2',
  unique_code: 'QA456',
  shop_name: 'Integration Shop',
  role: 'owner',
};

async function mockAuthenticatedApi(page: Page) {
  await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/csrf' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ csrfToken: 'csrf-integration-token' }),
      });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            user: mockUser,
            currentShop: mockShop,
            allShops: [mockShop],
          },
        }),
      });
    }

    if (path === '/api/product' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'prod-1',
              name: 'Demo Hoodie',
              price: 1299,
              description: 'Comfort fit demo product',
              category: 'Apparel',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    }

    if (path === '/api/category' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ id: 'cat-1', name: 'Apparel' }],
        }),
      });
    }

    if (path === '/api/order' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'ORD-1001',
              customer_name: 'Alice Rahman',
              order_items: [{ product_id: 'prod-1', productName: 'Demo Hoodie', quantity: 1, price: 1299 }],
              total: 1299,
              channel: 'facebook',
              order_status: 'confirmed',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      });
    }

    if (path === '/api/dashboard/metrics' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            metrics: {
              totalMessages: 20,
              activeProducts: 10,
              ordersToday: 5,
              weeklyChange: 12,
              conversionRate: 4.2,
            },
            channels: {
              active: 2,
              total: 3,
            },
            chartData: [],
          },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    });
  });
}

test('authenticated user can load products page', async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto('/products');

  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByText('Demo Hoodie')).toBeVisible();
});

test('authenticated user can load orders page', async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto('/orders');

  await expect(page).toHaveURL(/\/orders$/);
  // The worklist dual-renders mobile cards + desktop table; scope to the desktop
  // order-number button / first customer match to avoid strict-mode ambiguity.
  await expect(page.getByRole('button', { name: 'ORD-1001' })).toBeVisible();
  await expect(page.getByRole('table').getByText('Alice Rahman')).toBeVisible();
});
