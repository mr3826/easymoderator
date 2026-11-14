import { expect, test, type Page } from '@playwright/test';

/**
 * Truth-gate E2E — A3 (enforce = DOM absence) and A4 (shadow = renders).
 *
 * The page under test is the real public /pricing surface, which mounts the
 * real <ClaimProvider surface="pricing"> and <Claim> nodes. Only the network is
 * mocked, so these assertions exercise the shipped component contract:
 *
 *   render:'none'  => no [data-claim-id] node exists at all (DOM ABSENCE,
 *                     not a hidden/CSS state)
 *   render:'claim' => the node renders with data-contract-version="1.0.0"
 *
 * A4 asserts the client half of shadow mode: a would-block decision still
 * renders. The server half — the truth_gate.shadow_would_block log line and
 * metric increment in claim-gate.service — is pinned by the backend unit lane
 * (EasyMod-backend/src/modules/commercial/__tests__/claim-gate.service.test.js).
 */

const CONTRACT_VERSION = '1.0.0';
const CONTRACT_HASH = `sha256:${'b'.repeat(64)}`;
const REGISTRY_HASH = `sha256:${'a'.repeat(64)}`;

type Surface = 'pricing' | 'landing';

interface DecisionOverrides {
  claimId: string;
  available: boolean;
  render: 'claim' | 'fallback' | 'none';
  textKey: string | null;
  mode: 'off' | 'shadow' | 'enforce';
  wouldBlock: boolean;
  productionVerified?: boolean;
}

function claimDecision(surface: Surface, o: DecisionOverrides) {
  return {
    claimId: o.claimId,
    available: o.available,
    render: o.render,
    textKey: o.textKey,
    locale: 'en',
    surface,
    scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
    interpolation: {},
    mode: o.mode,
    predicate: {
      code_present: true,
      merchant_enabled: true,
      production_verified: o.productionVerified ?? true,
      deprecated: false,
      internal_only: false,
      scope_match: true,
    },
    wouldBlock: o.wouldBlock,
    contractVersion: CONTRACT_VERSION,
    registryHash: REGISTRY_HASH,
  };
}

const publicContract = {
  contract_version: CONTRACT_VERSION,
  contract_hash: CONTRACT_HASH,
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
    blockCourierBooking: true,
    pauseAutomatedAi: true,
    keepInboxReadable: true,
    keepHistoryReadable: true,
    deleteData: false,
  },
  description: {
    en: 'Pay BDT 10.00 per provider-confirmed delivered order.',
    bn: 'প্রতি প্রোভাইডার-নিশ্চিত ডেলিভারি অর্ডারে ৳১০.০০ দিন।',
  },
  registry_hash: REGISTRY_HASH,
  claims: [
    {
      id: 'billing.delivered_order',
      verified_scope: 'global',
      surfaces: ['pricing', 'landing'],
      i18n_key: { en: 'claims.billing.delivered_order.en', bn: 'claims.billing.delivered_order.bn' },
      fallback_i18n_key: null,
    },
    {
      id: 'courier.pathao.booking_live',
      verified_scope: 'courier:pathao',
      surfaces: ['pricing', 'landing'],
      i18n_key: { en: 'claims.courier.pathao.booking_live.en', bn: 'claims.courier.pathao.booking_live.bn' },
      fallback_i18n_key: {
        en: 'claims.courier.pathao.booking_live.fallback.en',
        bn: 'claims.courier.pathao.booking_live.fallback.bn',
      },
    },
  ],
};

const addons = [
  {
    code: 'ADS_STUDIO',
    name: 'EasyModerator Ads Studio',
    category: 'advertising',
    availability: 'pilot_approval_required',
    billing_terms: 'not_activated',
    price_bdt_monthly: null,
    summary: 'Import a Meta Ads CSV report and save an explicitly approved draft.',
    limits: ['No direct Meta Ads account connection is claimed.'],
  },
  {
    code: 'STOREFRONT',
    name: 'EasyModerator Storefront',
    category: 'commerce',
    availability: 'pilot_approval_required',
    billing_terms: 'not_activated',
    price_bdt_monthly: null,
    summary: 'Publish selected products and receive validated COD orders.',
    limits: ['COD only; no online payment verification or courier automation is claimed.'],
  },
];

interface MockOptions {
  decisions: Partial<Record<Surface, ReturnType<typeof claimDecision>[]>>;
  onClaimsRequest?: (surface: string | null) => void;
}

