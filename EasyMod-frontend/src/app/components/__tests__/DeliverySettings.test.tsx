/**
 * Delivery Settings courier-setup contracts — TABBED shell edition.
 *
 * Every assertion the pre-tab single-page suite pinned is preserved, relocated
 * to where the capability now lives:
 *  - sandbox hydration (persisted Pathao/RedX `is_sandbox` after reload) — card chips unchanged;
 *  - connect/reconnect credential form + sandbox selection — now inside ProviderDrawer
 *    (testids `connect-{p}` / `manage-{p}` / `drawer-save-connect-{p}` / `sandbox-{p}`);
 *  - activation chips + AI-default badge separation — chips/badge stay on the cards,
 *    the set/clear affordance moved into the drawer (`drawer-set-ai-{p}`, `drawer-clear-ai-{p}`);
 *  - activation-409 → pickup flow — the shell now routes the merchant to the Pickup TAB
 *    (tablist `delivery-tab-pickup` + PickupForm) instead of opening PickupDetailsModal;
 *    the same pinned API chain is asserted: create → sync with the Pathao cascade ids →
 *    explicit re-activate (the redesign deliberately keeps activate a separate merchant
 *    action — PickupTab never auto-activates) → chip flips to Active only after the
 *    server-confirmed reload;
 *  - AI-default clear (NEW-UI over the existing DELETE /ai-default route);
 *  - legacy `toggleDeliveryProvider`/platform-priority keys never resurrected.
 */
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
  clearAiDefault: vi.fn(),
  getPickupLocations: vi.fn(),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  listProviderStores: vi.fn(),
  importProviderStores: vi.fn(),
  setProviderPickup: vi.fn(),
  createProviderStore: vi.fn(),
  setDefaultPickupLocation: vi.fn(),
  deletePickupLocation: vi.fn(),
  retryPickupSync: vi.fn(),
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
        'manageShop.deliverySettings.tabs.label': 'Delivery settings sections',
        'manageShop.deliverySettings.tabs.providers': 'Courier Providers',
        'manageShop.deliverySettings.tabs.pickup': 'Pickup Locations',
        'manageShop.deliverySettings.tabs.charges': 'Delivery Charges & Policies',
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
        'manageShop.deliverySettings.saveCharges': 'Save delivery charges',
        'manageShop.deliverySettings.saveChargesScope': 'Saves general, area and weight settings.',
        'manageShop.deliverySettings.chargesSaved': 'Saved',
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
        'manageShop.deliverySettings.disconnectConfirmBody': 'Saved credentials are removed.',
        'manageShop.deliverySettings.chargesUnsaved': 'Unsaved charges',
        'common.connect': 'Connect',
        'common.disconnect': 'Disconnect',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'common.bdPhoneInvalid': 'Enter a valid BD mobile number',
        // ── Providers tab / management drawer ────────────────────────────────
        'manageShop.deliverySettings.providers.manage': 'Manage',
        'manageShop.deliverySettings.providers.drawerTitle': `Manage ${values?.provider || 'provider'}`,
        'manageShop.deliverySettings.providers.reconnect': 'Reconnect',
        'manageShop.deliverySettings.providers.notTested': 'Not tested yet',
        'manageShop.deliverySettings.providers.pendingTest': `Testing ${values?.provider || 'provider'}…`,
        'manageShop.deliverySettings.providers.environmentProduction': 'Production',
        'manageShop.deliverySettings.providers.steadfastNoSandbox': 'Steadfast connects to its live account only — there is no sandbox.',
        'manageShop.deliverySettings.providers.activateNeedsPickup': 'Complete pickup details to activate this courier.',
        'manageShop.deliverySettings.providers.credentialsTitle': 'Credentials',
        'manageShop.deliverySettings.providers.credentialsStored': 'Credentials are stored encrypted and are never shown on this page.',
        'manageShop.deliverySettings.providers.maskedValue': 'hidden value',
        'manageShop.deliverySettings.providers.activationTitle': 'Activation',
        'manageShop.deliverySettings.providers.aiTitle': 'AI courier default',
        'manageShop.deliverySettings.providers.aiHelp': 'The AI uses the default courier to answer customers.',
        'manageShop.deliverySettings.providers.clearDefault': 'Clear AI default',
        'manageShop.deliverySettings.providers.clearDefaultSuccess': `${values?.provider || 'Provider'} is no longer the AI default courier.`,
        'manageShop.deliverySettings.providers.errors.clearDefaultFailed': 'Could not clear the AI default courier.',
        'manageShop.deliverySettings.providers.readyTitle': 'Readiness',
        'manageShop.deliverySettings.providers.readyOk': 'Ready to activate.',
        'manageShop.deliverySettings.providers.readyMissing': 'Complete these before activating:',
        'manageShop.deliverySettings.providers.evidenceTitle': 'What this courier can do',
        'manageShop.deliverySettings.providers.dangerTitle': 'Danger zone',
        'manageShop.deliverySettings.providers.typeToConfirm': `Type ${values?.provider || 'provider'} to confirm.`,
        // ── Pickup workspace (Tab 2) ─────────────────────────────────────────
        'manageShop.deliverySettings.pickup.title': 'Pickup locations',
        'manageShop.deliverySettings.pickup.description': 'Manage where the courier collects parcels.',
        'manageShop.deliverySettings.pickup.addLocation': 'Add pickup location',
        'manageShop.deliverySettings.pickup.storePanel': 'Provider pickup stores',
        'manageShop.deliverySettings.pickup.localList': 'Saved pickup locations',
        'manageShop.deliverySettings.pickup.fetchStores': 'Fetch stores',
        'manageShop.deliverySettings.pickup.import': 'Import',
        'manageShop.deliverySettings.pickup.link': 'Link',
        'manageShop.deliverySettings.pickup.retry': 'Retry',
        'manageShop.deliverySettings.pickup.createProviderStore': `Create store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.edit': 'Edit',
        'manageShop.deliverySettings.pickup.delete': 'Delete',
        'manageShop.deliverySettings.pickup.noLocations': 'No pickup locations yet',
        'manageShop.deliverySettings.pickup.noLocationsHelp': 'Import from a provider or create one.',
        'manageShop.deliverySettings.pickup.noStores': 'No stores loaded',
        'manageShop.deliverySettings.pickup.synced': `${values?.n ?? 0} stores available`,
        'manageShop.deliverySettings.pickup.storesFailed': 'Could not load stores',
        'manageShop.deliverySettings.pickup.storesSyncedAt': `Synced ${values?.date ?? ''}`,
        'manageShop.deliverySettings.pickup.notSyncedYet': 'Not synced yet',
        'manageShop.deliverySettings.pickup.manualOnly': `${values?.provider ?? ''} pickup is set up manually.`,
        'manageShop.deliverySettings.pickup.manualOnlyShort': 'Manual only',
        'manageShop.deliverySettings.pickup.connectFirst': 'Not connected',
        'manageShop.deliverySettings.pickup.connectFirstHelp': `Connect ${values?.provider ?? ''} to import stores.`,
        'manageShop.deliverySettings.pickup.unsupported': 'Not supported',
        'manageShop.deliverySettings.pickup.mapping.stale': 'Mapping needs review',
        'manageShop.deliverySettings.pickup.mapping.confirmed': 'Linked & confirmed',
        'manageShop.deliverySettings.pickup.mapping.unknown': 'Not linked yet',
        'manageShop.deliverySettings.pickup.linked': `Linked to ${values?.store ?? ''}`,
        'manageShop.deliverySettings.pickup.linkedBadge': 'Linked',
        'manageShop.deliverySettings.pickup.linkedStoreId': `Provider store ${values?.id ?? ''}`,
        'manageShop.deliverySettings.pickup.selectLocationFirst': 'Select a location first',
        'manageShop.deliverySettings.pickup.selectForLink': `Select ${values?.name ?? ''} for linking`,
        'manageShop.deliverySettings.pickup.selectedForLink': 'Selected',
        'manageShop.deliverySettings.pickup.storeIdLabel': `Store ${values?.id ?? ''}`,
        'manageShop.deliverySettings.pickup.storeCreateSyncing': 'Refreshing stores…',
        'manageShop.deliverySettings.pickup.createHeading': `New ${values?.provider ?? ''} pickup location`,
        'manageShop.deliverySettings.pickup.editHeading': `Edit ${values?.provider ?? ''} pickup location`,
        'manageShop.deliverySettings.pickup.createLocation': 'Create location',
        'manageShop.deliverySettings.pickup.save': 'Save changes',
        'manageShop.deliverySettings.pickup.saving': 'Saving…',
        'manageShop.deliverySettings.pickup.loadingLocations': 'Loading locations…',
        'manageShop.deliverySettings.pickup.syncing': 'Syncing…',
        'manageShop.deliverySettings.pickup.importing': 'Importing…',
        'manageShop.deliverySettings.pickup.linking': 'Linking…',
        'manageShop.deliverySettings.pickup.importDone': 'Stores imported',
        'manageShop.deliverySettings.pickup.statusPills.review': 'Review',
        'manageShop.deliverySettings.pickup.statusPills.pending': 'Pending',
        'manageShop.deliverySettings.pickup.resolutions.MATCHED': 'Matched an existing store.',
        'manageShop.deliverySettings.pickup.resolutions.LINKED': 'Linked to the selected store.',
        'manageShop.deliverySettings.pickup.ambiguous.title': 'Multiple pickup stores match',
        'manageShop.deliverySettings.pickup.ambiguous.body': 'Choose the right store — EasyModerator will not guess.',
        'manageShop.deliverySettings.pickup.ambiguous.candidatesLabel': 'Matching stores',
        'manageShop.deliverySettings.pickup.ambiguous.choose': 'Use selected store',
        'manageShop.deliverySettings.pickup.ambiguous.needsSelection': 'Choose a matching store',
        'manageShop.deliverySettings.pickup.deleteConfirm': `Delete ${values?.name ?? ''}?`,
        'manageShop.deliverySettings.pickup.deleteConfirmBody': 'This cannot be undone here.',
        'manageShop.deliverySettings.pickup.deleteConfirmAction': 'Delete anyway',
        'manageShop.deliverySettings.pickup.deleteBlockedDefault': 'This is your default pickup location.',
        'manageShop.deliverySettings.pickup.deleteBlockedInUse': 'In use by a courier integration.',
        'manageShop.deliverySettings.pickup.deleteBlockedInUseProviders': `In use by: ${values?.providers ?? ''}`,
        'manageShop.deliverySettings.pickup.deleteBlockedGeneric': 'Blocked.',
        'manageShop.deliverySettings.pickup.external.title': `New store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.external.impact': 'This creates a store directly at the courier.',
        'manageShop.deliverySettings.pickup.external.next': 'Continue to confirm',
        'manageShop.deliverySettings.pickup.external.confirmTitle': `Confirm new store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.external.confirmBody': 'EasyModerator will create this store at the courier. This is not reversible here.',
        'manageShop.deliverySettings.pickup.external.confirmAction': `Create at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.providers.pathao': 'Pathao',
        'manageShop.deliverySettings.pickup.providers.steadfast': 'Steadfast',
        'manageShop.deliverySettings.pickup.providers.redx': 'RedX',
        'manageShop.deliverySettings.pickup.providers.manual': 'Manual',
        'manageShop.deliverySettings.pickup.errors.loadFailed': 'Could not load pickup locations',
        'manageShop.deliverySettings.pickup.errors.saveFailed': 'Could not save this pickup location',
        'manageShop.deliverySettings.pickup.errors.linkFailed': 'Could not link this store',
        'manageShop.deliverySettings.pickup.errors.importFailed': 'Could not import stores',
        'manageShop.deliverySettings.pickup.errors.retryFailed': 'Sync retry failed',
        'manageShop.deliverySettings.pickup.errors.syncFailed': 'Could not sync this pickup',
        'manageShop.deliverySettings.pickup.errors.deleteFailed': 'Could not delete this location',
        'manageShop.deliverySettings.pickup.errors.deleteBlocked': 'This location cannot be deleted.',
        'manageShop.deliverySettings.pickup.errors.createStoreFailed': 'Could not create the store',
        'manageShop.deliverySettings.pickup.errors.ambiguousUnresolved': 'That store could not be resolved',
        'manageShop.deliverySettings.errors.updateDefaultFailed': 'Could not update default',
        'manageShop.deliverySettings.defaultBadge': 'Default',
        'manageShop.deliverySettings.setAsDefault': 'Set as Default',
        'manageShop.deliverySettings.capabilities.title': 'What this courier can do',
        'manageShop.deliverySettings.capabilities.neverVerified': 'Never verified with a live account.',
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
      if (key in labels) return labels[key];
      if (typeof values?.defaultValue === 'string') return values.defaultValue;
      return key;
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

