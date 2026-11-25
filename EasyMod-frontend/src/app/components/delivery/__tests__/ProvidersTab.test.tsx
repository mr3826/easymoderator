/**
 * ProvidersTab (Tab 1) unit contracts. The whole order-domain module is mocked
 * (including the integration-added `clearAiDefault`) so this tab is testable
 * before A0 lands the real client functions. react-i18next is replaced with a
 * label map; PickupDetailsModal is stubbed to a dialog.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProvidersTab from '../ProvidersTab';
import type { DeliveryProviderStatus } from '@/api/types/order';

const mocks = vi.hoisted(() => ({
  getDeliverySettings: vi.fn(),
  updateDeliverySettings: vi.fn(),
  connectDeliveryProvider: vi.fn(),
  disconnectDeliveryProvider: vi.fn(),
  testDeliveryConnection: vi.fn(),
  activateDeliveryProvider: vi.fn(),
  deactivateDeliveryProvider: vi.fn(),
  setAiDefaultDeliveryProvider: vi.fn(),
  clearAiDefault: vi.fn(),
  getPickupLocations: vi.fn(),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  getProviderAreas: vi.fn(),
  getPathaoCities: vi.fn(),
  getPathaoZones: vi.fn(),
  getPathaoAreas: vi.fn(),
}));

// A2c (bn-numerals pin): the mocked i18n language is switchable per test so a
// pin can render the SAME timestamp under en and bn. beforeEach restores 'en'.
const i18nState = vi.hoisted(() => ({ language: 'en' }));

vi.mock('@/api/domains/order', () => ({
  ...mocks,
  getOrders: vi.fn(async () => []),
  getOrderCounts: vi.fn(async () => ({})),
}));
vi.mock('@shared/lib/http/errors', () => ({
  getErrorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));
vi.mock('../../PickupDetailsModal', () => ({
  default: () => <div role="dialog" aria-label="Pickup details">Pickup details</div>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'common.connect': 'Connect',
        'common.disconnect': 'Disconnect',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'manageShop.deliverySettings.connected': 'Connected',
        'manageShop.deliverySettings.lastTested': `Last tested: ${values?.date || ''}`,
        'manageShop.deliverySettings.pickupDetails': 'Pickup details',
        'manageShop.deliverySettings.pickupMissing': 'Pickup details are required before activation',
        'manageShop.deliverySettings.completePickupDetails': 'Complete pickup details',
        'manageShop.deliverySettings.aiDefaultBadge': 'AI Default',
        'manageShop.deliverySettings.setAsAiDefault': 'Set as AI default',
        'manageShop.deliverySettings.aiDefaultSuccess': `${values?.provider || 'Provider'} is now the AI default courier`,
        'manageShop.deliverySettings.pickupSaved': `${values?.provider || 'Provider'} pickup details saved and validated`,
        'manageShop.deliverySettings.testConnection': 'Test connection',
        'manageShop.deliverySettings.activate': 'Activate',
        'manageShop.deliverySettings.deactivate': 'Deactivate',
        'manageShop.deliverySettings.useSandbox': 'Use Sandbox/Test Environment',
        'manageShop.deliverySettings.saveConnect': 'Save and connect',
        'manageShop.deliverySettings.enterCredentials': `Enter ${values?.provider || 'provider'} Credentials`,
        'manageShop.deliverySettings.statuses.notConfigured': 'Not configured',
        'manageShop.deliverySettings.statuses.setupIncomplete': 'Setup incomplete',
        'manageShop.deliverySettings.statuses.validating': 'Validating',
        'manageShop.deliverySettings.statuses.active': 'Active',
        'manageShop.deliverySettings.statuses.actionRequired': 'Action required',
        'manageShop.deliverySettings.capabilities.title': 'What this courier can do',
        'manageShop.deliverySettings.capabilities.neverVerified': 'Never verified with a live account. Actions marked as implemented are tested against mocks only.',
        'manageShop.deliverySettings.capabilities.level.implementedNotLiveVerified': 'Implemented, not live-verified',
        'manageShop.deliverySettings.capabilities.level.unsupported': 'Not supported',
        'manageShop.deliverySettings.capabilities.level.unknown': 'Cannot be checked',
        'manageShop.deliverySettings.capabilities.level.liveVerified': 'Live-verified',
        'manageShop.deliverySettings.capabilities.operation.coverage': 'Destination coverage check',
        'manageShop.deliverySettings.capabilities.operation.rate_quote': 'Delivery charge quote',
        'manageShop.deliverySettings.capabilities.operation.create_parcel': 'Create parcel',
        'manageShop.deliverySettings.capabilities.operation.pickup_store': 'Pickup store management',
        'manageShop.deliverySettings.capabilities.reason.PICKUP_STORE_DIRECTORY': "Stores come from the courier's own directory.",
        'manageShop.deliverySettings.capabilities.reason.NO_PICKUP_STORE_API': 'This courier has no pickup-store API.',
        'manageShop.deliverySettings.capabilities.reason.ADAPTER_CONTRACT_UNVERIFIED': 'The store contract is not confirmed against a live account.',
        'manageShop.deliverySettings.capabilities.manualStep.CONFIGURE_PICKUP_MANUALLY': 'Set the pickup location manually in Pickup details.',
        'manageShop.deliverySettings.success.connected': `${values?.provider || 'Provider'} connected`,
        'manageShop.deliverySettings.success.testSuccess': `${values?.provider || 'Provider'} tested`,
        'manageShop.deliverySettings.success.activated': `${values?.provider || 'Provider'} activated`,
        'manageShop.deliverySettings.success.deactivated': `${values?.provider || 'Provider'} deactivated`,
        'manageShop.deliverySettings.success.disconnected': `${values?.provider || 'Provider'} disconnected`,
        'manageShop.deliverySettings.errors.fieldRequired': `${values?.field || 'Field'} is required`,
        'manageShop.deliverySettings.errors.connectFailed': 'Connect failed',
        'manageShop.deliverySettings.errors.testFailed': 'Test failed',
        'manageShop.deliverySettings.errors.toggleFailed': 'Toggle failed',
        'manageShop.deliverySettings.errors.aiDefaultFailed': 'AI default failed',
        'manageShop.deliverySettings.errors.disconnectFailed': 'Disconnect failed',
        'manageShop.deliverySettings.providers.manage': 'Manage',
        'manageShop.deliverySettings.providers.drawerTitle': `Manage ${values?.provider || 'provider'}`,
        'manageShop.deliverySettings.providers.reconnect': 'Reconnect',
        'manageShop.deliverySettings.providers.notTested': 'Not tested yet',
        'manageShop.deliverySettings.providers.pendingTest': `Testing ${values?.provider || 'provider'}…`,
        'manageShop.deliverySettings.providers.environmentProduction': 'Production',
        'manageShop.deliverySettings.providers.environmentSandbox': 'Sandbox',
        'manageShop.deliverySettings.providers.steadfastNoSandbox': 'Steadfast connects to its live account only — there is no sandbox.',
        'manageShop.deliverySettings.providers.activateNeedsPickup': 'Complete pickup details to activate this courier.',
        'manageShop.deliverySettings.providers.credentialsTitle': 'Credentials',
        'manageShop.deliverySettings.providers.credentialsStored': 'Credentials are stored encrypted and are never shown on this page.',
        'manageShop.deliverySettings.providers.maskedValue': 'hidden value',
        'manageShop.deliverySettings.providers.activationTitle': 'Activation',
        'manageShop.deliverySettings.providers.aiTitle': 'AI courier default',
        'manageShop.deliverySettings.providers.aiHelp': 'The AI uses the default courier to answer customers.',
        'manageShop.deliverySettings.providers.clearDefault': 'Clear AI default',
        'manageShop.deliverySettings.providers.readyTitle': 'Readiness',
        'manageShop.deliverySettings.providers.readyOk': 'Ready to activate.',
        'manageShop.deliverySettings.providers.readyMissing': 'Complete these before activating:',
        'manageShop.deliverySettings.providers.evidenceTitle': 'What this courier can do',
        'manageShop.deliverySettings.providers.dangerTitle': 'Danger zone',
        'manageShop.deliverySettings.providers.typeToConfirm': `Type ${values?.provider || 'provider'} to confirm.`,
        'manageShop.deliverySettings.providers.clearDefaultSuccess': `${values?.provider || 'Provider'} is no longer the AI default courier.`,
        'manageShop.deliverySettings.providers.errors.clearDefaultFailed': 'Could not clear the AI default courier.',
      };
      return labels[key] || key;
    },
    i18n: { get language() { return i18nState.language; } },
  }),
}));

// Base capability fixture WITHOUT pickup_store — also used verbatim to prove
// the renderer stays tolerant of older payloads that do not declare it.
const capabilities = {
  version: 1,
  ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
  coverage: { level: 'UNKNOWN', reason_code: 'TEXT_ONLY_COVERAGE' },
  rate_quote: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'RATE_SHOWN_AFTER_BOOKING' },
  create_parcel: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
  tracking: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
  cancel: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'CANCEL_IN_PROVIDER_PORTAL' },
  edit: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'EDIT_IN_PROVIDER_PORTAL' },
  last_verified_at: null,
};

// Mirrors backend provider-capabilities.js: pathao/redx implement pickup-store
// work but were never live-verified; steadfast declares NO_PICKUP_STORE_API
// with a manual configuration step.
const capabilitiesFor = (provider: 'pathao' | 'steadfast' | 'redx') => ({
  ...capabilities,
  pickup_store: provider === 'steadfast'
    ? { level: 'UNSUPPORTED', reason_code: 'NO_PICKUP_STORE_API', manual_step_code: 'CONFIGURE_PICKUP_MANUALLY' }
    : provider === 'redx'
      ? { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED', reason_code: 'ADAPTER_CONTRACT_UNVERIFIED' }
      : { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED', reason_code: 'PICKUP_STORE_DIRECTORY' },
});

const status = (
  provider: 'pathao' | 'steadfast' | 'redx',
  overrides: Record<string, unknown> = {},
): DeliveryProviderStatus => ({
  provider,
  display_name: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`,
  is_connected: false,
  is_active: false,
  is_sandbox: false,
  metadata: {},
  last_validated_at: null,
  connected_at: null,
  capabilities: capabilitiesFor(provider),
  ...overrides,
} as DeliveryProviderStatus);

const renderTab = (providers: DeliveryProviderStatus[], onMutate = vi.fn(async () => {}), opts = {}) =>
  render(<ProvidersTab providers={providers} onMutate={onMutate} {...opts} />);

beforeEach(() => {
  i18nState.language = 'en';
  vi.clearAllMocks();
  mocks.connectDeliveryProvider.mockResolvedValue(undefined);
  mocks.testDeliveryConnection.mockResolvedValue(undefined);
  mocks.activateDeliveryProvider.mockResolvedValue(undefined);
  mocks.deactivateDeliveryProvider.mockResolvedValue(undefined);
  mocks.setAiDefaultDeliveryProvider.mockResolvedValue(undefined);
  mocks.clearAiDefault.mockResolvedValue(undefined);
  mocks.disconnectDeliveryProvider.mockResolvedValue(undefined);
});

describe('ProvidersTab — cards', () => {
  it('renders the three providers in the fixed order with their signal chips', () => {
    renderTab([status('pathao'), status('steadfast'), status('redx')]);
    expect(screen.getByTestId('activation-status-pathao')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('activation-status-steadfast')).toBeInTheDocument();
    expect(screen.getByTestId('activation-status-redx')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Pathao Courier', 'Steadfast Courier', 'RedX Courier']);
  });

  it('shows the persisted Pathao sandbox environment on the card', () => {
    renderTab([status('pathao', { is_connected: true, is_sandbox: true })]);
    expect(screen.getByTestId('pathao-environment')).toHaveTextContent('Sandbox');
  });

  it('labels a Steadfast environment as Production without a sandbox control', () => {
    renderTab([status('steadfast', { is_connected: true })]);
    const env = screen.getByTestId('steadfast-environment');
    expect(env).toHaveTextContent('Production');
    expect(env.getAttribute('title')).toContain('no sandbox');
  });

  it('surfaces pickup summary or missing marker and the Complete-pickup link', () => {
    renderTab([status('pathao', {
      is_connected: true,
      activation_status: 'SETUP_INCOMPLETE',
      missing: ['pickup_name', 'pickup_area'],
    })]);
    expect(screen.getByTestId('pickup-missing-pathao')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete pickup details' })).toBeInTheDocument();
  });

  it('states capability truth without ever claiming live verification', () => {
    renderTab([status('steadfast', { is_connected: true })]);
    const panel = screen.getByTestId('provider-capabilities-steadfast');
    expect(screen.getByTestId('capability-steadfast-rate_quote')).toHaveTextContent('Not supported');
    expect(screen.getByTestId('capability-steadfast-coverage')).toHaveTextContent('Cannot be checked');
    expect(panel.textContent).toContain('Implemented, not live-verified');
    expect(screen.queryByText('Live-verified', { exact: true })).not.toBeInTheDocument();
  });

  it('renders the pickup_store row with the honest per-provider ceiling', () => {
    renderTab([
      status('pathao', { is_connected: true }),
      status('steadfast', { is_connected: true }),
      status('redx', { is_connected: true }),
    ]);
    expect(screen.getByTestId('capability-pathao-pickup_store')).toHaveTextContent('Implemented, not live-verified');
    expect(screen.getByTestId('capability-redx-pickup_store')).toHaveTextContent('Implemented, not live-verified');
    expect(screen.getByTestId('capability-redx-pickup_store').closest('dd'))
      .toHaveTextContent('The store contract is not confirmed against a live account.');
    const steadfastRow = screen.getByTestId('capability-steadfast-pickup_store');
    expect(steadfastRow).toHaveTextContent('Not supported');
    expect(steadfastRow.closest('dd')).toHaveTextContent('This courier has no pickup-store API.');
    expect(steadfastRow.closest('dd')).toHaveTextContent('Set the pickup location manually in Pickup details.');
    expect(screen.getAllByText('Pickup store management')).toHaveLength(3);
  });

  it('skips the pickup_store row for older payloads that do not declare it', () => {
    renderTab([status('pathao', { is_connected: true, capabilities })]);
    expect(screen.queryByTestId('capability-pathao-pickup_store')).not.toBeInTheDocument();
    expect(screen.getByTestId('capability-pathao-tracking')).toBeInTheDocument();
    expect(screen.getByTestId('capability-pathao-cancel')).toBeInTheDocument();
  });

  it('renders Pathao/RedX environment chips from translated values', () => {
    const { rerender } = renderTab([status('redx', { is_connected: true, is_sandbox: true })]);
    expect(screen.getByTestId('redx-environment')).toHaveTextContent('Sandbox');
    rerender(<ProvidersTab
      providers={[status('redx', { is_connected: true, is_sandbox: false })]}
      onMutate={vi.fn()}
    />);
    expect(screen.getByTestId('redx-environment')).toHaveTextContent('Production');
  });

  it('exposes one primary action: Connect when idle, Manage when connected', () => {
    const { rerender } = renderTab([status('pathao')]);
    expect(screen.getByTestId('connect-pathao')).toBeInTheDocument();
    rerender(<ProvidersTab providers={[status('pathao', { is_connected: true })]} onMutate={vi.fn()} />);
    expect(screen.getByTestId('manage-pathao')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-pathao')).not.toBeInTheDocument();
  });
});

describe('ProvidersTab — drawer actions', () => {
  it('opens the management drawer on Manage and hydrates the persisted sandbox in the reconnect form', async () => {
    renderTab([status('pathao', { is_connected: true, is_sandbox: true, activation_status: 'ACTIVE', is_active: true })]);
    fireEvent.click(screen.getByTestId('manage-pathao'));
    expect(await screen.findByRole('dialog', { name: /Manage Pathao Courier/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    const sandbox = screen.getByRole('checkbox', { name: 'Use Sandbox/Test Environment' }) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);
  });

  it('keeps a Steadfast connection management free of any sandbox control', async () => {
    renderTab([status('steadfast', { is_connected: true, activation_status: 'ACTIVE', is_active: true })]);
    fireEvent.click(screen.getByTestId('manage-steadfast'));
    await screen.findByRole('dialog', { name: /Manage Steadfast Courier/ });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(screen.queryByRole('checkbox', { name: 'Use Sandbox/Test Environment' })).not.toBeInTheDocument();
  });

  it('moves the Test action from Pending to a server-confirmed last-tested date only after reload', async () => {
    let resolveTest: (value: unknown) => void = () => {};
    mocks.testDeliveryConnection.mockImplementation(() => new Promise((res) => { resolveTest = res; }));

    let rerenderFn: (ui: React.ReactElement) => void = () => {};
    const onMutate = vi.fn(async () => {
      rerenderFn(<ProvidersTab providers={[status('pathao', { is_connected: true, activation_status: 'ACTIVE', is_active: true, last_validated_at: '2026-11-24T10:00:00.000Z' })]} onMutate={onMutate} />);
    });
    const first = render(<ProvidersTab providers={[status('pathao', { is_connected: true, activation_status: 'ACTIVE', is_active: true, last_validated_at: null })]} onMutate={onMutate} />);
    rerenderFn = first.rerender;

    fireEvent.click(first.getByTestId('manage-pathao'));
    const dialog = await first.findByRole('dialog', { name: /Manage Pathao Courier/ });
    expect(withinText(dialog, 'Not tested yet')).toBe(true);
    fireEvent.click(first.getByTestId('drawer-test-pathao'));

    // Pending while the request is in flight.
    expect(await first.findByRole('status')).toHaveTextContent('Testing Pathao Courier…');

    resolveTest(undefined);
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    // Server-confirmed value arrives only through the reloaded provider prop
    // (rendered on both the card and the drawer's test section).
    await waitFor(() => expect(first.getAllByText(/^Last tested:/).length).toBeGreaterThan(0));
    expect(first.queryByText('Testing Pathao Courier…')).not.toBeInTheDocument();
    expect(mocks.testDeliveryConnection).toHaveBeenCalledWith('pathao');
  });

  it('routes an activation 409 to the pickup flow', async () => {
    mocks.activateDeliveryProvider.mockRejectedValueOnce({ statusCode: 409, details: { missing: ['pickup_name', 'pickup_area'] } });
    renderTab([status('pathao', { is_connected: true, activation_status: 'SETUP_INCOMPLETE', missing: ['pickup_name', 'pickup_area'] })]);
    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: /Manage Pathao Courier/ });
    fireEvent.click(screen.getByTestId('drawer-activate-pathao'));
    // The pickup surface is opened and a Complete-pickup affordance stays reachable.
    expect(await screen.findByRole('dialog', { name: 'Pickup details' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Complete pickup details' }).length).toBeGreaterThan(0);
  });

  it('surfaces a failed connect INSIDE the open drawer, not only on the card behind the scrim', async () => {
    mocks.connectDeliveryProvider.mockRejectedValueOnce(new Error('Invalid Pathao credentials'));
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('connect-pathao'));
    const dialog = await screen.findByRole('dialog', { name: /Manage Pathao Courier/ });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client ID'), { target: { value: 'client' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client Secret'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByPlaceholderText('merchant@example.com'), { target: { value: 'm@e.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao account password'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('drawer-save-connect-pathao'));
    });
    await waitFor(() => expect(mocks.connectDeliveryProvider).toHaveBeenCalled());
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Invalid Pathao credentials');
    // The card keeps its secondary copy for when the drawer closes.
    expect(screen.getByTestId('provider-feedback-pathao')).toHaveTextContent('Invalid Pathao credentials');
  });

  it('gates the AI default action on an ACTIVE connection: set when not default, clear when default', async () => {
    const { rerender } = renderTab([status('pathao', { is_connected: true, activation_status: 'SETUP_INCOMPLETE', is_active: false })]);
    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: /Manage Pathao Courier/ });
    expect(screen.queryByTestId('drawer-set-ai-pathao')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-clear-ai-pathao')).not.toBeInTheDocument();

    rerender(<ProvidersTab
      providers={[
        status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' }),
        status('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE', is_ai_default: true }),
      ]}
      onMutate={vi.fn()}
    />);
    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: /Manage Pathao Courier/ });
    expect(screen.getByTestId('drawer-set-ai-pathao')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByTestId('manage-steadfast'));
    await screen.findByRole('dialog', { name: /Manage Steadfast Courier/ });
    expect(screen.getByTestId('drawer-clear-ai-steadfast')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-set-ai-steadfast')).not.toBeInTheDocument();
  });
});

// Small helper: does `node` contain the given text? (keeps the pending→confirmed
// assertion readable without pulling @testing-library/dom `within`).
function withinText(node: HTMLElement, text: string): boolean {
  return (node.textContent || '').includes(text);
}

/**
 * A2c MINOR pin (bn-numerals rule): the card's last-tested timestamp must flow
 * through the ACTIVE locale (Intl via localeFor: bn → bn-BD, else en-US), never
 * a locale-less toLocaleDateString(). The Latin form is anchored "Month D," —
 * en-US renders it, bn-BD must not (Bangla day/month come first, in the locale's
 * own script/numerals, whatever the host ICU data spells them).
 */