/** Mock every API call the public pricing surface makes. */
async function mockCommercialApi(page: Page, { decisions, onClaimsRequest }: MockOptions) {
  const cors = (request: { headers: () => Record<string, string>; url: () => string }) => {
    const url = new URL(request.url());
    return {
      'access-control-allow-origin': request.headers().origin ?? url.origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-CSRF-Token,Idempotency-Key',
    };
  };

  // Match on the pathname, not a glob: `**/api/**` also catches Vite module
  // URLs such as /src/api/index.ts and would serve them as JSON.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = cors(request);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });

    if (url.pathname === '/api/csrf') return json(200, { csrfToken: 'truth-gate-csrf' });
    if (url.pathname === '/api/auth/me') {
      return json(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'No session' } });
    }
    if (url.pathname === '/api/public/commercial-contract') {
      return json(200, { success: true, data: publicContract });
    }
    if (url.pathname === '/api/public/addons') {
      return json(200, { success: true, data: addons });
    }
    if (url.pathname === '/api/commercial/claims') {
      const surface = url.searchParams.get('surface') as Surface | null;
      onClaimsRequest?.(surface);
      const surfaceDecisions = surface && decisions[surface] ? decisions[surface]! : [];
      return json(200, {
        success: true,
        data: {
          surface,
          locale: url.searchParams.get('locale') ?? 'en',
          contractVersion: CONTRACT_VERSION,
          registryHash: REGISTRY_HASH,
          decisions: surfaceDecisions,
        },
      });
    }
    if (url.pathname === '/api/analytics/funnel') return json(200, { success: true, data: {} });
    return json(200, { success: true, data: {} });
  });

  await page.route('https://api.easymod.tech/**', (route) => route.abort('blockedbyclient'));
  await page.route('https://app.easymod.tech/**', (route) => route.abort('blockedbyclient'));
}

test.describe('truth-gate claims on the public pricing surface', () => {
  test('A3 enforce: an unavailable claim produces NO DOM node, an available claim renders versioned copy', async ({ page }) => {
    await mockCommercialApi(page, {
      decisions: {
        pricing: [
          // Courier booking is implemented but never live-verified: enforce
          // must suppress the node entirely (fail-closed), not grey it out.
          claimDecision('pricing', {
            claimId: 'courier.pathao.booking_live',
            available: false,
            render: 'none',
            textKey: null,
            mode: 'enforce',
            wouldBlock: false,
            productionVerified: false,
          }),
          // The delivered-order price claim is backed by the frozen contract.
          claimDecision('pricing', {
            claimId: 'billing.delivered_order',
            available: true,
            render: 'claim',
            textKey: 'claims.billing.delivered_order.en',
            mode: 'enforce',
            wouldBlock: false,
          }),
        ],
      },
    });

    await page.goto('/pricing?lang=en');

    // Contract-gated offer proves the surface mounted and resolved the payload.
    await expect(page.locator('[data-testid="commercial-unit-price"]')).toHaveText('৳10.00');

    // A3: absence is a DOM fact. Not a hidden node, not a CSS class.
    const suppressed = page.locator('[data-claim-id="courier.pathao.booking_live"]');
    await expect(suppressed).toHaveCount(0);
    expect(await suppressed.count()).toBe(0);

    const available = page.locator('[data-claim-id="billing.delivered_order"]');
    await expect(available).toHaveCount(1);
    await expect(available).toBeVisible();
    await expect(available).toHaveAttribute('data-claim-render', 'claim');
    await expect(available).toHaveAttribute('data-claim-mode', 'enforce');
    await expect(available).toHaveAttribute('data-contract-version', CONTRACT_VERSION);
    await expect(available).toContainText(/delivered order/i);
  });

  test('A4 shadow: a would-block decision still renders so the human sees the promise', async ({ page }) => {
    const requestedSurfaces: Array<string | null> = [];
    await mockCommercialApi(page, {
      onClaimsRequest: (surface) => requestedSurfaces.push(surface),
      decisions: {
        pricing: [
          claimDecision('pricing', {
            claimId: 'courier.pathao.booking_live',
            available: false,
            render: 'claim',
            textKey: 'claims.courier.pathao.booking_live.en',
            mode: 'shadow',
            wouldBlock: true,
            productionVerified: false,
          }),
        ],
      },
    });

    await page.goto('/pricing?lang=en');
    await expect(page.locator('[data-testid="commercial-unit-price"]')).toHaveText('৳10.00');

    const shadowed = page.locator('[data-claim-id="courier.pathao.booking_live"]');
    await expect(shadowed).toHaveCount(1);
    await expect(shadowed).toBeVisible();
    await expect(shadowed).toHaveAttribute('data-claim-mode', 'shadow');
    await expect(shadowed).toHaveAttribute('data-claim-render', 'claim');
    await expect(shadowed).toHaveAttribute('data-contract-version', CONTRACT_VERSION);
    await expect(shadowed).toContainText(/Pathao/i);

    // The decision set was requested for the surface the node belongs to.
    expect(requestedSurfaces).toContain('pricing');
  });
});