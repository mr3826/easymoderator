import { expect, test, type Page } from '@playwright/test';

/**
 * Pilot intelligence browser journeys — Customer 360 Lite, Sales
 * Opportunities and RTO Shield v2 (Order Confidence).
 *
 * Mock-only tier, like the other CI Playwright specs: the backend is a
 * stateful route fixture below. What this proves is the merchant-facing UI
 * contract — what is shown, which request each action sends, and how the UI
 * reacts to the server's answer (including 409 holds). The server behaviour
 * itself (gate, CAS, exactly-once booking, conversion) is proven against real
 * PostgreSQL in the backend integration and Meta-shaped E2E suites; see
 * docs/pilot-intelligence/08-test-evidence.md.
 */

type Role = 'owner' | 'staff';
type Decision = 'READY' | 'VERIFY' | 'MANUAL_REVIEW';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const shopFor = (role: Role) => ({
  id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role, settings: { onboarding_completed: true },
});

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const json = (data: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify({ success: status < 400, data }),
});

const repeatBuyer = {
  id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', email: null, channel_type: 'messenger', profile_pic: null,
  first_seen_at: iso(-30 * 86400000), state: 'REPEAT_BUYER',
  state_reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 2 } }],
  total_orders: 3, delivered_orders: 2, returned_orders: 0, delivered_value: 3000,
  last_order_at: iso(-5 * 86400000), last_activity_at: iso(-3600000), open_opportunity: null,
};
const interested = {
  ...repeatBuyer, id: 'cust-2', name: 'Karim Hasan', phone: null, state: 'INTERESTED',
  state_reasons: [{ code: 'OPEN_OPPORTUNITY', params: {} }], total_orders: 0, delivered_orders: 0, delivered_value: 0,
  last_order_at: null, open_opportunity: { id: 'opp-1', status: 'OPEN', strength: 'HIGH', reasons: ['PURCHASE_INTENT'] },
};
const opportunity = (status = 'OPEN') => ({
  id: 'opp-1', status, strength: 'HIGH', reasons: ['PURCHASE_INTENT', 'ASKED_DELIVERY_CHARGE'], signals: [],
  product_refs: [{ product_id: 'p-1', name: 'Black Panjabi', quantity: 1 }], customer_id: 'cust-2', conversation_id: 'conv-2',
  first_signal_at: iso(-7200000), last_signal_at: iso(-3600000), detected_at: iso(-1800000), actioned_at: null,
  converted_order_id: null, resolved_at: null, resolution_reason: null,
  recommended_action: { code: 'REPLY_IN_INBOX', window_closes_at: iso(20 * 3600000) },
  customer: { id: 'cust-2', name: 'Karim Hasan', channel_type: 'messenger' },
});
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
    { id: 'ord-d2', order_number: 'ORD-101', created_at: iso(-5 * 86400000), total: 2000, order_status: 'delivered', payment_status: 'pending', delivery_status: 'delivered', delivery_provider: 'pathao', outcome: 'DELIVERED', link: 'CUSTOMER', confidence: { decision: 'READY', resolution: null, last_gate_result: 'ALLOWED', outcome: 'DELIVERED' } },
    { id: 'ord-c1', order_number: 'ORD-099', created_at: iso(-20 * 86400000), total: 500, order_status: 'cancelled', payment_status: 'pending', delivery_status: null, delivery_provider: null, outcome: 'CANCELLED', link: 'PHONE_MATCH', confidence: null },
  ],
  conversations: [],
  opportunities: [],
  timeline: [
    { type: 'ORDER_DELIVERED', at: iso(-3 * 86400000), order_id: 'ord-d2', order_number: 'ORD-101' },
    { type: 'ORDER_PLACED', at: iso(-5 * 86400000), order_id: 'ord-d2', order_number: 'ORD-101', total: 2000 },
  ],
};

const heldOrder = (id: string, number: string) => ({
  id, order_number: number, customer_name: 'Salma', customer_phone: '01799999999', order_status: 'confirmed',
  payment_status: 'pending', payment_method: 'cod', delivery_address: 'Mirpur 10', channel: 'messenger', total: 1500,
  items: [{ product_id: 'p-1', product_name: 'Black Panjabi', quantity: 1, price: 1500 }],
  createdAt: iso(-3600000), updatedAt: iso(-3600000),
});

