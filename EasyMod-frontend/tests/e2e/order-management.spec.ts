import { expect, test, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

type MockOrder = {
  id: string;
  order_number: string;
  status: string;
  order_status: string;
  total_amount: number;
  total: number;
  payment_method: string | null;
  payment_status: string;
  fulfillment_status: string;
  delivery_status: string | null;
  delivery_provider?: string;
  delivery_tracking_code?: string;
  metadata?: { payment_reconciliation?: { required: boolean; code: string } };
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  items: Array<{ id: string; product_id: string; product_name: string; price: number; quantity: number }>;
  created_at: string;
};

const initialOrders: MockOrder[] = [
  {
    id: 'order-1', order_number: 'ORD-001', status: 'draft', order_status: 'draft',
    total_amount: 1500, total: 1500, payment_method: 'COD', payment_status: 'unpaid',
    channel: 'facebook',
    fulfillment_status: 'unfulfilled', delivery_status: null,
    customer_name: 'Ahmed Hassan', customer_phone: '01711000001',
    delivery_address: 'House 1, Mirpur, Dhaka',
    items: [{ id: 'item-1', product_id: 'product-1', product_name: 'Blue T-Shirt', price: 750, quantity: 2 }],
    created_at: '2026-10-30T10:00:00.000Z',
  },
  {
    id: 'order-2', order_number: 'ORD-002', status: 'confirmed', order_status: 'confirmed',
    total_amount: 800, total: 800, payment_method: 'bKash', payment_status: 'paid',
    channel: 'whatsapp',
    fulfillment_status: 'unfulfilled', delivery_status: 'booked', delivery_provider: 'steadfast',
    delivery_tracking_code: 'TRK-OLD',
    customer_name: 'Fatima Begum', customer_phone: '01711000002',
    delivery_address: 'House 2, Dhanmondi, Dhaka',
    items: [{ id: 'item-2', product_id: 'product-2', product_name: 'Red Hijab', price: 400, quantity: 2 }],
    metadata: { payment_reconciliation: { required: true, code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM' } },
    created_at: '2026-10-29T10:00:00.000Z',
  },
  {
    id: 'order-3', order_number: 'ORD-003', status: 'completed', order_status: 'completed',
    total_amount: 2000, total: 2000, payment_method: 'Nagad', payment_status: 'unpaid',
    channel: 'storefront',
    fulfillment_status: 'fulfilled', delivery_status: 'delivered',
    customer_name: 'Karim Uddin', customer_phone: '01711000003',
    delivery_address: 'House 3, Uttara, Dhaka',
    items: [{ id: 'item-3', product_id: 'product-3', product_name: 'Kurta Set', price: 1000, quantity: 2 }],
    created_at: '2026-10-28T10:00:00.000Z',
  },
  {
    id: 'order-4', order_number: 'ORD-004', status: 'confirmed', order_status: 'confirmed',
    total_amount: 2400, total: 2400, payment_method: 'COD', payment_status: 'partially_paid',
    channel: 'instagram',
    fulfillment_status: 'unfulfilled', delivery_status: null,
    customer_name: 'Nusrat Jahan', customer_phone: '01711000004',
    delivery_address: 'House 4, Banani, Dhaka',
    items: [{ id: 'item-4', product_id: 'product-4', product_name: 'Cotton Saree', price: 2400, quantity: 1 }],
    metadata: { payment_reconciliation: { required: true, code: 'COD_COURIER_COLLECTION_REVIEW_REQUIRED' } },
    created_at: '2026-10-27T10:00:00.000Z',
  },
  {
    id: 'order-5', order_number: 'ORD-005', status: 'confirmed', order_status: 'confirmed',
    total_amount: 900, total: 900, payment_method: null, payment_status: 'unpaid',
    channel: 'facebook',
    fulfillment_status: 'unfulfilled', delivery_status: null,
    customer_name: 'Legacy Order', customer_phone: '01711000005',
    delivery_address: 'House 5, Mirpur, Dhaka',
    items: [{ id: 'item-5', product_id: 'product-5', product_name: 'Legacy Item', price: 900, quantity: 1 }],
    created_at: '2026-10-26T10:00:00.000Z',
  },
  {
    id: 'order-6', order_number: 'ORD-006', status: 'confirmed', order_status: 'confirmed',
    total_amount: 700, total: 700, payment_method: null, payment_status: 'unpaid',
    fulfillment_status: 'unfulfilled', delivery_status: 'in_transit', delivery_provider: 'steadfast',
    delivery_tracking_code: 'TRK-LOCKED',
    channel: 'whatsapp',
    customer_name: 'Tracked Legacy', customer_phone: '01711000006',
    delivery_address: 'House 6, Mirpur, Dhaka',
    items: [{ id: 'item-6', product_id: 'product-6', product_name: 'Jamdani Scarf', price: 700, quantity: 1 }],
    created_at: '2026-10-25T10:00:00.000Z',
  },
  {
    id: 'order-7', order_number: 'ORD-007', status: 'confirmed', order_status: 'confirmed',
    total_amount: 1100, total: 1100, payment_method: null, payment_status: 'unpaid',
    fulfillment_status: 'unfulfilled', delivery_status: null,
    channel: 'facebook',
    customer_name: 'Claimed Legacy', customer_phone: '01711000007',
    delivery_address: 'House 7, Mirpur, Dhaka',
    items: [{ id: 'item-7', product_id: 'product-7', product_name: 'Cotton Kurta', price: 1100, quantity: 1 }],
    created_at: '2026-10-24T10:00:00.000Z',
  },
];

type ListQuery = {
  search: string | null;
  orderStatus: string | null;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  deliveryBucket: string | null;
};

const WORKLIST_BUCKETS = ['to_confirm', 'to_pack', 'booked', 'in_transit', 'needs_action', 'returned', 'delivered'] as const;
type WorklistBucket = (typeof WORKLIST_BUCKETS)[number];

// Mirrors EasyMod-backend/src/modules/order/order-worklist.buckets.js. Kept
// local because the mock suite has no backend to import from; if the server
// definitions change, this must change with them.
const UNSTARTED_DELIVERY_STATUSES = [null, '', 'unfulfilled', 'not_booked'];

function matchesBucket(order: MockOrder, bucket: WorklistBucket): boolean {
  const delivery = order.delivery_status ?? null;
  switch (bucket) {
    case 'to_confirm':
      return ['draft', 'pending'].includes(order.order_status);
    case 'to_pack':
      return ['confirmed', 'processing'].includes(order.order_status)
        && UNSTARTED_DELIVERY_STATUSES.includes(delivery as string | null);
    case 'booked':
      return delivery === 'booked';
    case 'in_transit':
      return ['picked_up', 'in_transit', 'out_for_delivery'].includes(delivery as string);
    case 'needs_action':
      return ['failed_delivery', 'dispatch_indeterminate', 'courier_setup_required', 'confidence_hold'].includes(delivery as string);
    case 'returned':
      return ['returned', 'partial_returned'].includes(delivery as string);
    case 'delivered':
      return ['delivered', 'partial_delivered'].includes(delivery as string);
    default:
      return true;
  }
}

function countOrders(orders: MockOrder[]) {
  const counts: Record<string, number> = { total: orders.length };
  for (const bucket of WORKLIST_BUCKETS) {
    counts[bucket] = orders.filter((order) => matchesBucket(order, bucket)).length;
  }
  return counts;
}

let unexpectedApiRequests: string[] = [];
let listQueries: ListQuery[] = [];
let actionRequests: string[] = [];
let createPayloads: Array<Record<string, unknown>> = [];
let courierPayloads: Array<Record<string, unknown>> = [];
let eligibilityChecks: string[] = [];

const fulfillJson = (route: Route, data: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(data),
});

async function setupRoutes(page: Page, options: { failFirstOrderList?: boolean; shopRole?: string } = {}) {
  let authenticated = false;
  let failOrderListUntilRetry = options.failFirstOrderList ?? false;
  const activeShop = { ...mockShop, role: options.shopRole || mockShop.role };
  const orders: MockOrder[] = structuredClone(initialOrders);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/api/')) return route.continue();

    if (path === '/api/csrf' && method === 'GET') {
      return fulfillJson(route, { csrfToken: 'csrf-test' });
    }
    if (path === '/api/auth/signin' && method === 'POST') {
      authenticated = true;
      return fulfillJson(route, { success: true, data: { user: mockUser, currentShop: activeShop, allShops: [activeShop] } });
    }
    if (path === '/api/auth/me' && method === 'GET') {
      if (!authenticated) return fulfillJson(route, { success: false }, 401);
      return fulfillJson(route, { success: true, data: { user: mockUser, currentShop: activeShop, allShops: [activeShop] } });
    }
    if (path === '/api/product' && method === 'GET') {
      return fulfillJson(route, { success: true, data: [{ id: 'product-1', name: 'Test Product', sku: 'SKU-1', price: 500, quantity: 8, track_quantity: true }] });
    }
    if (path === '/api/payment/config' && method === 'GET') {
      return fulfillJson(route, { success: true, data: [
        { id: 'cod-config', gateway: 'cod', is_enabled: true },
        { id: 'mfs-config', gateway: 'self-mfs', is_enabled: true },
      ] });
    }
    if (path === '/api/notifications/in-app' && method === 'GET') {
      return fulfillJson(route, { success: true, data: [] });
    }
    if (path === '/api/subscription' && method === 'GET') {
      return fulfillJson(route, {
        success: true,
        data: {
          subscription: { plan_code: 'SHURU', plan_name: 'Shuru', conversations_limit: 100, features: {} },
          effective_conversation_limit: 100,
          usage: { conversations: { used: 0, limit: 100 } },
          period: { start: '2026-11-01T00:00:00.000Z' },
        },
      });
    }
    if (path === '/api/order/counts' && method === 'GET') {
      return fulfillJson(route, { success: true, data: countOrders(orders) });
    }
    if (path === '/api/order' && method === 'GET') {
      const query: ListQuery = {
        search: url.searchParams.get('search'),
        orderStatus: url.searchParams.get('order_status'),
        paymentStatus: url.searchParams.get('payment_status'),
        fulfillmentStatus: url.searchParams.get('fulfillment_status'),
        startDate: url.searchParams.get('start_date'),
        endDate: url.searchParams.get('end_date'),
        deliveryBucket: url.searchParams.get('delivery_bucket'),
      };
      listQueries.push(query);
      if (failOrderListUntilRetry) {
        return fulfillJson(route, { success: false, error: 'Temporary list error' }, 503);
      }
      const search = query.search?.toLowerCase();
      const matchingOrders = orders.filter((order) => {
        const matchesSearch = !search || [order.order_number, order.customer_name, order.customer_phone]
          .some((field) => field.toLowerCase().includes(search));
        const matchesDeliveryBucket = !query.deliveryBucket
          || (WORKLIST_BUCKETS.includes(query.deliveryBucket as WorklistBucket)
            && matchesBucket(order, query.deliveryBucket as WorklistBucket));
        return matchesSearch
          && matchesDeliveryBucket
          && (!query.orderStatus || order.status === query.orderStatus)
          && (!query.paymentStatus || order.payment_status === query.paymentStatus)
          && (!query.fulfillmentStatus || order.fulfillment_status === query.fulfillmentStatus);
      });
      return fulfillJson(route, { success: true, data: matchingOrders });
    }
    if (path === '/api/order' && method === 'POST') {
      actionRequests.push(`${method} ${path}`);
      const payload = request.postDataJSON();
      createPayloads.push(payload);
      const created: MockOrder = {
        id: 'order-created', order_number: 'ORD-CREATED', status: 'draft', order_status: 'draft',
        total_amount: Number(payload.total || 0), total: Number(payload.total || 0),
        payment_status: payload.payment_status || 'pending', payment_method: payload.payment_method || null,
        customer_name: payload.customer_name, customer_phone: payload.customer_phone,
        fulfillment_status: 'unfulfilled', delivery_status: null,
        items: [], created_at: new Date().toISOString(),
      };
      orders.unshift(created);
      return fulfillJson(route, { success: true, data: created }, 201);
    }
    if (path === '/api/order/order-1/confirm' && method === 'POST') {
      actionRequests.push(`${method} ${path}`);
      const order = orders.find((candidate) => candidate.id === 'order-1')!;
      order.status = 'confirmed';
      order.order_status = 'confirmed';
      return fulfillJson(route, { success: true, data: order });
    }
    if (path === '/api/order/order-5' && method === 'PATCH') {
      actionRequests.push(`${method} ${path}`);
      const payload = request.postDataJSON();
      const order = orders.find((candidate) => candidate.id === 'order-5')!;
      order.payment_method = payload.payment_method;
      return fulfillJson(route, { success: true, data: order });
    }
    if (path === '/api/order/order-7' && method === 'PATCH') {
      actionRequests.push(`${method} ${path}`);
      return fulfillJson(route, {
        success: false,
        code: 'PAYMENT_METHOD_LOCKED_AFTER_DISPATCH',
        message: 'Payment method cannot be changed after a courier claim or tracking record exists.',
      }, 409);
    }
    // Read-only destination pre-check fired by the booking modal. RedX is the
    // "no coverage" case so the UI can be tested for blocking.
    if (/^\/api\/order\/[^/]+\/courier\/eligibility$/.test(path) && method === 'GET') {
      const provider = url.searchParams.get('provider');
      eligibilityChecks.push(`${path}:${provider || 'default'}`);
      return fulfillJson(route, {
        success: true,
        data: {
          provider: provider || 'steadfast',
          decision: provider === 'redx' ? 'NOT_SERVICEABLE' : 'SERVICEABLE',
          reason_code: provider === 'redx' ? 'NO_AREA_MATCH' : 'AREA_MATCHED',
          source: 'order_destination',
          checked_at: new Date().toISOString(),
          ttl_seconds: 300,
        },
      });
    }
    if (path === '/api/order/order-4/courier' && method === 'POST') {
      actionRequests.push(`${method} ${path}`);
      return fulfillJson(route, {
        success: false,
        message: 'COD balance is unavailable for this partially paid order. Verify the amount due before courier booking.',
        code: 'COD_DUE_AMOUNT_UNKNOWN',
      }, 409);
    }
    if (path === '/api/order/order-1/courier' && method === 'POST') {
      actionRequests.push(`${method} ${path}`);
      courierPayloads.push(request.postDataJSON());
      const order = orders.find((candidate) => candidate.id === 'order-1')!;
      order.delivery_tracking_code = 'TRK-001';
      order.delivery_provider = 'steadfast';
      return fulfillJson(route, { success: true, data: { tracking_id: 'TRK-001', provider: 'steadfast' } }, 201);
    }
    if (/^\/api\/order-confidence\/orders\/[^/]+$/.test(path) && method === 'GET') {
      return fulfillJson(route, { success: true, data: { mode: 'off', decision: null } });
    }
    if (/^\/api\/order\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').pop();
      const order = orders.find((candidate) => candidate.id === id);
      return order
        ? fulfillJson(route, { success: true, data: order })
        : fulfillJson(route, { success: false, error: 'Not found' }, 404);
    }
    if (path === '/api/conversation' && method === 'GET') {
      return fulfillJson(route, { success: true, data: [], total: 0, page: 1, pageSize: 1 });
    }

    unexpectedApiRequests.push(`${method} ${path}`);
    return fulfillJson(route, { success: false, error: `Unmocked Orders E2E API request: ${method} ${path}` }, 501);
  });
  return { allowOrderListRetry: () => { failOrderListUntilRetry = false; } };
}

