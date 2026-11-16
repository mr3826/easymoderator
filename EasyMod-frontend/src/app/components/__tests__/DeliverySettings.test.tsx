import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeliverySettings from '../DeliverySettings';

const mocks = vi.hoisted(() => ({
  getDeliverySettings: vi.fn(),
  updateDeliverySettings: vi.fn(),
  connectDeliveryProvider: vi.fn(),
  disconnectDeliveryProvider: vi.fn(),
  testDeliveryConnection: vi.fn(),
  activateDeliveryProvider: vi.fn(),
  deactivateDeliveryProvider: vi.fn(),
  setAiDefaultDeliveryProvider: vi.fn(),
  getPickupLocations: vi.fn(),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  getProviderAreas: vi.fn(),
  getPathaoCities: vi.fn(),
  getPathaoZones: vi.fn(),
  getPathaoAreas: vi.fn(),
}));

vi.mock('@/api/domains/order', () => ({
  ...mocks,
  // Harness-only: the redesign reads the shop name via authService, which loads
  // the api barrel; the barrel re-exports these order-domain names.
  getOrders: vi.fn(async () => []),
  getOrderCounts: vi.fn(async () => ({})),
  getOrder: vi.fn(async () => null),
  createOrder: vi.fn(async () => null),
  updateOrder: vi.fn(async () => null),
  confirmOrder: vi.fn(async () => null),
  cancelOrder: vi.fn(async () => null),
  bookCourier: vi.fn(async () => null),
  getCourierEligibility: vi.fn(async () => null),
  confirmCourierDestination: vi.fn(async () => null),
  toggleDeliveryProvider: vi.fn(async () => null),
}));
vi.mock('@shared/lib/http/errors', () => ({
  getErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'manageShop.deliverySettings.title': 'Delivery settings',
        'manageShop.deliverySettings.subtitle': 'Configure delivery',
        'manageShop.deliverySettings.zoneInsideDhaka': 'Inside Dhaka',
        'manageShop.deliverySettings.zoneSubDhaka': 'Sub Dhaka',
        'manageShop.deliverySettings.zoneOutsideDhaka': 'Outside Dhaka',
        'manageShop.deliverySettings.connected': 'Connected',
        'manageShop.deliverySettings.lastTested': `Last tested: ${values?.date || ''}`,
        'manageShop.deliverySettings.statuses.notConfigured': 'Not configured',
        'manageShop.deliverySettings.statuses.setupIncomplete': 'Setup incomplete',
        'manageShop.deliverySettings.statuses.validating': 'Validating',
        'manageShop.deliverySettings.statuses.active': 'Active',
        'manageShop.deliverySettings.statuses.actionRequired': 'Action required',
        'manageShop.deliverySettings.useSandbox': 'Use sandbox',
        'manageShop.deliverySettings.enterCredentials': `Enter ${values?.provider || 'provider'} credentials`,
        'manageShop.deliverySettings.pickupDetails': 'Pickup details',
        'manageShop.deliverySettings.pickupMissing': 'Pickup details are required before activation',
        'manageShop.deliverySettings.completePickupDetails': 'Complete pickup details',
        'manageShop.deliverySettings.aiDefaultBadge': 'AI Default',
        'manageShop.deliverySettings.setAsAiDefault': 'Set as AI default',
        'manageShop.deliverySettings.aiDefaultSuccess': `${values?.provider || 'Provider'} is now the AI default courier`,
        'manageShop.deliverySettings.pickupSaved': `${values?.provider || 'Provider'} pickup details saved and validated`,
        'manageShop.deliverySettings.generalSettings': 'General settings',
        'manageShop.deliverySettings.defaultCharge': 'Default charge',
        'manageShop.deliverySettings.codCharge': 'COD charge',
        'manageShop.deliverySettings.enableCOD': 'Enable COD',
        'manageShop.deliverySettings.nonRefundable': 'Non-refundable',
        'manageShop.deliverySettings.saveSettings': 'Save settings',
        'manageShop.deliverySettings.areaBasedPricing': 'Area pricing',
        'manageShop.deliverySettings.addArea': 'Add area',
        'manageShop.deliverySettings.codAllowed': 'COD allowed',
        'manageShop.deliverySettings.weightCharges': 'Weight charges',
        'manageShop.deliverySettings.addTier': 'Add tier',
        'manageShop.deliverySettings.weightFrom': 'From (kg)',
        'manageShop.deliverySettings.weightTo': 'To (kg)',
        'manageShop.deliverySettings.extraCharge': 'Extra charge',
        'manageShop.deliverySettings.noTiers': 'No tiers',
        'manageShop.deliverySettings.weightTierTooltip': 'Weight tier guide',
        'manageShop.deliverySettings.weightTierInfo': 'Weight tier information',
        'manageShop.deliverySettings.removeArea': 'Remove area',
        'manageShop.deliverySettings.removeTier': 'Remove tier',
        'manageShop.deliverySettings.saveConnect': 'Save and connect',
        'manageShop.deliverySettings.activate': 'Activate',
        'manageShop.deliverySettings.deactivate': 'Deactivate',
        'manageShop.deliverySettings.testConnection': 'Test connection',
        'manageShop.deliverySettings.success.connected': `${values?.provider || 'Provider'} connected`,
        'manageShop.deliverySettings.success.disconnected': `${values?.provider || 'Provider'} disconnected`,
        'manageShop.deliverySettings.success.activated': `${values?.provider || 'Provider'} activated`,
        'manageShop.deliverySettings.success.deactivated': `${values?.provider || 'Provider'} deactivated`,
        'manageShop.deliverySettings.success.testSuccess': `${values?.provider || 'Provider'} tested`,
        'manageShop.deliverySettings.success.settingsSaved': 'Settings saved',
        'manageShop.deliverySettings.errors.loadFailed': 'Load failed',
        'manageShop.deliverySettings.errors.saveFailed': 'Save failed',
        'manageShop.deliverySettings.errors.invalidWeightTiers': 'Invalid weight tiers',
        'manageShop.deliverySettings.errors.fieldRequired': `${values?.field || 'Field'} is required`,
        'manageShop.deliverySettings.errors.connectFailed': 'Connect failed',
        'manageShop.deliverySettings.errors.disconnectFailed': 'Disconnect failed',
        'manageShop.deliverySettings.errors.toggleFailed': 'Toggle failed',
        'manageShop.deliverySettings.errors.testFailed': 'Test failed',
        'manageShop.deliverySettings.errors.aiDefaultFailed': 'AI default failed',
        'manageShop.deliverySettings.disconnectConfirm': 'Disconnect provider?',
        'common.connect': 'Connect',
        'common.disconnect': 'Disconnect',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'courier.pickup.title': 'Pickup details',
        'courier.pickup.description': 'Tell us where the courier should collect your orders.',
        'courier.pickup.name': 'Pickup name',
        'courier.pickup.namePlaceholder': 'Main pickup point',
        'courier.pickup.phone': 'Pickup phone',
        'courier.pickup.city': 'City',
        'courier.pickup.zone': 'Zone',
        'courier.pickup.area': 'Area',
        'courier.pickup.areaPlaceholder': 'Enter pickup area',
        'courier.pickup.address': 'Pickup address',
        'courier.pickup.addressPlaceholder': 'Enter the complete pickup address',
        'courier.pickup.selectCity': 'Select city',
        'courier.pickup.selectZone': 'Select zone',
        'courier.pickup.selectArea': 'Select area',
        'courier.pickup.saveValidate': 'Save and validate',
        'courier.pickup.saving': 'Saving and validating...',
        'courier.pickup.errors.fieldsRequired': 'Complete all required pickup details',
        'courier.pickup.errors.locationsLoadFailed': 'Could not load courier locations',
        'courier.pickup.errors.syncFailed': 'Could not validate pickup details',
      };
      return labels[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

const settings = {
  default_delivery_charge: 60,
  cod_enabled: false,
  cod_charge: 0,
  non_refundable: false,
  area_pricing: [],
  weight_tiers: [],
};

const status = (provider: 'pathao' | 'steadfast' | 'redx', overrides: Record<string, unknown> = {}) => ({
  provider,
  display_name: `${provider} Courier`,
  is_connected: false,
  is_active: false,
  is_sandbox: false,
  metadata: {},
  last_validated_at: null,
  connected_at: null,
  ...overrides,
});

const renderSettings = async () => {
  render(<DeliverySettings />);
  await screen.findByRole('heading', { name: 'Delivery settings' });
  await waitFor(() => expect(mocks.getDeliverySettings).toHaveBeenCalled());
};

describe('DeliverySettings courier setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeliverySettings.mockResolvedValue({
      providers: [status('pathao'), status('steadfast'), status('redx')],
      settings,
    });
    mocks.updateDeliverySettings.mockResolvedValue(undefined);
    mocks.connectDeliveryProvider.mockResolvedValue(undefined);
    mocks.disconnectDeliveryProvider.mockResolvedValue(undefined);
    mocks.testDeliveryConnection.mockResolvedValue(undefined);
    mocks.activateDeliveryProvider.mockResolvedValue(undefined);
    mocks.deactivateDeliveryProvider.mockResolvedValue(undefined);
    mocks.setAiDefaultDeliveryProvider.mockResolvedValue(undefined);
    mocks.getPickupLocations.mockResolvedValue([]);
    mocks.createPickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.updatePickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.syncProviderPickup.mockResolvedValue(undefined);
    mocks.getPathaoCities.mockResolvedValue([]);
    mocks.getPathaoZones.mockResolvedValue([]);
    mocks.getPathaoAreas.mockResolvedValue([]);
    mocks.getProviderAreas.mockResolvedValue([]);
  });

  it('displays the persisted Pathao sandbox environment after reload', async () => {
    mocks.getDeliverySettings.mockResolvedValueOnce({
      providers: [status('pathao', { is_connected: true, is_sandbox: true })],
      settings,
    });

    await renderSettings();

    expect(screen.getByTestId('pathao-environment')).toHaveTextContent('Sandbox');
  });

  it('hydrates the reconnect form and sends the persisted sandbox selection', async () => {
    mocks.getDeliverySettings
      .mockResolvedValueOnce({ providers: [status('pathao', { is_sandbox: true })], settings })
      .mockResolvedValueOnce({ providers: [status('pathao', { is_connected: true, is_sandbox: true })], settings });

    await renderSettings();
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]);

    const sandbox = await screen.findByRole('checkbox', { name: 'Use sandbox' }) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client ID'), { target: { value: 'client' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client Secret'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByPlaceholderText('merchant@example.com'), { target: { value: 'merchant@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao account password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(mocks.connectDeliveryProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'pathao',
      is_sandbox: true,
    })));
  });

  it('sends the RedX sandbox selection when connecting RedX', async () => {
    await renderSettings();
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[2]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Use sandbox' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your RedX API Key'), { target: { value: 'redx-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(mocks.connectDeliveryProvider).toHaveBeenCalledWith({
      provider: 'redx',
      credentials: { api_key: 'redx-key' },
      is_sandbox: true,
    }));
  });

  it('renders activation_status chips and keeps AI Default separate from Active', async () => {
    mocks.getDeliverySettings.mockResolvedValueOnce({
      providers: [
        status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', is_ai_default: true }),
        status('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE' }),
        status('redx', { is_connected: true, activation_status: 'ACTION_REQUIRED', activation_error: 'Pickup validation failed' }),
      ],
      settings,
    });

    await renderSettings();

    expect(screen.getByTestId('activation-status-pathao')).toHaveTextContent('Active');
    expect(screen.getByTestId('activation-status-redx')).toHaveTextContent('Action required');
    expect(screen.getAllByText('AI Default')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Set as AI default' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Pickup validation failed');
  });

  it('opens pickup details automatically when activation returns a pickup conflict', async () => {
    mocks.getDeliverySettings.mockResolvedValueOnce({
      providers: [status('pathao', {
        is_connected: true,
        activation_status: 'SETUP_INCOMPLETE',
        missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'],
      })],
      settings,
    });
    mocks.getPathaoCities.mockResolvedValue([{ id: 1, name: 'Dhaka' }]);
    mocks.getPathaoZones.mockResolvedValue([{ id: 2, name: 'Gulshan' }]);
    mocks.getPathaoAreas.mockResolvedValue([{ id: 3, name: 'Gulshan 1' }]);
    mocks.activateDeliveryProvider
      .mockRejectedValueOnce({ statusCode: 409, details: { missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'] } })
      .mockResolvedValueOnce(undefined);
    mocks.getDeliverySettings.mockResolvedValueOnce({
      providers: [status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' })],
      settings,
    });

    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Main pickup point'), { target: { value: 'Main pickup' } });
    fireEvent.change(screen.getByPlaceholderText('01XXX-XXX-XXX'), { target: { value: '01712345678' } });
    await screen.findByRole('option', { name: 'Dhaka' });
    fireEvent.change(screen.getByRole('combobox', { name: 'City' }), { target: { value: '1' } });
    await waitFor(() => expect(mocks.getPathaoZones).toHaveBeenCalledWith(1));
    await screen.findByRole('option', { name: 'Gulshan' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Zone' }), { target: { value: '2' } });
    await waitFor(() => expect(mocks.getPathaoAreas).toHaveBeenCalledWith(2));
    await screen.findByRole('option', { name: 'Gulshan 1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: '3' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the complete pickup address'), { target: { value: 'House 1, Dhaka' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));

    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalledWith('pathao', expect.objectContaining({
      pickup_location_id: 'pickup-1',
      provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
    })));
    await waitFor(() => expect(mocks.activateDeliveryProvider).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('activation-status-pathao')).toHaveTextContent('Active');
  });

  it('does not request or write legacy delivery platform priority', async () => {
    await renderSettings();

    expect(mocks.getDeliverySettings).toHaveBeenCalledTimes(1);
  });
});
