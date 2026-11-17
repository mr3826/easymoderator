/**
 * Business-automation guardrails contracts (§8/§11/§16/§18/§29): signal matrix,
 * execution header without a CTA, real switch semantics that the fieldset can
 * actually disable, named slider/tag controls, accordion disclosure state, and
 * honest helper copy for settings the runtime never reads. Additive suite (real
 * i18n en); the legacy BusinessAutomationDefaults/AISettingsForm suites stay
 * unchanged apart from documented harness migrations.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BusinessAutomationDefaults from '../../BusinessAutomationDefaults';
import { deriveAutomationSignal } from '../derive';
import { apiClient } from '@/api';
import { getShopAISettings } from '@/api/domains/shop';
import { authService } from '@/app/lib/auth';

vi.mock('@/api', () => ({
  apiClient: {
    getShopAISettings: vi.fn(),
    updateShopAISettings: vi.fn(),
    getTelegramNotificationStatus: vi.fn(),
  },
}));

vi.mock('@/api/domains/shop', () => ({
  getShopAISettings: vi.fn(),
  emergencyStop: vi.fn(),
  emergencyResume: vi.fn(),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: { getCurrentShop: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const claimDecision = (claimId: string, textKey: string) => ({
  claimId,
  available: false,
  render: 'fallback',
  textKey,
  locale: 'en',
  surface: 'subscription',
  scope: { claimedProviders: null, verifiedProviders: null, match: false, text: null },
  interpolation: {},
  mode: 'shadow',
  predicate: {
    code_present: true, merchant_enabled: false, production_verified: false,
    deprecated: false, internal_only: false, scope_match: false,
  },
  wouldBlock: false,
  contractVersion: '1.0.0',
  registryHash: 'hash',
});

vi.mock('@/api/domains/commercialContract', () => ({
  useClaimDecisions: () => ({
    data: {
      surface: 'subscription',
      locale: 'en',
      contractVersion: '1.0.0',
      registryHash: 'hash',
      decisions: [
        claimDecision('billing.overdue_policy', 'claims.billing.overdue_policy.en'),
        claimDecision('ai.draft_reply', 'claims.ai.draft_reply.fallback.en'),
        claimDecision('ai.auto_reply', 'claims.ai.auto_reply.fallback.en'),
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

const settings = (overrides: Record<string, unknown> = {}) => ({
  automation_mode: 'DRAFT',
  confidence_threshold: 75,
  auto_reply_enabled: false,
  max_auto_order_value: 5000,
  ask_email: false,
  primary_language: 'mixed',
  required_fields: {
    customer_name: true, mobile_number: true, delivery_address: true,
    payment_method: true, email_address: false, special_instructions: false,
  },
  handoff_settings: { trigger_keywords: ['complain'], notification_channel: 'in_app', cooldown_minutes: 30 },
  emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
  ...overrides,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><BusinessAutomationDefaults /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authService.getCurrentShop).mockReturnValue({ id: 'shop-1', role: 'owner', shop_name: 'Test Shop' } as never);
  vi.mocked(apiClient.getShopAISettings).mockResolvedValue(settings() as never);
  vi.mocked(apiClient.getTelegramNotificationStatus).mockResolvedValue({ connected: true, status: 'connected' } as never);
  vi.mocked(apiClient.updateShopAISettings).mockResolvedValue(settings() as never);
  vi.mocked(getShopAISettings).mockResolvedValue(settings() as never);
});

describe('automation signal derivation', () => {
  const t = (key: string) => key;
  const base = { phase: 'ready' as const, isOwner: true, stopActive: false, mode: 'MANUAL' as const };

  it('maps each phase and mode to one dominant signal, first match wins', () => {
    expect(deriveAutomationSignal({ ...base, phase: 'error' }, t).kind).toBe('blocked');
    expect(deriveAutomationSignal({ ...base, phase: 'loading' }, t).kind).toBe('pending');
    expect(deriveAutomationSignal({ ...base, stopActive: true }, t).kind).toBe('blocked');
    expect(deriveAutomationSignal({ ...base, isOwner: false }, t).kind).toBe('review');
    expect(deriveAutomationSignal({ ...base, mode: 'AUTO' }, t).kind).toBe('attention');
    expect(deriveAutomationSignal({ ...base, mode: 'DRAFT' }, t).kind).toBe('review');
    expect(deriveAutomationSignal({ ...base, mode: 'MANUAL' }, t).kind).toBe('healthy');
  });

  it('lets the stop and the owner gate outrank the mode', () => {
    expect(deriveAutomationSignal({ ...base, mode: 'AUTO', stopActive: true }, t).label).toContain('stopped');
    expect(deriveAutomationSignal({ ...base, mode: 'AUTO', isOwner: false }, t).label).toContain('readOnly');
    expect(deriveAutomationSignal({ ...base, phase: 'error', stopActive: true }, t).label).toContain('blocked');
  });
});

describe('execution header (§29)', () => {
  it('carries title + signal + two factual pills and no header CTA', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('automation-signal').textContent).toContain('Drafts need review'));
    expect(screen.getByRole('heading', { level: 1, name: 'Automation defaults' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Mode:/)).toBeInTheDocument();
    expect(screen.getByText(/Confidence: 75%/)).toBeInTheDocument();
  });

  it('keeps a breadcrumb back to the channels workspace and a clean heading order', async () => {
    renderPage();
    await screen.findByTestId('emergency-stop-button');
    const crumb = screen.getByRole('link', { name: 'Channels & Automation' });
    expect(crumb).toHaveAttribute('href', '/manage-shop/channels');
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels).toEqual([1, 2, 2, 2, 2]);
  });
});

describe('honest controls (§18)', () => {
  it('exposes the closing toggle as a keyboard-operable switch the fieldset can disable', async () => {
    renderPage();
    const closing = await screen.findByRole('switch', { name: 'Closing message' });
    expect(closing).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(closing);
    expect(closing).toHaveAttribute('aria-checked', 'false');
    // A real button is a form control, so Save becomes available.
    expect(screen.getByRole('button', { name: /Save Reply Settings/i })).not.toBeDisabled();
  });

  it('drops the duplicate ask-email toggle and keeps the email option in Required Order Fields', async () => {
    renderPage();
    await screen.findByRole('slider');
    expect(screen.queryByRole('switch', { name: 'Ask customer for email' })).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });

  it('derives the legacy ask_email scalar from the email checkbox on save', async () => {
    renderPage();
    const emailCheckbox = await screen.findByLabelText(/email address/i);
    expect(emailCheckbox).not.toBeChecked();
    fireEvent.click(emailCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));
    await waitFor(() => expect(apiClient.updateShopAISettings).toHaveBeenCalled());
    expect(apiClient.updateShopAISettings).toHaveBeenCalledWith(expect.objectContaining({
      ask_email: true,
      required_fields: expect.objectContaining({ email_address: true }),
    }));
  });

  it('disables the switches for a non-owner and says why', async () => {
    vi.mocked(authService.getCurrentShop).mockReturnValue({ id: 'shop-1', role: 'manager' } as never);
    renderPage();
    const closing = await screen.findByRole('switch', { name: 'Closing message' });
    await waitFor(() => expect(closing).toBeDisabled());
    expect(screen.getByTestId('automation-settings-fieldset')).toBeDisabled();
    expect(screen.getByText(/Only the shop owner can change automation defaults/i)).toBeInTheDocument();
    expect(screen.getByTestId('automation-signal').textContent).toContain('Read-only');
  });

  it('names the slider and the keyword controls, and discloses the accordion state', async () => {
    renderPage();
    const slider = await screen.findByRole('slider');
    expect(slider).toHaveAccessibleName(/How confident must EasyModerator be/i);
    expect(slider).toHaveAttribute('aria-valuetext', '75%');

    const toggle = screen.getByRole('button', { name: /When We Should Alert You/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'handoff-panel');
    expect(screen.getByRole('button', { name: 'Add keyword' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove keyword complain' })).toBeInTheDocument();
  });
});

describe('honesty copy for settings the runtime never reads', () => {
  it('states that the recorded-only fields are not enforced, and discloses the fixed confidence', async () => {
    renderPage();
    await screen.findByRole('slider');
    expect(screen.getByText(/Order value does not limit automatic replies today/i)).toBeInTheDocument();
    expect(screen.getByText(/Checkout does not ask for or enforce these fields today/i)).toBeInTheDocument();
    expect(screen.getByText(/Replies follow the language the customer writes in/i)).toBeInTheDocument();
    expect(screen.getByText(/any threshold at or below 90% passes every reply/i)).toBeInTheDocument();
    // The unproven-AUTO claim copy is untouched.
    expect(screen.getByText(/Automated AI replies have not been proven live/i)).toBeInTheDocument();
  });
});

describe('save adoption and load recovery (§16)', () => {
  it('adopts the persisted mode into the header after a successful save', async () => {
    vi.mocked(apiClient.updateShopAISettings).mockResolvedValue(settings({ automation_mode: 'MANUAL' }) as never);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('automation-signal').textContent).toContain('Drafts need review'));
    fireEvent.click(screen.getByTestId('ai-reply-mode-manual'));
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));
    await waitFor(() => expect(screen.getByText('Reply settings saved.')).toBeInTheDocument());
    expect(screen.getByTestId('automation-signal').textContent).toContain('Manual mode');
    expect(screen.getByText(/Mode: Manual replies only/i)).toBeInTheDocument();
  });

  it('announces a load failure as an alert and recovers through retry', async () => {
    vi.mocked(apiClient.getShopAISettings).mockRejectedValueOnce(new Error('Automation defaults could not load.'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    expect(screen.getByTestId('automation-signal').textContent).toContain('Defaults unavailable');
    fireEvent.click(screen.getByRole('button', { name: /Retry loading defaults/i }));
    await waitFor(() => expect(screen.getByTestId('ai-reply-mode')).toBeInTheDocument());
  });
});