async function loginAndGo(page: Page, path = '/orders') {
  await page.goto('/signin');
  await page.getByRole('textbox', { name: /email/i }).fill('owner@shop.bd');
  await page.locator('input[type="password"]').fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|orders/);
  await page.goto(path);
}

test.beforeEach(() => {
  unexpectedApiRequests = [];
  listQueries = [];
  actionRequests = [];
  createPayloads = [];
  courierPayloads = [];
  eligibilityChecks = [];
});

test.afterEach(() => {
  expect(unexpectedApiRequests, `Unexpected API requests: ${unexpectedApiRequests.join(', ')}`).toEqual([]);
});

test('renders the desktop worklist with separate payment and delivery facts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupRoutes(page);
  await loginAndGo(page);

  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  const draftRow = table.getByRole('row').filter({ hasText: 'ORD-001' });
  await expect(draftRow).toContainText('Ahmed Hassan');
  await expect(draftRow).toContainText('Blue T-Shirt × 2');
  await expect(draftRow).toContainText('facebook');
  await expect(draftRow).toContainText('COD');
  await expect(draftRow).toContainText(/unpaid/i);
  await expect(draftRow).toContainText('Unfulfilled');
  await expect(draftRow).toContainText(/1,500/);
  await expect(page.getByText(/settled COD|cash received|courier settlement/i)).toHaveCount(0);
});

