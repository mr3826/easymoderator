/**
 * Notification-channel guardrails contracts (§8/§16/§17 + header-removal
 * C1/C6): compact page title with no signal band, per-panel contextual status
 * (the relocated indicator coverage), connect-command flow, switch semantics
 * with optimistic rollback, destructive disconnect confirmation, browser
 * enable disabled states. Additive suite; NotificationSettings.test.tsx
 * unchanged except harness mock surface.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NotificationSettings from '../NotificationSettings';
import {
  createTelegramConnectIntent,
  disconnectTelegramAlerts,
  getTelegramNotificationStatus,
  sendTelegramTestAlert,
  updateTelegramPreferences,
} from '@/api/domains/notification';
import { getPushPermission, subscribeToPush } from '../../lib/pushNotification';
import type { TelegramNotificationStatus } from '@/api/types/notification';

vi.mock('@/api/domains/notification', () => ({
  getTelegramNotificationStatus: vi.fn(),
  createTelegramConnectIntent: vi.fn(),
  sendTelegramTestAlert: vi.fn(),
  updateTelegramPreferences: vi.fn(),
  disconnectTelegramAlerts: vi.fn(),
  getInAppNotifications: vi.fn(async () => []),
  markInAppNotificationRead: vi.fn(async () => undefined),
}));
vi.mock('../../lib/pushNotification', () => ({
  getPushPermission: vi.fn(),
  subscribeToPush: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const status = (overrides: Partial<TelegramNotificationStatus> = {}): TelegramNotificationStatus => ({
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
  ...overrides,
} as TelegramNotificationStatus);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPushPermission).mockReturnValue('default');
  vi.mocked(subscribeToPush).mockResolvedValue(true);
  vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status());
  vi.mocked(createTelegramConnectIntent).mockResolvedValue(status({
    status: 'pending',
    pendingCommand: '/easymod_connect token',
    instructions: ['Create group', 'Add bot', 'Send command'],
  } as Partial<TelegramNotificationStatus>));
  vi.mocked(updateTelegramPreferences).mockResolvedValue(status());
  vi.mocked(sendTelegramTestAlert).mockResolvedValue({ sent: true });
  vi.mocked(disconnectTelegramAlerts).mockResolvedValue(status());
});

describe('page chrome + contextual status (header removal C1/C6)', () => {
  it('keeps the accessible title and renders no signal band and no header CTA', async () => {
    render(<NotificationSettings />);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    // The removal itself is pinned: the page-level signal badge must not exist.
    expect(screen.queryByTestId('notification-signal')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.queryByTestId('faq-add')).toBeNull();
  });

  it('maps connected / pending / unhealthy / empty status onto the Telegram panel pill', async () => {
    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ connected: true, status: 'connected', chatTitle: 'Sapna Alerts' }));
    const { unmount } = render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('Connected', { exact: true })).toBeInTheDocument());
    unmount();

    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ status: 'pending' }));
    const second = render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('Waiting for group command')).toBeInTheDocument());
    second.unmount();

    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ status: 'unhealthy' }));
    const third = render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('Needs reconnect')).toBeInTheDocument());
    third.unmount();

    vi.mocked(getTelegramNotificationStatus).mockResolvedValue({} as TelegramNotificationStatus);
    const fourth = render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('Disconnected')).toBeInTheDocument());
    expect(screen.queryByTestId('notification-signal')).toBeNull();
    fourth.unmount();
  });

  it('surfaces a load failure with a retry banner and no signal band', async () => {
    vi.mocked(getTelegramNotificationStatus).mockRejectedValue(new Error('boom'));
    render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('notification-signal')).toBeNull();
  });
});

describe('telegram lifecycle', () => {
  it('creates and shows the connect command with copy', async () => {
    render(<NotificationSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Telegram group' }));
    expect(await screen.findByText('/easymod_connect token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(createTelegramConnectIntent).toHaveBeenCalledTimes(1);
  });

  it('preference switches are role=switch and roll back on failure', async () => {
    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ connected: true, status: 'connected' }));
    vi.mocked(updateTelegramPreferences).mockRejectedValue(new Error('nope'));
    render(<NotificationSettings />);
    const toggle = await screen.findByRole('switch', { name: /New order/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(() => expect(updateTelegramPreferences).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('switch', { name: /New order/ })).toHaveAttribute('aria-checked', 'true'));
  });

  it('disconnect requires an in-system danger confirmation', async () => {
    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ connected: true, status: 'connected' }));
    render(<NotificationSettings />);
    const trigger = await screen.findByTestId('telegram-disconnect');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(disconnectTelegramAlerts).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId('telegram-disconnect-confirm'));
    await waitFor(() => expect(disconnectTelegramAlerts).toHaveBeenCalledTimes(1));
  });

  it('test alert posts and reloads status', async () => {
    vi.mocked(getTelegramNotificationStatus).mockResolvedValue(status({ connected: true, status: 'connected' }));
    render(<NotificationSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test alert' }));
    await waitFor(() => expect(sendTelegramTestAlert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getTelegramNotificationStatus).toHaveBeenCalledTimes(2));
  });
});

describe('browser push panel', () => {
  it('disables enable when permission already granted', async () => {
    vi.mocked(getPushPermission).mockReturnValue('granted');
    render(<NotificationSettings />);
    const enable = await screen.findByRole('button', { name: 'Enable browser notifications' });
    expect(enable).toBeDisabled();
  });

  it('enables through the push helper when permission is default', async () => {
    render(<NotificationSettings />);
    const enable = await screen.findByRole('button', { name: 'Enable browser notifications' });
    fireEvent.click(enable);
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
  });
});
