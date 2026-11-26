import { httpClient } from '@/shared/lib/http/client';
import type { AxiosResponse } from 'axios';
import type { OwnerNotification, TelegramNotificationStatus } from '../types/notification';

export async function getTelegramNotificationStatus(): Promise<TelegramNotificationStatus> {
  const response: AxiosResponse<{ success: boolean; data: TelegramNotificationStatus }> =
    await httpClient.get('/api/notifications/telegram');
  return response.data.data;
}

export async function createTelegramConnectIntent(): Promise<TelegramNotificationStatus> {
  const response: AxiosResponse<{ success: boolean; data: TelegramNotificationStatus }> =
    await httpClient.post('/api/notifications/telegram/connect-intent', {});
  return response.data.data;
}

export async function sendTelegramTestAlert(): Promise<{ sent: boolean; [key: string]: unknown }> {
  const response: AxiosResponse<{ success: boolean; data: { sent: boolean; [key: string]: unknown } }> =
    await httpClient.post('/api/notifications/telegram/test', {});
  return response.data.data;
}

export async function updateTelegramPreferences(preferences: Record<string, boolean>): Promise<TelegramNotificationStatus> {
  const response: AxiosResponse<{ success: boolean; data: TelegramNotificationStatus }> =
    await httpClient.patch('/api/notifications/telegram/preferences', { preferences });
  return response.data.data;
}

export async function disconnectTelegramAlerts(): Promise<TelegramNotificationStatus | null> {
  const response: AxiosResponse<{ success: boolean; data: { status?: TelegramNotificationStatus } }> =
    await httpClient.delete('/api/notifications/telegram');
  return response.data.data?.status || null;
}

export async function getInAppNotifications(limit = 20): Promise<OwnerNotification[]> {
  const response: AxiosResponse<{ success: boolean; data: OwnerNotification[] }> =
    await httpClient.get('/api/notifications/in-app', { params: { limit } });
  return Array.isArray(response.data.data) ? response.data.data : [];
}

export async function markInAppNotificationRead(id: string): Promise<void> {
  await httpClient.patch(`/api/notifications/in-app/${id}/read`, {});
}

/**
 * Verdict envelope of the existing owner-action route
 * `POST /api/notifications/payment-confirmation/:id/:action` (backend
 * notification.routes.js → owner-notification.service.handleOwnerResponse).
 * The server replies `{ success: true, message: "Payment approved successfully", orderId }`
 * and, on refusal, an AppError envelope whose `message`/`code` must reach the
 * merchant VERBATIM (409 claim/lifecycle guards; D-4: no auto-expiry wall —
 * expired claims stay actionable). Nothing here rewrites the verdict.
 */
export interface PaymentConfirmationVerdict {
  success: boolean;
  message?: string;
  orderId?: string;
  [key: string]: unknown;
}

/**
 * F2 (payment-redesign): merchant approve/reject on a payment_confirmation.
 * Global toast is skipped on purpose — the notification row renders an inline,
 * honest result banner from this envelope (success = server `message` verbatim,
 * error = server error `message` verbatim through getErrorMessage).
 */
export async function respondToPaymentConfirmation(
  notificationId: string,
  action: 'approve' | 'reject',
): Promise<PaymentConfirmationVerdict> {
  const response: AxiosResponse<PaymentConfirmationVerdict> = await httpClient.post(
    `/api/notifications/payment-confirmation/${notificationId}/${action}`,
    {},
    { __skipGlobalErrorToast: true },
  );
  return response.data;
}