test('sends independent lifecycle, payment, fulfillment, and supported search filters', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);

  await page.getByRole('combobox', { name: 'Order status' }).selectOption('completed');
  await expect.poll(() => listQueries.at(-1)?.orderStatus).toBe('completed');
  expect(listQueries.at(-1)).toMatchObject({ paymentStatus: null, fulfillmentStatus: null });

  await page.getByRole('combobox', { name: 'Payment status' }).selectOption('paid');
  await expect.poll(() => listQueries.at(-1)?.paymentStatus).toBe('paid');
  await page.getByRole('combobox', { name: 'Fulfillment status' }).selectOption('fulfilled');
  await expect.poll(() => listQueries.at(-1)?.fulfillmentStatus).toBe('fulfilled');
  await page.getByRole('combobox', { name: 'Order status' }).selectOption('cancelled');
  await expect.poll(() => listQueries.at(-1)?.orderStatus).toBe('cancelled');
  expect(listQueries.at(-1)).toMatchObject({ paymentStatus: 'paid', fulfillmentStatus: 'fulfilled' });

  await page.getByRole('combobox', { name: 'Order status' }).selectOption('all');
  await page.getByRole('combobox', { name: 'Payment status' }).selectOption('all');
  await page.getByRole('combobox', { name: 'Fulfillment status' }).selectOption('all');
  await page.getByRole('searchbox', { name: 'Search order number, customer name, or phone' }).fill('Fatima');
  await expect.poll(() => listQueries.at(-1)?.search).toBe('Fatima');
  await expect(page.getByRole('table').getByRole('button', { name: 'ORD-002' })).toBeVisible();
});

