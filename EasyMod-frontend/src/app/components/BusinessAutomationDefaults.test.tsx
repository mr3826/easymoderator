import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessAutomationDefaults from './BusinessAutomationDefaults';

// Resolve real English from en.json so assertions verify the actual (en-default)
// copy, including the claim-registry text rendered through <Claim>.
vi.mock('react-i18next', async () => {
  const en = (await import('@/i18n/locales/en.json')).default as Record<string, any>;
  const t = (key: string, opts?: any) => {
    const v = key.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), en);
    if (typeof v !== 'string') return typeof opts === 'string' ? opts : key;
    if (opts && typeof opts === 'object') {
      return Object.entries(opts).reduce(
        (s, [k, val]) => s.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(val)),
        v,
      );
    }
    return v;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }) };
});

const { mockGetShopAISettings, mockUpdateShopAISettings, mockGetTelegramStatus, mockGetCurrentShop } = vi.hoisted(() => ({
  mockGetShopAISettings: vi.fn(),
  mockUpdateShopAISettings: vi.fn(),
  mockGetTelegramStatus: vi.fn(),
  mockGetCurrentShop: vi.fn(),
}));

vi.mock('@/api', () => ({
  apiClient: {
    getShopAISettings: mockGetShopAISettings,
    updateShopAISettings: mockUpdateShopAISettings,
    getTelegramNotificationStatus: mockGetTelegramStatus,
  },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: mockGetCurrentShop,
  },
}));

vi.mock('@/api/domains/commercialContract', () => {
  const decision = (claimId: string, textKey: string) => ({
    claimId,
    available: false,
    render: 'fallback' as const,
    textKey,
    locale: 'en' as const,
    surface: 'subscription' as const,
    scope: { claimedProviders: null, verifiedProviders: null, match: false, text: null },
    interpolation: {},
    mode: 'shadow' as const,
    predicate: {
      code_present: true,
      merchant_enabled: false,
      production_verified: false,
      deprecated: false,
      internal_only: false,
      scope_match: false,
    },
    wouldBlock: false,
    contractVersion: '1.0.0',
    registryHash: 'hash',
  });
  return {
    useClaimDecisions: () => ({
      data: {
        surface: 'subscription',
        locale: 'en',
        contractVersion: '1.0.0',
        registryHash: 'hash',
        decisions: [
          decision('billing.overdue_policy', 'claims.billing.overdue_policy.en'),
          decision('ai.draft_reply', 'claims.ai.draft_reply.fallback.en'),
          decision('ai.auto_reply', 'claims.ai.auto_reply.fallback.en'),
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock('lucide-react', () => ({
  ArrowLeft: () => null,
  CircleIcon: () => null,
  Plus: () => null,
  X: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
}));

// The emergency stop card is a react-query consumer with its own dedicated
// suite (channels/__tests__/EmergencyStopCard.test.tsx). Mock it here so the
// page test stays focused on hosting the defaults form + the slot.
vi.mock('./channels/EmergencyStopCard', () => ({
  default: () => <div data-testid="emergency-stop-card-mock" />,
}));

const mockAISettings = {
  automation_mode: 'DRAFT',
  confidence_threshold: 75,
  auto_reply_enabled: false,
  max_auto_order_value: 5000,
  ask_email: false,
  primary_language: 'mixed',
  required_fields: {
    customer_name: true,
    mobile_number: true,
    delivery_address: true,
    payment_method: true,
    email_address: false,
    special_instructions: false,
  },
  handoff_settings: {
    trigger_keywords: ['complain', 'problem'],
    notification_channel: 'in_app',
    cooldown_minutes: 30,
  },
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <BusinessAutomationDefaults />
    </MemoryRouter>,
  );

describe('BusinessAutomationDefaults', () => {
  beforeEach(() => {
    mockGetShopAISettings.mockReset().mockResolvedValue(mockAISettings);
    mockGetTelegramStatus.mockReset().mockResolvedValue({ status: 'connected', connected: true });
    mockUpdateShopAISettings.mockReset().mockResolvedValue(mockAISettings);
    mockGetCurrentShop.mockReset().mockReturnValue({ role: 'owner' });
  });

  it('hosts the existing reply-settings form (ai-reply-mode kept)', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('ai-reply-mode')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-reply-mode-draft')).toHaveAttribute('aria-checked', 'true');
  });

  it('mounts the emergency stop card into the slot', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('emergency-stop-slot')).toBeInTheDocument();
    });
    expect(screen.getByTestId('emergency-stop-card-mock')).toBeInTheDocument();
  });

  it('renders the billing standing copy from the claim registry', async () => {
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/If a bill is overdue, new courier bookings are blocked/i),
      ).toBeInTheDocument();
    });
  });

  it('renders AUTO/DRAFT capability copy from the claim registry', async () => {
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/AI draft replies are implemented; production verification is pending/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Automated AI replies have not been proven live/i),
      ).toBeInTheDocument();
    });
  });

  it('saves business defaults through updateShopAISettings', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('ai-reply-mode')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-reply-mode-auto'));
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));

    await waitFor(() => {
      expect(mockUpdateShopAISettings).toHaveBeenCalledWith(expect.objectContaining({
        automation_mode: 'AUTO',
        auto_reply_enabled: true,
      }));
    });
  });

  it('disables the automation form and explains why while the emergency stop is active', async () => {
    mockGetShopAISettings.mockResolvedValue({
      ...mockAISettings,
      emergency_stop: {
        active: true,
        at: '2026-11-15T00:00:00.000Z',
        by: 'user-1',
        source: 'merchant',
        prior_mode: 'DRAFT',
      },
    });
    renderPage();

    const notice = await screen.findByTestId('automation-emergency-stop-notice');
    expect(notice).toHaveTextContent(/locked to Manual until the emergency stop is resumed/i);
    expect(screen.getByTestId('automation-settings-fieldset')).toBeDisabled();
    // The stop card itself stays usable so the owner can resume.
    expect(screen.getByTestId('emergency-stop-card-mock')).toBeInTheDocument();
  });

  it('shows a read-only notice for non-owners and disables writes', async () => {
    mockGetCurrentShop.mockReturnValue({ role: 'manager' });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/Only the shop owner can change automation defaults/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save Reply Settings/i })).toBeDisabled();
  });
});