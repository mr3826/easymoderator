import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmergencyStopCard from '@/app/components/channels/EmergencyStopCard';

const shopApi = vi.hoisted(() => ({
  getShopAISettings: vi.fn(),
  emergencyStop: vi.fn(),
  emergencyResume: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getCurrentShop: vi.fn() }));

vi.mock('@/api/domains/shop', () => shopApi);
vi.mock('@/app/lib/auth', () => ({ authService: auth }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const settings = (over: Record<string, unknown> = {}) => ({
  automation_mode: 'MANUAL',
  confidence_threshold: 80,
  emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
  ...over,
});

const renderCard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EmergencyStopCard />
    </QueryClientProvider>,
  );
};

describe('EmergencyStopCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getCurrentShop.mockReturnValue({ role: 'owner' });
    shopApi.getShopAISettings.mockResolvedValue(settings());
    shopApi.emergencyStop.mockResolvedValue({
      active: true,
      at: new Date().toISOString(),
      by: 'owner-1',
      source: 'merchant',
      prior_mode: 'DRAFT',
      already_active: false,
    });
    shopApi.emergencyResume.mockResolvedValue({
      active: false,
      automation_mode: 'MANUAL',
      prior_mode: 'DRAFT',
      already_inactive: false,
    });
  });

  it('confirms before stopping and uses the honest stop copy', async () => {
    renderCard();
    const stop = await screen.findByTestId('emergency-stop-button');
    fireEvent.click(stop);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Stops AI replies. Your team can still reply. Messages already being delivered may complete.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Yes, stop AI replies/i }));
    await waitFor(() => expect(shopApi.emergencyStop).toHaveBeenCalledTimes(1));
  });

  it('shows the active banner and resumes with the prior mode kept visible', async () => {
    shopApi.getShopAISettings.mockResolvedValue(
      settings({
        emergency_stop: {
          active: true,
          at: new Date().toISOString(),
          by: 'owner-1',
          source: 'merchant',
          prior_mode: 'DRAFT',
        },
      }),
    );
    renderCard();

    expect(await screen.findByTestId('emergency-stop-banner')).toHaveTextContent(
      'AI replies are stopped',
    );
    fireEvent.click(screen.getByTestId('emergency-resume-button'));
    await waitFor(() => expect(shopApi.emergencyResume).toHaveBeenCalledTimes(1));
  });

  it('blocks merchant resume of an admin-source stop', async () => {
    shopApi.getShopAISettings.mockResolvedValue(
      settings({
        emergency_stop: {
          active: true,
          at: new Date().toISOString(),
          by: 'admin-1',
          source: 'admin',
          prior_mode: 'AUTO',
        },
      }),
    );
    renderCard();

    const resume = await screen.findByTestId('emergency-resume-button');
    expect(resume).toBeDisabled();
    expect(screen.getByText(/Only EasyModerator support can resume/i)).toBeInTheDocument();
  });

  it('is read-only for a manager with an accurate reason', async () => {
    auth.getCurrentShop.mockReturnValue({ role: 'manager' });
    renderCard();

    await screen.findByText(/Only the shop owner can change the emergency stop/i);
    expect(screen.queryByTestId('emergency-stop-button')).not.toBeInTheDocument();
  });
});