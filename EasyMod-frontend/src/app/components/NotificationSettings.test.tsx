import '@testing-library/jest-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import NotificationSettings from './NotificationSettings';

const {
  mockGetTelegramNotificationStatus,
  mockCreateTelegramConnectIntent,
  mockSendTelegramTestAlert,
  mockUpdateTelegramPreferences,
  mockDisconnectTelegramAlerts,
  mockSubscribeToPush,
  mockGetPushPermission,
} = vi.hoisted(() => ({
  mockGetTelegramNotificationStatus: vi.fn(),
  mockCreateTelegramConnectIntent: vi.fn(),
  mockSendTelegramTestAlert: vi.fn(),
  mockUpdateTelegramPreferences: vi.fn(),
  mockDisconnectTelegramAlerts: vi.fn(),
  mockSubscribeToPush: vi.fn(),
  mockGetPushPermission: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, vars?: Record<string, string>) => vars?.name ? `${key}:${vars.name}` : key }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    AlertCircle: Icon,
    Bell: Icon,
    CheckCircle2: Icon,
    Copy: Icon,
    Loader2: Icon,
    RefreshCw: Icon,
    Send: Icon,
    Smartphone: Icon,
    Trash2: Icon,
    // Harness-only: the redesign composes kit components (PageHeader,
    // ResultBanner) whose icons must resolve under this mock.
    ChevronRight: Icon,
    Clock4: Icon,
    OctagonX: Icon,
    BadgeCheck: Icon,
    Eye: Icon,
    TriangleAlert: Icon,
  };
});

vi.mock('@/api/domains/notification', () => ({
  getTelegramNotificationStatus: mockGetTelegramNotificationStatus,
  createTelegramConnectIntent: mockCreateTelegramConnectIntent,
  sendTelegramTestAlert: mockSendTelegramTestAlert,
  updateTelegramPreferences: mockUpdateTelegramPreferences,
  disconnectTelegramAlerts: mockDisconnectTelegramAlerts,
  // Harness-only: the redesign reads the shop name via authService, which
  // loads the api barrel; the barrel re-exports the whole domain surface.
  getInAppNotifications: vi.fn(async () => []),
  markInAppNotificationRead: vi.fn(async () => undefined),
}));

vi.mock('../lib/pushNotification', () => ({
  getPushPermission: mockGetPushPermission,
  subscribeToPush: mockSubscribeToPush,
}));

const disconnectedStatus = {
  configured: true,
  botUsername: 'EasyModBot',
  suggestedGroupName: 'Sapna Fashion Alerts',
  status: 'disconnected',
  enabled: false,
  connected: false,
  chatTitle: null,
  chatType: null,
  lastError: null,
  lastTestedAt: null,
  lastSentAt: null,
  connectedAt: null,
  disconnectedAt: null,
  connectionExpiresAt: null,
  preferences: { new_order: true },
  events: [{ eventType: 'new_order', label: 'New order', labelBn: 'নতুন অর্ডার', enabled: true }],
};

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPushPermission.mockReturnValue('default');
    mockSubscribeToPush.mockResolvedValue(true);
    mockGetTelegramNotificationStatus.mockResolvedValue(disconnectedStatus);
    mockCreateTelegramConnectIntent.mockResolvedValue({
      ...disconnectedStatus,
      status: 'pending',
      pendingCommand: '/easymod_connect token',
      instructions: ['Create group', 'Add bot', 'Send command'],
    });
    mockUpdateTelegramPreferences.mockResolvedValue(disconnectedStatus);
    mockSendTelegramTestAlert.mockResolvedValue({ sent: true });
    mockDisconnectTelegramAlerts.mockResolvedValue({ ...disconnectedStatus });
  });

  it('renders the day-one notification channels', async () => {
    render(<NotificationSettings />);

    await waitFor(() => expect(mockGetTelegramNotificationStatus).toHaveBeenCalled());

    expect(screen.getByText('manageShop.notifications.browser.title')).toBeInTheDocument();
    expect(screen.getByText('manageShop.notifications.inApp.title')).toBeInTheDocument();
    expect(screen.getByText('manageShop.notifications.telegram.title')).toBeInTheDocument();
  });

  it('creates and shows a Telegram connect command', async () => {
    render(<NotificationSettings />);

    await screen.findByText('manageShop.notifications.telegram.connect');
    fireEvent.click(screen.getByText('manageShop.notifications.telegram.connect'));

    await waitFor(() => expect(mockCreateTelegramConnectIntent).toHaveBeenCalled());
    expect(await screen.findByText('/easymod_connect token')).toBeInTheDocument();
  });

  it('enables browser notifications through the push helper', async () => {
    render(<NotificationSettings />);

    fireEvent.click(await screen.findByText('manageShop.notifications.browser.enable'));

    await waitFor(() => expect(mockSubscribeToPush).toHaveBeenCalled());
  });
});