interface Fixture {
  role: Role;
  pilot: boolean;
  decisions: Record<string, { decision: Decision; version: number; resolved: boolean }>;
  bookings: string[];
  verifyCalls: Array<Record<string, unknown>>;
  approveCalls: Array<Record<string, unknown>>;
  contacted: string[];
  unexpected: string[];
}

function decisionBody(orderId: string, d: Fixture['decisions'][string]) {
  const reasons = d.decision === 'MANUAL_REVIEW'
    ? [{ code: 'REPEATED_RETURNS', severity: 'REVIEW', source: 'ORDER_HISTORY', evidence: { returned: 2, delivered: 0 } }]
    : d.decision === 'VERIFY'
      ? [{ code: 'ADDRESS_TOO_SHORT', severity: 'VERIFY', source: 'ORDER', evidence: { length: 9, minimum: 15 } }]
      : [];
  return {
    order_id: orderId, mode: 'enforce', decision: d.decision,
    effective_state: d.resolved ? 'READY' : d.decision, bookable: true,
    required_action: d.resolved || d.decision === 'READY' ? 'NONE' : d.decision === 'VERIFY' ? 'VERIFY' : 'APPROVE',
    reasons, rules_version: 'order-confidence/1.0.0', evaluated_at: iso(0), decision_version: d.version,
    resolution: d.resolved ? { type: d.decision === 'VERIFY' ? 'VERIFIED' : 'APPROVED', level: d.decision, method: 'PHONE_CALL', note: null, resolved_by: 'user-1', resolved_at: iso(0), applies: true, stale: false } : null,
    gate: { last_result: d.resolved ? 'ALLOWED' : 'HELD', last_at: iso(0), held_count: 1 }, history: [],
  };
}

