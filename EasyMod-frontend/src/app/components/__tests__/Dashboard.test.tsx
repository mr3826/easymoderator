/**
 * Dashboard — cash-position section (TDD: failing until Task 6 adds the UI)
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../Dashboard';
import { apiClient } from '@/api';

// ── Mock the API client (same path Dashboard.tsx uses: @/api) ─────────────────
vi.mock('@/api', () => ({
  apiClient: {
    getSetupStatus: vi.fn(),
    getDashboardMetrics: vi.fn(),
    getDashboardQueue: vi.fn(),
    getOrders: vi.fn(),
    getConversations: vi.fn(),
  },
}));

// ── Mock react-i18next (t returns the key so we can match translation keys) ───
// `t` MUST be identity-stable across renders. Dashboard wraps refreshPulse in
// useCallback([t]) and runs its data-loading effect on [refreshPulse]; a fresh
// `t` each render would recreate refreshPulse, re-fire the effect, and flicker
// the component back to its loading state — which made this test flaky. Real
// react-i18next returns a stable `t`, so we mirror that with vi.hoisted.
// Returns the key (so tests can match translation keys), and appends any
// interpolation values (e.g. {count}) so count-bearing labels still surface
// their numbers — the component interpolates via t('...ordersUnit', {count}).
const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === 'object') {
      const vals = Object.values(opts).filter((v) => v != null).join(' ');
      if (vals) return `${key} ${vals}`;
    }
    return key;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

// ── Mock sonner so toast calls don't throw ────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// ── Helper ────────────────────────────────────────────────────────────────────
function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

// ── Shared queue / orders baseline (no cash-position data) ───────────────────
const baseQueue = {
  unread_count: 0,
  pending_payment_count: 0,
  ready_to_dispatch_count: 0,
  at_risk_orders: [],
};

const completeSetupStatus = {
  isComplete: true,
  completedCount: 4,
  totalCount: 4,
  progressPercent: 100,
  tasks: [],
  counts: {
    connectedFacebookPages: 1,
    webhookVerifiedFacebookPages: 1,
    activeProducts: 3,
    activeFaqs: 1,
    knowledgeDocuments: 0,
  },
  generatedAt: '2026-07-04T00:00:00.000Z',
};

describe('Dashboard — cash position section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
    vi.mocked(apiClient.getSetupStatus).mockResolvedValue(completeSetupStatus as never);
    vi.mocked(apiClient.getDashboardQueue).mockResolvedValue(baseQueue as never);
    vi.mocked(apiClient.getOrders).mockResolvedValue([] as never);
    vi.mocked(apiClient.getConversations).mockResolvedValue({
      data: [], total: 0, page: 1, pageSize: 100, ai_reply_mode: 'MANUAL',
    } as never);
    vi.mocked(apiClient.getConversations).mockResolvedValue({
      data: [], total: 0, page: 1, pageSize: 100, ai_reply_mode: 'MANUAL',
    } as never);
  });

  it('renders both cash-position cards when backend returns cashPosition', async () => {
    vi.mocked(apiClient.getDashboardMetrics).mockResolvedValue({
      metrics: {
        totalMessages: 0,
        activeProducts: 0,
        ordersToday: 0,
        ordersInPeriod: 0,
        conversionRate: 0,
        weeklyChange: 0,
      },
      channels: { active: 0, total: 0 },
      analytics: null,
      period: 30,
      cashPosition: {
        inTransit: { amount: 12500, count: 7 },
        atRisk:    { amount: 3400,  count: 2, windowDays: 30 },
      },
    } as never);

    renderDashboard();

    await waitFor(() => {
      // "courier in transit" card label
      expect(screen.getByText(/cashPosition\.inTransit\b/)).toBeInTheDocument();
    });

    // "at risk / returns incoming" card label
    expect(screen.getByText(/cashPosition\.atRisk\b/)).toBeInTheDocument();

    // Count values are scoped to their respective cash-position cards.
    expect(screen.getByText('dashboard.pulse.cashPosition.inTransit').closest('section')).toHaveTextContent(/\b7\b/);
    expect(screen.getByText('dashboard.pulse.cashPosition.atRisk').closest('section')).toHaveTextContent(/\b2\b/);

    // D5-2: the figures are order-status derived, and the card says so next to
    // them instead of implying settled cash.
    expect(screen.getByText('dashboard.pulse.cashPosition.derivationNote')).toBeInTheDocument();
  });

  it('renders first-time setup instead of loading pulse data while setup is incomplete', async () => {
    vi.mocked(apiClient.getSetupStatus).mockResolvedValueOnce({
      ...completeSetupStatus,
      isComplete: false,
      completedCount: 1,
      progressPercent: 20,
      tasks: [
        {
          key: 'connect_channel',
          title: 'Connect Facebook Page',
          description: 'Connect a page',
          status: 'incomplete',
          required: true,
          ctaLabel: 'Manage channel',
          href: '/manage-shop/chat-settings',
          missing: [],
          warnings: [],
          meta: {},
        },
      ],
    } as never);
    window.localStorage.removeItem('easymod:business-setup:default:complete-dismissed');

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('dashboard.setup.title')).toBeInTheDocument();
    });

    expect(apiClient.getDashboardMetrics).not.toHaveBeenCalled();
    expect(apiClient.getDashboardQueue).not.toHaveBeenCalled();
    expect(apiClient.getOrders).not.toHaveBeenCalled();
    expect(apiClient.getConversations).not.toHaveBeenCalled();
  });

  it('renders unavailable cash when backend omits cashPosition instead of inventing zero', async () => {
    vi.mocked(apiClient.getDashboardMetrics).mockResolvedValue({
      metrics: {
        totalMessages: 0,
        activeProducts: 0,
        ordersToday: 0,
        ordersInPeriod: 0,
        conversionRate: 0,
        weeklyChange: 0,
      },
      channels: { active: 0, total: 0 },
      analytics: null,
      period: 30,
      // cashPosition deliberately absent — backwards compat
    } as never);

    renderDashboard();

    // Section remains visible, but missing backend values are not reported as zero cash.
    await waitFor(() => {
      expect(screen.getByText(/cashPosition\.inTransit\b/)).toBeInTheDocument();
    });
    expect(screen.getAllByText('dashboard.pulse.cashPosition.unavailable')).toHaveLength(2);
  });
});
