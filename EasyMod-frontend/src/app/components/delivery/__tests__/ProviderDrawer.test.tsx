/**
 * ProviderDrawer unit contracts (props-driven): masked credentials view never
 * leaks values, sandbox control only for Pathao/RedX, required-field validation,
 * the type-to-confirm danger gate, and the AI-default visibility rules. No API
 * module is imported here (the drawer only calls the injected handlers), so no
 * order-domain mock is needed — react-i18next is the sole stub.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProviderDrawer, { type ProviderDrawerProps } from '../ProviderDrawer';
import type { DeliveryProviderStatus } from '@/api/types/order';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'common.disconnect': 'Disconnect',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'manageShop.deliverySettings.lastTested': `Last tested: ${values?.date || ''}`,
        'manageShop.deliverySettings.testConnection': 'Test connection',
        'manageShop.deliverySettings.activate': 'Activate',
        'manageShop.deliverySettings.deactivate': 'Deactivate',
        'manageShop.deliverySettings.setAsAI': '',
        'manageShop.deliverySettings.setAsAiDefault': 'Set as AI default',
        'manageShop.deliverySettings.useSandbox': 'Use Sandbox/Test Environment',
        'manageShop.deliverySettings.saveConnect': 'Save and connect',
        'manageShop.deliverySettings.enterCredentials': `Enter ${values?.provider || 'provider'} Credentials`,
        'manageShop.deliverySettings.completePickupDetails': 'Complete pickup details',
        'manageShop.deliverySettings.disconnectConfirm': `Are you sure you want to disconnect ${values?.provider}? This will deactivate the provider.`,
        'manageShop.deliverySettings.disconnectConfirmBody': 'Saved credentials are removed.',
        'manageShop.deliverySettings.errors.fieldRequired': `${values?.field || 'Field'} is required`,
        'manageShop.deliverySettings.statuses.active': 'Active',
        'manageShop.deliverySettings.statuses.setupIncomplete': 'Setup incomplete',
        'manageShop.deliverySettings.capabilities.neverVerified': 'Never verified with a live account.',
        'manageShop.deliverySettings.capabilities.level.implementedNotLiveVerified': 'Implemented, not live-verified',
        'manageShop.deliverySettings.providers.drawerTitle': `Manage ${values?.provider || 'provider'}`,
        'manageShop.deliverySettings.providers.credentialsTitle': 'Credentials',
        'manageShop.deliverySettings.providers.credentialsStored': 'Credentials are stored encrypted and are never shown on this page.',
        'manageShop.deliverySettings.providers.maskedValue': 'hidden value',
        'manageShop.deliverySettings.providers.reconnect': 'Reconnect',
        'manageShop.deliverySettings.providers.notTested': 'Not tested yet',
        'manageShop.deliverySettings.providers.pendingTest': `Testing ${values?.provider}…`,
        'manageShop.deliverySettings.providers.activationTitle': 'Activation',
        'manageShop.deliverySettings.providers.aiTitle': 'AI courier default',
        'manageShop.deliverySettings.providers.aiHelp': 'The AI uses the default courier.',
        'manageShop.deliverySettings.providers.clearDefault': 'Clear AI default',
        'manageShop.deliverySettings.providers.readyTitle': 'Readiness',
        'manageShop.deliverySettings.providers.readyOk': 'Ready to activate.',
        'manageShop.deliverySettings.providers.readyMissing': 'Complete these before activating:',
        'manageShop.deliverySettings.providers.evidenceTitle': 'Evidence',
        'manageShop.deliverySettings.providers.dangerTitle': 'Danger zone',
        'manageShop.deliverySettings.providers.typeToConfirm': `Type ${values?.provider} to confirm.`,
      };
      return labels[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

const pathaoConfig = ProviderConfigFor('pathao');
const steadfastConfig = ProviderConfigFor('steadfast');

function ProviderConfigFor(provider: 'pathao' | 'steadfast') {
  if (provider === 'pathao') {
    return {
      provider: 'pathao',
      display_name: 'Pathao Courier',
      description: 'Fast and reliable delivery across Bangladesh',
      logo: '🚚',
      fields: [
        { name: 'client_id', label: 'Client ID', type: 'text', placeholder: 'Enter your Pathao Client ID', required: true },
        { name: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Enter your Pathao Client Secret', required: true },
        { name: 'username', label: 'Username (Email)', type: 'email', placeholder: 'merchant@example.com', required: true },
        { name: 'password', label: 'Password', type: 'password', placeholder: 'Enter your Pathao account password', required: true },
      ],
    } as ProviderDrawerProps['config'];
  }
  return {
    provider: 'steadfast',
    display_name: 'Steadfast Courier',
    description: 'Trusted delivery partner for e-commerce',
    logo: '📦',
    fields: [
      { name: 'api_key', label: 'API Key', type: 'text', placeholder: 'Enter your Steadfast API Key', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password', placeholder: 'Enter your Steadfast Secret Key', required: true },
    ],
  } as ProviderDrawerProps['config'];
}

const connectedStatus = (provider: 'pathao' | 'steadfast', overrides: Record<string, unknown> = {}): DeliveryProviderStatus => ({
  provider,
  display_name: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`,
  is_connected: true,
  is_active: true,
  is_sandbox: false,
  activation_status: 'ACTIVE',
  metadata: {},
  last_validated_at: null,
  connected_at: null,
  capabilities: {
    version: 1,
    ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    coverage: { level: 'UNKNOWN' },
    rate_quote: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
    create_parcel: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
    tracking: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
    cancel: { level: 'UNSUPPORTED' },
    edit: { level: 'UNSUPPORTED' },
    last_verified_at: null,
  },
  ...overrides,
} as DeliveryProviderStatus);

function renderDrawer(overrides: Partial<ProviderDrawerProps> = {}): ProviderDrawerProps {
  const base: ProviderDrawerProps = {
    config: pathaoConfig,
    status: connectedStatus('pathao'),
    activationStatus: 'ACTIVE',
    isAiDefault: false,
    missing: [],
    pickupSummary: null,
    pending: null,
    onClose: vi.fn(),
    onConnect: vi.fn(),
    onTest: vi.fn(),
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    onSetAiDefault: vi.fn(),
    onClearAiDefault: vi.fn(),
    onDisconnect: vi.fn(),
    onCompletePickup: vi.fn(),
  };
  const props = { ...base, ...overrides };
  render(<ProviderDrawer {...props} />);
  return props;
}

describe('ProviderDrawer — credentials', () => {
  it('shows a masked credentials view that never exposes stored values', () => {
    renderDrawer();
    expect(screen.getAllByText('••••••••').length).toBeGreaterThan(0);
    expect(screen.getByText('Credentials are stored encrypted and are never shown on this page.')).toBeInTheDocument();
    // No live credential input is rendered until Reconnect is chosen.
    expect(screen.queryByPlaceholderText('Enter your Pathao Client ID')).not.toBeInTheDocument();
  });

  it('reveals the reconnect form and hydrates the persisted sandbox for Pathao', () => {
    renderDrawer({ status: connectedStatus('pathao', { is_sandbox: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    const sandbox = screen.getByRole('checkbox', { name: 'Use Sandbox/Test Environment' }) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);
    expect(screen.getByPlaceholderText('Enter your Pathao Client ID')).toBeInTheDocument();
  });

  it('offers no sandbox control for Steadfast', () => {
    renderDrawer({ config: steadfastConfig, status: connectedStatus('steadfast') });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(screen.queryByRole('checkbox', { name: 'Use Sandbox/Test Environment' })).not.toBeInTheDocument();
  });

  it('blocks connect until required fields are filled, showing inline errors', () => {
    const props = renderDrawer({ status: connectedStatus('pathao') });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    fireEvent.click(screen.getByTestId('drawer-save-connect-pathao'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(props.onConnect).not.toHaveBeenCalled();
  });
});

describe('ProviderDrawer — danger disconnect', () => {
  it('requires a typed confirmation before invoking the disconnect handler', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByTestId('disconnect-pathao'));
    const confirm = screen.getByTestId('delivery-disconnect-confirm') as HTMLButtonElement;
    expect(confirm).toBeDisabled();
    expect(props.onDisconnect).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type Pathao Courier to confirm/), { target: { value: 'wrong' } });
    expect(screen.getByTestId('delivery-disconnect-confirm')).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type Pathao Courier to confirm/), { target: { value: 'Pathao Courier' } });
    const ready = screen.getByTestId('delivery-disconnect-confirm') as HTMLButtonElement;
    expect(ready).toBeEnabled();
    fireEvent.click(ready);
    expect(props.onDisconnect).toHaveBeenCalledWith('pathao');
  });

  it('cancel closes the confirmation without disconnecting', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByTestId('disconnect-pathao'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('delivery-disconnect-confirm')).not.toBeInTheDocument();
    expect(props.onDisconnect).not.toHaveBeenCalled();
  });
});

describe('ProviderDrawer — AI default gating', () => {
  it('shows Set when active and not default', () => {
    renderDrawer({ activationStatus: 'ACTIVE', isAiDefault: false });
    expect(screen.getByTestId('drawer-set-ai-pathao')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-clear-ai-pathao')).not.toBeInTheDocument();
  });

  it('shows Clear when a default is already set', () => {
    renderDrawer({ activationStatus: 'ACTIVE', isAiDefault: true });
    expect(screen.getByTestId('drawer-clear-ai-pathao')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-set-ai-pathao')).not.toBeInTheDocument();
  });

  it('shows neither AI control when the connection is not active', () => {
    renderDrawer({ activationStatus: 'SETUP_INCOMPLETE', isAiDefault: false });
    expect(screen.queryByTestId('drawer-set-ai-pathao')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-clear-ai-pathao')).not.toBeInTheDocument();
  });
});