async function setup(page: Page, { role = 'owner', pilot = true }: { role?: Role; pilot?: boolean } = {}): Promise<Fixture> {
  const fixture: Fixture = {
    role, pilot,
    decisions: {
      'ord-verify': { decision: 'VERIFY', version: 3, resolved: false },
      'ord-review': { decision: 'MANUAL_REVIEW', version: 2, resolved: false },
      'ord-ready': { decision: 'READY', version: 1, resolved: false },
    },
    bookings: [], verifyCalls: [], approveCalls: [], contacted: [], unexpected: [],
  };
  let authenticated = false;
  const shop = shopFor(role);
  let opportunityStatus = 'OPEN';

  await page.addInitScript(() => {
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
    window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
  });

  await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();

    if (path === '/api/csrf') return route.fulfill(json({ csrfToken: 'csrf-test' }));
    if (path === '/api/auth/signin' && method === 'POST') {
      authenticated = true;
      return route.fulfill(json({ user: mockUser, currentShop: shop, allShops: [shop] }));
    }
    if (path === '/api/auth/me') {
      return route.fulfill(authenticated
        ? json({ user: mockUser, currentShop: shop, allShops: [shop] })
        : { status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Unauthorized' } }) });
    }
    if (path === '/api/setup/status') return route.fulfill(json({ isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [] }));
    if (path === '/api/dashboard/metrics') return route.fulfill(json({ metrics: { totalMessages: 0, activeProducts: 0, ordersToday: 0, weeklyChange: 0, conversionRate: 0 }, analytics: { llm_calls: 0 } }));
    if (path === '/api/dashboard/queue') return route.fulfill(json({ unread_count: 0, pending_payment_count: 0, at_risk_orders: [] }));
    if (path === '/api/subscription') return route.fulfill(json({ subscription: { plan_code: 'GROWTH', plan_name: 'Growth', conversations_limit: -1, features: { image_understanding: true, advanced_ai: true } }, effective_conversation_limit: -1, usage: { conversations: { used: 0, limit: -1 } }, period: { start: iso(-86400000) } }));
    if (path === '/api/notifications/in-app') return route.fulfill(json([]));
    if (path === '/api/notifications/telegram') return route.fulfill(json({ connected: false }));
    if (path === '/api/rto-shield/settings') return route.fulfill(json({ contribute: true, enforce: true }));
    if (path === '/api/product') return route.fulfill(json([]));

    // Pilot APIs
    if (path === '/api/customer-intelligence/status') {
      return route.fulfill(json({ customer_intelligence: fixture.pilot, order_confidence_mode: fixture.pilot ? 'enforce' : 'off' }));
    }
    if (path === '/api/customer-intelligence/customers') {
      const view = searchParams.get('view');
      const search = (searchParams.get('search') || '').toLowerCase();
      let rows = view === 'opportunities' ? [interested] : [repeatBuyer, interested];
      if (opportunityStatus !== 'OPEN') rows = rows.map((r) => (r.id === 'cust-2' ? { ...r, open_opportunity: null } : r));
      if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search) || (r.phone || '').includes(search));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: rows, total: rows.length, page: 1, pageSize: 20 }) });
    }
    if (path === '/api/customer-intelligence/customers/cust-1') return route.fulfill(json(customerDetail));
    if (path === '/api/customer-intelligence/opportunities') {
      const live = opportunityStatus === 'OPEN' || opportunityStatus === 'ACTIONED';
      const rows = live ? [opportunity(opportunityStatus)] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: rows, total: rows.length, page: 1, pageSize: 20 }) });
    }
    if (path === '/api/customer-intelligence/opportunities/opp-1/contacted' && method === 'POST') {
      fixture.contacted.push('opp-1');
      opportunityStatus = 'ACTIONED';
      return route.fulfill(json(opportunity('ACTIONED')));
    }

    const confidenceMatch = path.match(/^\/api\/order-confidence\/orders\/([^/]+)(\/verify|\/approve)?$/);
    if (confidenceMatch) {
      const [, orderId, action] = confidenceMatch;
      const d = fixture.decisions[orderId];
      if (!d) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' });
      if (!action) return route.fulfill(json(decisionBody(orderId, d)));
      const body = request.postDataJSON() as Record<string, unknown>;
      if (action === '/verify') fixture.verifyCalls.push(body);
      if (action === '/approve') {
        fixture.approveCalls.push(body);
        if (fixture.role !== 'owner') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"success":false}' });
      }
      if (body.decision_version !== d.version) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'DECISION_CHANGED', message: 'changed', details: { decision: decisionBody(orderId, d) } } }) });
      }
      d.resolved = true;
      d.version += 1;
      return route.fulfill(json(decisionBody(orderId, d)));
    }

    // Orders page
    if (path === '/api/payment/config' && method === 'GET') {
      return route.fulfill(json([
        { id: 'cod-config', gateway: 'cod', is_enabled: true },
        { id: 'mfs-config', gateway: 'self-mfs', is_enabled: true },
      ]));
    }
    if (path === '/api/order' && method === 'GET') {
      return route.fulfill(json([heldOrder('ord-verify', 'ORD-200'), heldOrder('ord-review', 'ORD-201')]));
    }
    const orderMatch = path.match(/^\/api\/order\/([^/]+)$/);
    if (orderMatch && method === 'GET') return route.fulfill(json(heldOrder(orderMatch[1], 'ORD-200')));
    const courierMatch = path.match(/^\/api\/order\/([^/]+)\/(courier|book-courier)$/);
    if (courierMatch && method === 'POST') {
      const orderId = courierMatch[1];
      const d = fixture.decisions[orderId];
      fixture.bookings.push(orderId);
      if (d && d.decision !== 'READY' && !d.resolved) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'ORDER_CONFIDENCE_HOLD', message: 'held', decision: d.decision, reasons: ['ADDRESS_TOO_SHORT'], decision_version: d.version } }) });
      }
      return route.fulfill(json({ tracking_id: `TRK-${orderId}`, consignment_id: `CN-${orderId}`, provider: 'steadfast', booked_at: iso(0) }));
    }
    if (path === '/api/conversation' && method === 'GET') {
      return route.fulfill(json({ conversations: [], ai_reply_mode: 'MANUAL', pagination: { total: 0, page: 1, pageSize: 50, totalPages: 1 } }));
    }
    if (path === '/api/conversation/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 10000\n\n' });
    if (path === '/api/templates') return route.fulfill(json([]));
    if (path === '/api/channels/meta') return route.fulfill(json([]));
    if (path === '/api/shop/ai-settings') return route.fulfill(json({ automation_mode: 'MANUAL' }));
    if (path === '/api/audit' && method === 'POST') return route.fulfill(json({ id: 'audit-1' }, 201));

    fixture.unexpected.push(`${method} ${path}`);
    return route.fulfill(json([]));
  });

  return fixture;
}

async function signInAndOpen(page: Page, path: string) {
  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(mockUser.email);
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(path);
}

async function openOrder(page: Page, orderNumber: string) {
  const row = page.getByRole('row').filter({ hasText: orderNumber });
  await row.getByRole('button', { name: 'View Details' }).click();
  await expect(page.getByTestId('order-confidence-panel')).toBeVisible();
}

