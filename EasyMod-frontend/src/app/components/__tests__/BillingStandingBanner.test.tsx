import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ClaimDecision } from '@/api/types/commercial';
import BillingStandingBanner from '../BillingStandingBanner';

const { mockUseClaimDecisions, translations } = vi.hoisted(() => ({
  mockUseClaimDecisions: vi.fn(),
  translations: {
    'billingStanding.title': 'Billing standing',
    'billingStanding.manage': 'View billing',
    'billingStanding.dismiss': 'Dismiss billing notice',
    'claims.billing.overdue_policy.en':
      'If a bill is overdue, new courier bookings are blocked and automated replies pause. Your inbox and history stay readable, and nothing is deleted.',
  } as Record<string, string>,
}));

vi.mock('@/api/domains/commercialContract', () => ({
  useClaimDecisions: mockUseClaimDecisions,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (translations[key]) return translations[key];
      if (typeof options === 'string') return options;
      return key;
    },
  }),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: { getCurrentShopId: vi.fn().mockReturnValue('shop-1') },
}));

const REGISTRY_HASH = `sha256:${'b'.repeat(64)}`;

const overdueDecision = (overrides: Partial<ClaimDecision> = {}): ClaimDecision => ({
  claimId: 'billing.overdue_policy',
  available: true,
  render: 'claim',
  textKey: 'claims.billing.overdue_policy.en',
  locale: 'en',
  surface: 'usage-banner',
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
  interpolation: {},
  mode: 'enforce',
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: true,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: '1.0.0',
  registryHash: REGISTRY_HASH,
  ...overrides,
});

function renderBanner() {
  return render(
    <MemoryRouter>
      <BillingStandingBanner />
    </MemoryRouter>,
  );
}

describe('BillingStandingBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockUseClaimDecisions.mockReturnValue({
      data: { surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: REGISTRY_HASH, decisions: [overdueDecision()] },
      isLoading: false,
      error: null,
    });
  });

  it('renders the overdue policy from the claim registry, not a metered quota alert', () => {
    renderBanner();

    expect(screen.getByTestId('billing-standing-banner')).toBeInTheDocument();
    expect(screen.getByText(translations['claims.billing.overdue_policy.en'])).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View billing' })).toHaveAttribute('href', '/subscription');
    expect(screen.queryByText(/conversation/i)).not.toBeInTheDocument();
  });

  it('renders nothing when the claim cannot be evaluated (fail-closed)', () => {
    mockUseClaimDecisions.mockReturnValue({
      data: { surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: REGISTRY_HASH, decisions: [] },
      isLoading: false,
      error: null,
    });

    renderBanner();

    expect(screen.queryByTestId('billing-standing-banner')).not.toBeInTheDocument();
  });

  it('dismisses for the shop for the rest of the session', () => {
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss billing notice' }));

    expect(screen.queryByTestId('billing-standing-banner')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('billing-standing:shop-1')).toBe('dismissed');
  });
});