const gotoTab = async (tab: 'providers' | 'pickup' | 'charges') => {
  fireEvent.click(screen.getByTestId(`delivery-tab-${tab}`));
  const panel = await screen.findByTestId(tab === 'providers' ? 'activation-status-pathao' : tab === 'charges' ? 'charges-tab' : 'pickup-add-location');
  return panel;
};

describe('DeliverySettings courier setup (tabbed shell)', () => {
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
    mocks.clearAiDefault.mockResolvedValue({});
    mocks.getPickupLocations.mockResolvedValue([]);
    mocks.createPickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.updatePickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.syncProviderPickup.mockResolvedValue({ store_resolution: 'MATCHED' });
    mocks.listProviderStores.mockResolvedValue({ provider: 'pathao', stores: [], pickup_locations: [] });
    mocks.importProviderStores.mockResolvedValue({ provider: 'pathao', stores: [], pickup_locations: [] });
    mocks.setProviderPickup.mockResolvedValue({ store_resolution: 'LINKED' });
    mocks.createProviderStore.mockResolvedValue({ provider: 'pathao', created: true, store: { store_id: 'new-s' } });
    mocks.setDefaultPickupLocation.mockResolvedValue({ id: 'pickup-1', is_default: true });
    mocks.deletePickupLocation.mockResolvedValue({ id: 'pickup-1', deleted: true });
    mocks.retryPickupSync.mockResolvedValue({ store_resolution: 'MATCHED' });
    mocks.getPathaoCities.mockResolvedValue([]);
    mocks.getPathaoZones.mockResolvedValue([]);
    mocks.getPathaoAreas.mockResolvedValue([]);
    mocks.getProviderAreas.mockResolvedValue([]);
  });

  it('shows the three tabs and starts on Courier Providers', async () => {
    await renderSettings();

    expect(screen.getByTestId('delivery-tab-providers')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('delivery-tab-charges')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    // The providers panel is the mounted one; pickup/charges panels are not rendered yet.
    expect(document.getElementById('delivery-panel-providers')).toBeInTheDocument();
    expect(document.getElementById('delivery-panel-pickup')).toBeNull();
  });

  it('displays the persisted Pathao sandbox environment after reload', async () => {
    mocks.getDeliverySettings.mockResolvedValueOnce({
      providers: [status('pathao', { is_connected: true, is_sandbox: true })],
      settings,
    });

    await renderSettings();

    expect(screen.getByTestId('pathao-environment')).toHaveTextContent('Sandbox');
  });

  it('hydrates the reconnect form in the management drawer and sends the persisted sandbox selection', async () => {
    mocks.getDeliverySettings
      .mockResolvedValueOnce({ providers: [status('pathao', { is_connected: true, is_sandbox: true })], settings })
      .mockResolvedValue({ providers: [status('pathao', { is_connected: true, is_sandbox: true, activation_status: 'ACTIVE', is_active: true })], settings });

    await renderSettings();
    fireEvent.click(screen.getByTestId('manage-pathao'));
    // Connected providers show the masked view first; Reconnect reveals the form.
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    const sandbox = screen.getByRole('checkbox', { name: 'Use sandbox' }) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client ID'), { target: { value: 'client' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao Client Secret'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByPlaceholderText('merchant@example.com'), { target: { value: 'merchant@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your Pathao account password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByTestId('drawer-save-connect-pathao'));

    await waitFor(() => expect(mocks.connectDeliveryProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'pathao',
      is_sandbox: true,
    })));
  });

  it('sends the RedX sandbox selection when connecting RedX', async () => {
    await renderSettings();
    fireEvent.click(screen.getAllByTestId('connect-redx')[0]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Use sandbox' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your RedX API Key'), { target: { value: 'redx-key' } });
    fireEvent.click(screen.getByTestId('drawer-save-connect-redx'));

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
    // AI-default badge is a card-level signal (only Pathao carries it), separate
    // from the Active chip; the set/clear affordance itself lives in the drawer.
    expect(screen.getByTestId('ai-default-badge-pathao')).toHaveTextContent('AI Default');
    expect(screen.queryByTestId('ai-default-badge-steadfast')).toBeNull();
    expect(screen.getByTestId('manage-steadfast')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Pickup validation failed');

    fireEvent.click(screen.getByTestId('manage-steadfast'));
    await screen.findByRole('dialog', { name: 'Manage Steadfast Courier' });
    expect(screen.getByTestId('drawer-set-ai-steadfast')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-clear-ai-steadfast')).toBeNull();
  });

  it('routes an activation 409 to the Pickup tab and preserves create → sync → activate', async () => {
    const incomplete = status('pathao', {
      is_connected: true,
      activation_status: 'SETUP_INCOMPLETE',
      missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'],
    });
    mocks.getDeliverySettings
      .mockResolvedValueOnce({ providers: [incomplete, status('steadfast'), status('redx')], settings })
      .mockResolvedValueOnce({ providers: [incomplete, status('steadfast'), status('redx')], settings })
      .mockResolvedValue({
        providers: [status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' }), status('steadfast'), status('redx')],
        settings,
      });
    mocks.getPathaoCities.mockResolvedValue([{ id: 1, name: 'Dhaka' }]);
    mocks.getPathaoZones.mockResolvedValue([{ id: 2, name: 'Gulshan' }]);
    mocks.getPathaoAreas.mockResolvedValue([{ id: 3, name: 'Gulshan 1' }]);
    mocks.activateDeliveryProvider
      .mockRejectedValueOnce({ statusCode: 409, details: { missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'] } })
      .mockResolvedValueOnce(undefined);

    await renderSettings();
    // Connect is settled → Manage opens the drawer; Activate lives there now.
    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: 'Manage Pathao Courier' });
    fireEvent.click(screen.getByTestId('drawer-activate-pathao'));

    await waitFor(() => expect(mocks.activateDeliveryProvider).toHaveBeenCalledTimes(1));
    // The redesign routes the merchant to the Pickup TAB (no modal in the wired shell).
    await waitFor(() => expect(screen.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('pickup-form')).toBeInTheDocument();
    expect(screen.getByText('New Pathao pickup location')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('pickup-form-name'), { target: { value: 'Main pickup' } });
    fireEvent.change(document.getElementById('pickup-form-phone') as HTMLElement, { target: { value: '01712345678' } });
    await screen.findByRole('option', { name: 'Dhaka' });
    fireEvent.change(screen.getByRole('combobox', { name: 'City' }), { target: { value: '1' } });
    await waitFor(() => expect(mocks.getPathaoZones).toHaveBeenCalledWith(1));
    await screen.findByRole('option', { name: 'Gulshan' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Zone' }), { target: { value: '2' } });
    await waitFor(() => expect(mocks.getPathaoAreas).toHaveBeenCalledWith(2));
    await screen.findByRole('option', { name: 'Gulshan 1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('pickup-form-address'), { target: { value: 'House 1, Dhaka' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));

    await waitFor(() => expect(mocks.createPickupLocation).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'Main pickup',
      phone: '01712345678',
      area_name: 'Gulshan 1',
    })));
    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalledWith('pathao', expect.objectContaining({
      pickup_location_id: 'pickup-1',
      provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
    })));
    // The redesign keeps activation a separate explicit action — sync alone never activates.
    expect(mocks.activateDeliveryProvider).toHaveBeenCalledTimes(1);

    // Back to Providers: re-activate succeeds, chip flips only after the server-confirmed reload.
    fireEvent.click(screen.getByTestId('delivery-tab-providers'));
    await gotoTab('providers');
    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: 'Manage Pathao Courier' });
    fireEvent.click(screen.getByTestId('drawer-activate-pathao'));

    await waitFor(() => expect(mocks.activateDeliveryProvider).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('activation-status-pathao')).toHaveTextContent('Active');
  });

  it('clears the AI default through the delete route and drops the badge after the reload', async () => {
    mocks.getDeliverySettings
      .mockResolvedValueOnce({
        providers: [status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', is_ai_default: true })],
        settings,
      })
      .mockResolvedValue({
        providers: [status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', is_ai_default: false })],
        settings,
      });

    await renderSettings();
    expect(screen.getByTestId('ai-default-badge-pathao')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: 'Manage Pathao Courier' });
    fireEvent.click(screen.getByTestId('drawer-clear-ai-pathao'));

    await waitFor(() => expect(mocks.clearAiDefault).toHaveBeenCalledWith('pathao'));
    expect(await screen.findByTestId('provider-feedback-pathao')).toHaveTextContent('no longer the AI default');
    await waitFor(() => expect(screen.queryByTestId('ai-default-badge-pathao')).toBeNull());
  });

  it('does not request or write legacy delivery platform priority', async () => {
    await renderSettings();

    expect(mocks.getDeliverySettings).toHaveBeenCalledTimes(1);
  });
});