test('worklist chips show server counts and filter the list by bucket', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);

  // Counts come from the aggregate endpoint, not from the loaded page slice.
  await expect(page.getByTestId('orders-bucket-count-all')).toHaveText('7');
  await expect(page.getByTestId('orders-bucket-count-to_confirm')).toHaveText('1');
  await expect(page.getByTestId('orders-bucket-count-to_pack')).toHaveText('3');
  await expect(page.getByTestId('orders-bucket-count-booked')).toHaveText('1');
  await expect(page.getByTestId('orders-bucket-count-in_transit')).toHaveText('1');
  await expect(page.getByTestId('orders-bucket-count-needs_action')).toHaveText('0');
  await expect(page.getByTestId('orders-bucket-count-returned')).toHaveText('0');
  await expect(page.getByTestId('orders-bucket-count-delivered')).toHaveText('1');

  await page.getByTestId('orders-bucket-booked').click();
  await expect.poll(() => listQueries.at(-1)?.deliveryBucket).toBe('booked');
  await expect(page.getByTestId('orders-bucket-booked')).toHaveAttribute('aria-pressed', 'true');
  const table = page.getByRole('table');
  await expect(table.getByRole('button', { name: 'ORD-002' })).toBeVisible();
  await expect(table.getByText('ORD-001')).toHaveCount(0);

  // Clearing back to "all" must drop the parameter rather than keep it stale.
  await page.getByTestId('orders-bucket-all').click();
  await expect.poll(() => listQueries.at(-1)?.deliveryBucket).toBeNull();
  await expect(table.getByText('ORD-001')).toBeVisible();
});