describe('ProvidersTab — locale-aware timestamps (bn-numerals)', () => {
  it('renders last-tested through the active locale, never the Latin host default', () => {
    const iso = '2026-11-24T10:00:00.000Z';
    const latinMonthDay = /^[A-Za-z]+\s\d{1,2},/;

    i18nState.language = 'en';
    const enView = renderTab([status('pathao', { is_connected: true, last_validated_at: iso })]);
    const enDate = (enView.getByText(/^Last tested:/).textContent ?? '').replace(/^Last tested:\s*/, '');
    expect(enDate).toMatch(latinMonthDay);
    enView.unmount();

    i18nState.language = 'bn';
    const bnView = renderTab([status('pathao', { is_connected: true, last_validated_at: iso })]);
    const bnDate = (bnView.getByText(/^Last tested:/).textContent ?? '').replace(/^Last tested:\s*/, '');
    expect(bnDate).not.toMatch(latinMonthDay);
    expect(bnDate).not.toBe(enDate);
  });
});

describe('ProvidersTab — connect flow', () => {
  it('validates required fields inline and then sends persisted sandbox on connect', async () => {
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('connect-pathao'));
    await screen.findByRole('dialog', { name: /Manage Pathao Courier/ });
    fireEvent.click(screen.getByTestId('drawer-save-connect-pathao'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(mocks.connectDeliveryProvider).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client ID'), { target: { value: 'client' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client Secret'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByPlaceholderText('merchant@example.com'), { target: { value: 'm@e.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao account password'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('drawer-save-connect-pathao'));
    });
    await waitFor(() => expect(mocks.connectDeliveryProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'pathao' })));
  });
});
