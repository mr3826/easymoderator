/**
 * Channels-workspace guardrails contracts (§8/§17/§18/§29): workspace signal
 * matrix, execution header without CTA, and the emergency-stop confirm dialog
 * focus trap + Escape + labelled semantics. Additive suite (real i18n en); the
 * legacy channels suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChannelsOverview from '../ChannelsOverview';
import EmergencyStopCard from '../EmergencyStopCard';
import { deriveChannelsSignal } from '../derive';
import { listMetaChannels } from '@/api/domains/meta-channels';
import { getShopAISettings } from '@/api/domains/shop';

vi.mock('@/api/domains/meta-channels', () => ({
  listMetaChannels: vi.fn(),
  channelQueryKeys: { list: () => ['channels'], settings: (id: string) => ['channel-settings', id] },
}));

vi.mock('@/api/domains/shop', () => ({
  getShopAISettings: vi.fn(),
  emergencyStop: vi.fn(),
  emergencyResume: vi.fn(),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: vi.fn(() => ({ id: 'shop-1', role: 'owner', shop_name: 'Test Shop' })),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const channelRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  platform: 'facebook',
  status: 'CONNECTED',
  isHealthy: true,
  needsReconnect: false,
  displayName: 'Inherited Page',
  metaAssetId: 'p1',
  effective_mode: 'DRAFT',
  mode_source: 'business_default',
  override_count: 0,
  emergency_stop: { active: false },
  billing_ai_active: true,
  ...overrides,
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMetaChannels).mockResolvedValue([] as never);
  vi.mocked(getShopAISettings).mockResolvedValue({ automation_mode: 'DRAFT', emergency_stop: { active: false } } as never);
});

describe('workspace signal derivation', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${key}:${opts.count}` : key);
  it('maps error / loading / stopped / connected / empty to distinct signals', () => {
    expect(deriveChannelsSignal({ phase: 'error', connectedCount: 0, stopActive: false }, t).kind).toBe('blocked');
    expect(deriveChannelsSignal({ phase: 'loading', connectedCount: 0, stopActive: false }, t).kind).toBe('pending');
    expect(deriveChannelsSignal({ phase: 'ready', connectedCount: 1, stopActive: true }, t).kind).toBe('attention');
    expect(deriveChannelsSignal({ phase: 'ready', connectedCount: 1, stopActive: true }, t).label).toContain('stopped');
    expect(deriveChannelsSignal({ phase: 'ready', connectedCount: 2, stopActive: false }, t).kind).toBe('healthy');
    expect(deriveChannelsSignal({ phase: 'ready', connectedCount: 0, stopActive: false }, t).kind).toBe('attention');
  });
});

describe('execution header', () => {
  it('shows title + signal + factual pills and no header CTA when empty', async () => {
    renderWithClient(<ChannelsOverview />);
    await waitFor(() => expect(screen.getByTestId('channels-signal').textContent).toContain('Needs a channel'));
    expect(screen.getByRole('heading', { level: 1, name: 'Channels & Automation' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Connected:/)).toBeInTheDocument();
    expect(screen.getByText(/Overrides:/)).toBeInTheDocument();
  });

  it('reports connected channels and a stopped workspace honestly', async () => {
    vi.mocked(listMetaChannels).mockResolvedValue([channelRow()] as never);
    const { unmount } = renderWithClient(<ChannelsOverview />);
    await waitFor(() => expect(screen.getByTestId('channels-signal').textContent).toContain('Channels connected'));
    unmount();

    vi.mocked(listMetaChannels).mockResolvedValue([channelRow({ emergency_stop: { active: true } })] as never);
    renderWithClient(<ChannelsOverview />);
    await waitFor(() => expect(screen.getByTestId('channels-signal').textContent).toContain('AI replies stopped'));
  });
});

describe('emergency-stop confirm dialog', () => {
  it('is labelled, traps focus, and closes on Escape', async () => {
    renderWithClient(<EmergencyStopCard />);
    const stop = await screen.findByTestId('emergency-stop-button');
    fireEvent.click(stop);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'emergency-stop-confirm-title');
    expect(screen.getByText('Stop all AI replies?')).toBeInTheDocument();
    // Focus moves into the dialog on open (first focusable = Cancel).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders the active stop banner as an alert with a resume control', async () => {
    vi.mocked(getShopAISettings).mockResolvedValue({ automation_mode: 'MANUAL', emergency_stop: { active: true, source: 'merchant', prior_mode: 'AUTO' } } as never);
    renderWithClient(<EmergencyStopCard />);
    const banner = await screen.findByTestId('emergency-stop-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('AI replies are stopped');
    expect(screen.getByTestId('emergency-resume-button')).toBeInTheDocument();
  });
});