test('date presets send explicit bounds to the server', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('combobox', { name: 'Created date' }).selectOption('today');

  await expect.poll(() => listQueries.at(-1)?.startDate).not.toBeNull();
  const query = listQueries.at(-1)!;
  expect(Number.isNaN(Date.parse(query.startDate || ''))).toBe(false);
  expect(Number.isNaN(Date.parse(query.endDate || ''))).toBe(false);
});

test('shows a recoverable list error and retries without stale results', async ({ page }) => {
  const routes = await setupRoutes(page, { failFirstOrderList: true });
  await loginAndGo(page);

  await expect(page.getByRole('alert')).toContainText(/could not be loaded/i);
  await expect(page.getByText('ORD-001')).toHaveCount(0);
  routes.allowOrderListRetry();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('table').getByRole('button', { name: 'ORD-001' })).toBeVisible();
});

test('distinguishes a no-match search from an empty shop', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('searchbox', { name: 'Search order number, customer name, or phone' }).fill('does-not-exist');

  await expect(page.getByText('No orders match these filters.')).toBeVisible();
  await expect(page.getByText('No orders are available yet.')).toHaveCount(0);
});

test('opens the requested order through a shop-scoped deep link', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/orders?orderId=order-1');

  await expect(page.getByRole('heading', { name: 'Order Details' })).toBeVisible();
  await expect(page.getByTestId('order-detail-panel').getByText('Ahmed Hassan')).toBeVisible();
  await expect(page).toHaveURL(/\/orders$/);
});