test.describe('Customer 360 and Sales Opportunities', () => {
  test('journeys 1–4: customers list, detail with order and delivery history', async ({ page }) => {
    const fixture = await setup(page);
    await signInAndOpen(page, '/customers');

    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
    const row = page.getByTestId('customer-row-cust-1');
    await expect(row).toContainText('Rahim Uddin');
    await expect(row).toContainText('Repeat buyer');
    await expect(row).toContainText('2 delivered of 3');

    await row.click();
    await expect(page).toHaveURL(/\/customers\/cust-1$/);
    await expect(page.getByTestId('customer-state')).toHaveText('Repeat buyer');
    await expect(page.getByTestId('commerce-summary')).toContainText('3,000');
    await expect(page.getByTestId('customer-orders')).toContainText('#ORD-101');
    await expect(page.getByTestId('customer-orders')).toContainText('Matched by phone');
    await expect(page.getByTestId('customer-timeline')).toContainText('Order #ORD-101 delivered');
    await expect(page.getByTestId('reply-window')).toContainText('Reply window open until');
    expect(fixture.unexpected).toEqual([]);
  });

  test('journeys 5–6: a high-intent conversation shows as an opportunity; acting on it updates the list', async ({ page }) => {
    const fixture = await setup(page);
    await signInAndOpen(page, '/customers?tab=opportunities');

    const card = page.getByTestId('opportunity-opp-1');
    await expect(card).toContainText('Karim Hasan');
    await expect(card).toContainText('Strong interest');
    await expect(card).toContainText('Said they want to order');
    await expect(card).toContainText('Asked about delivery charge');
    await expect(page.getByTestId('customers-tab-opportunities')).toContainText('1');

    await card.getByRole('button', { name: /Mark contacted/ }).click();
    await expect(card).toContainText('Contacted');
    expect(fixture.contacted).toEqual(['opp-1']);

    // Follow-up happens in the Inbox, where the normal messaging policy applies.
    await card.getByRole('button', { name: /Open conversation/ }).click();
    await expect(page).toHaveURL(/\/inbox\?conversation=conv-2$/);
  });

  test('a shop without the pilot keeps the existing Customers page', async ({ page }) => {
    await setup(page, { pilot: false });
    await signInAndOpen(page, '/customers');
    await expect(page.getByRole('heading', { name: 'Customer Management' })).toBeVisible();
    await expect(page.getByTestId('customers-tab-opportunities')).toHaveCount(0);
  });

  test.describe('legacy worklist redesign', () => {
    const legacyCustomers = [
      { id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', email: null, channel_type: 'messenger', created_at: iso(-20 * 86400000), updated_at: iso(-3 * 86400000) },
      { id: 'cust-2', name: 'Karim Hasan', phone: '01799999999', email: null, channel_type: 'manual', created_at: iso(-10 * 86400000), updated_at: iso(-2 * 86400000) },
    ];

    test.beforeEach(async ({ page }) => {
      await setup(page, { pilot: false });
      // Newest route wins: override the generic catch-all with the real
      // legacy list contract (server-side search=NAME, separate phone filter).
      await page.route(/\/api\/customer(\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const search = (url.searchParams.get('search') || '').toLowerCase();
        const phone = url.searchParams.get('phone') || '';
        let rows = legacyCustomers;
        if (search) rows = rows.filter((c) => c.name.toLowerCase().includes(search));
        if (phone) rows = rows.filter((c) => c.phone.includes(phone));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: rows, total: rows.length, page: 1, pageSize: 20 }),
        });
      });
    });

    test('removes the summary cards and keeps search honest per supported field', async ({ page }) => {
      await signInAndOpen(page, '/customers');
      await expect(page.getByRole('heading', { name: 'Customer Management' })).toBeVisible();
      await expect(page.getByText('Total Customers')).toHaveCount(0);
      await expect(page.getByText('Channel Customers')).toHaveCount(0);
      await expect(page.getByText('Manual Customers')).toHaveCount(0);
      await expect(page.getByLabel('Search by name')).toBeVisible();
      await expect(page.getByLabel('Search by phone')).toBeVisible();
      // Network participation stays a secondary disclosure, not a hero panel.
      await expect(page.getByRole('button', { name: /Fake-Order Shield Network/ })).toBeVisible();
      const row = page.getByTestId('customer-table').locator('tr').filter({ hasText: 'Rahim Uddin' });
      await expect(row).toContainText('01711111111');
      await expect(row).not.toContainText('RTO');
    });

    test('phone search goes through the dedicated server parameter, not the name search', async ({ page }) => {
      const request = page.waitForRequest((req) => /\/api\/customer\?[^]*phone=0179999/.test(req.url()));
      await signInAndOpen(page, '/customers');
      await page.getByLabel('Search by phone').fill('0179999');
      await request;
      await expect(page.getByTestId('customer-table').locator('tr').filter({ hasText: 'Karim Hasan' })).toBeVisible();
      await expect(page.getByTestId('customer-table').locator('tr').filter({ hasText: 'Rahim Uddin' })).toHaveCount(0);
    });

    test('a profile links to the Orders worklist by that phone', async ({ page }) => {
      await signInAndOpen(page, '/customers');
      await page.getByTestId('customer-table').locator('tr').filter({ hasText: 'Rahim Uddin' })
        .getByRole('button', { name: 'View' }).click();
      await page.getByTestId('customer-view-orders').click();
      await expect(page).toHaveURL(/\/orders\?search=01711111111/);
      await expect(page.getByPlaceholder('Order number, customer name, or phone')).toHaveValue('01711111111');
    });
  });
});