test('shows payment reconciliation warnings only when required and distinguishes COD from verified non-COD', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);

  await page.getByRole('button', { name: 'ORD-002' }).click();
  const panel = page.getByTestId('order-detail-panel');
  await expect(panel.getByRole('alert')).toContainText('Verified payment needs courier reconciliation');
  await expect(panel.getByRole('alert')).toContainText('The amount collected by the courier is not established here.');

  await panel.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'ORD-004' }).click();
  await expect(panel.getByRole('alert')).toContainText('COD collection needs reconciliation');
  await expect(panel.getByRole('alert')).toContainText('how much cash the courier collected');

  await panel.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'ORD-001' }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('confirms a draft and sends courier booking through the supported endpoints', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-001' }).click();
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect.poll(() => actionRequests).toContain('POST /api/order/order-1/confirm');

  await page.getByRole('button', { name: 'Book Courier' }).last().click();
  await expect(page.getByRole('heading', { name: /book courier/i })).toBeVisible();
  await expect(page.getByText(/server calculates courier collection/i)).toBeVisible();
  // Coverage verdict arrives before the merchant commits to a courier.
  await expect(page.getByText(/matched a Steadfast service area/i)).toBeVisible();
  await page.getByRole('button', { name: 'Book Courier' }).last().click();

  await expect.poll(() => actionRequests).toContain('POST /api/order/order-1/courier');
  expect(courierPayloads).toHaveLength(1);
  expect(courierPayloads[0]).not.toHaveProperty('cod_amount');
  expect(courierPayloads[0]).not.toHaveProperty('amount_to_collect');
  await expect(page.getByTestId('order-detail-panel').getByRole('button', { name: 'ID: TRK-001' })).toBeVisible();
  // The modal checks coverage before submitting, and the verdict is shown.
  expect(eligibilityChecks).toContain('/api/order/order-1/courier/eligibility:steadfast');
});

test('blocks a courier the server reports as not covering the destination', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-001' }).click();
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect.poll(() => actionRequests).toContain('POST /api/order/order-1/confirm');

  await page.getByRole('button', { name: 'Book Courier' }).last().click();
  await expect(page.getByRole('heading', { name: /book courier/i })).toBeVisible();
  await page.getByRole('button', { name: 'redx', exact: true }).last().click();

  await expect(page.getByRole('alert').filter({ hasText: /does not list this delivery area/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book Courier' }).last()).toBeDisabled();
  expect(actionRequests).not.toContain('POST /api/order/order-1/courier');
});

test('blocks an unknown partial COD balance before courier submission', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  const partialRow = page.getByRole('table').getByRole('row').filter({ hasText: 'ORD-004' });
  await expect(partialRow).toContainText('Unknown');
  await page.getByRole('button', { name: 'ORD-004' }).click();
  await page.getByRole('button', { name: 'Book Courier' }).last().click();

  await expect(page.getByRole('alert').filter({ hasText: /No authoritative COD due amount exists/i }))
    .toContainText(/No authoritative COD due amount exists/i);
  await expect(page.getByRole('button', { name: 'Book Courier' }).last()).toBeDisabled();
  expect(actionRequests).not.toContain('POST /api/order/order-4/courier');
});

test('creates a manual draft only after an explicit supported payment method is selected', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'Create Order' }).click();
  const modal = page.getByTestId('create-order-modal');

  await modal.getByPlaceholder('Enter customer name').fill('Manual Buyer');
  await modal.getByLabel('Phone/Mobile Number').fill('01711000009');
  const selectors = modal.getByRole('combobox');
  await selectors.nth(0).selectOption('manual');
  await selectors.nth(1).selectOption('dhaka');
  await selectors.nth(2).selectOption('dhaka_city');
  await selectors.nth(3).selectOption('Mirpur');
  await modal.getByPlaceholder('House / Road / Area (e.g. House 12, Road 4)').fill('Road 9');
  await modal.getByPlaceholder('Search and add products…').fill('Test Product');
  await modal.getByRole('button', { name: /Test Product/ }).click();

  const createButton = modal.getByRole('button', { name: 'Create Order' });
  const paymentMethod = modal.getByRole('combobox', { name: 'Payment method' });
  await expect(paymentMethod).toHaveValue('');
  await expect(createButton).toBeDisabled();
  await paymentMethod.selectOption('cod');
  await expect(createButton).toBeEnabled();
  await createButton.click();

  await expect.poll(() => createPayloads.length).toBe(1);
  expect(createPayloads[0].payment_method).toBe('cod');
  await expect(page.getByTestId('order-detail-panel').getByText('ORD-CREATED')).toBeVisible();
});

test('lets an owner/admin correct a legacy missing method through the audited update path', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-005' }).click();
  const panel = page.getByTestId('order-detail-panel');
  const methodChoice = panel.getByRole('combobox', { name: 'Correct the missing payment method' });
  await methodChoice.selectOption('cod');
  await panel.getByRole('button', { name: 'Save verified method' }).click();

  await expect.poll(() => actionRequests).toContain('PATCH /api/order/order-5');
  expect(panel).toContainText('cod');
  await expect(panel.getByRole('button', { name: 'Book Courier' })).toBeEnabled();
});

test('does not expose payment-method correction once courier tracking exists', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-006' }).click();
  const panel = page.getByTestId('order-detail-panel');

  await expect(panel.getByText(/courier claim or tracking record exists/i)).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Correct the missing payment method' })).toHaveCount(0);
});

test('hides payment correction after the server reports an active courier claim', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-007' }).click();
  const panel = page.getByTestId('order-detail-panel');
  await panel.getByRole('combobox', { name: 'Correct the missing payment method' }).selectOption('cod');
  await panel.getByRole('button', { name: 'Save verified method' }).click();

  await expect.poll(() => actionRequests).toContain('PATCH /api/order/order-7');
  await expect(panel.getByText(/courier claim or tracking record exists/i)).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Correct the missing payment method' })).toHaveCount(0);
});

test('staff cannot see the owner/admin payment-method correction control', async ({ page }) => {
  await setupRoutes(page, { shopRole: 'staff' });
  await loginAndGo(page);
  await page.getByRole('button', { name: 'ORD-005' }).click();
  const panel = page.getByTestId('order-detail-panel');

  await expect(panel.getByText(/owner\/admin-only and audited/i)).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Correct the missing payment method' })).toHaveCount(0);
  expect(actionRequests).not.toContain('PATCH /api/order/order-5');
});

test('mobile uses a list-to-detail flow and returns to the same worklist', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupRoutes(page);
  await loginAndGo(page);

  await page.getByRole('button', { name: 'View details' }).first().click();
  await expect(page.getByRole('heading', { name: 'Order Details' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(/#ORD-001/)).toBeVisible();
});

test('exports the current worklist as CSV', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('button', { name: 'CSV' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('orders.csv');
});