test.describe('RTO Shield v2 / Order Confidence', () => {
  test('journeys 7–8, 10: a VERIFY order cannot be booked until verified, then books exactly once', async ({ page }) => {
    const fixture = await setup(page, { role: 'staff' });
    await signInAndOpen(page, '/orders');
    await openOrder(page, 'ORD-200');

    const panel = page.getByTestId('order-confidence-panel');
    await expect(panel.getByTestId('order-confidence-decision')).toHaveText('Needs verification');
    await expect(panel).toContainText('Address looks incomplete (9 characters)');

    // Booking attempt while held: the server answers 409 and nothing is booked.
    await page.getByRole('button', { name: /book courier/i }).click();
    await page.getByRole('button', { name: /^book/i }).last().click();
    await expect(page.getByText('This order needs checking before a courier can be booked.')).toBeVisible();
    expect(fixture.bookings).toEqual(['ord-verify']);

    // Verification completes with the version the merchant saw.
    await panel.getByTestId('order-confidence-submit').click();
    await expect(panel.getByTestId('order-confidence-decision')).toHaveText('Cleared for booking');
    expect(fixture.verifyCalls).toEqual([{ decision_version: 3, method: 'PHONE_CALL' }]);

    await page.getByRole('button', { name: /book courier/i }).click();
    await page.getByRole('button', { name: /^book/i }).last().click();
    // The booked parcel's tracking id replaces the Book courier button.
    await expect(page.getByRole('button', { name: 'ID: TRK-ord-verify' })).toBeVisible();
    // One refused attempt while held, then exactly one successful booking.
    expect(fixture.bookings).toEqual(['ord-verify', 'ord-verify']);
    expect(fixture.unexpected).toEqual([]);
  });

  test('journey 9: MANUAL_REVIEW needs the owner — staff see guidance, not an approve button', async ({ page }) => {
    await setup(page, { role: 'staff' });
    await signInAndOpen(page, '/orders');
    await openOrder(page, 'ORD-201');
    const panel = page.getByTestId('order-confidence-panel');
    await expect(panel.getByTestId('order-confidence-decision')).toHaveText('Needs owner review');
    await expect(panel.getByTestId('order-confidence-approve-help')).toBeVisible();
    await expect(panel.getByTestId('order-confidence-submit')).toHaveCount(0);
  });

  test('journey 9: an owner approves MANUAL_REVIEW with a written reason', async ({ page }) => {
    const fixture = await setup(page, { role: 'owner' });
    await signInAndOpen(page, '/orders');
    await openOrder(page, 'ORD-201');
    const panel = page.getByTestId('order-confidence-panel');
    const submit = panel.getByTestId('order-confidence-submit');
    await expect(submit).toBeDisabled();
    await panel.getByRole('textbox').fill('Called the customer, address confirmed');
    await submit.click();
    await expect(panel.getByTestId('order-confidence-decision')).toHaveText('Cleared for booking');
    expect(fixture.approveCalls).toEqual([{ decision_version: 2, note: 'Called the customer, address confirmed' }]);
  });
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('customers render as cards without horizontal overflow on a phone', async ({ page }) => {
    await setup(page);
    await signInAndOpen(page, '/customers');
    const list = page.getByTestId('customer-list-mobile');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Rahim Uddin');
    await expect(page.getByTestId('customer-table')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
