/**
 * Delivery-settings guardrails contracts (§8/§16/§17) — tabbed shell edition.
 * Header-removal C1/C6 flip: the `delivery-signal` band is an ABSENCE pin, the
 * honest status matrix is re-anchored to the record-level provider chips, and
 * the no-header-CTA guard stays as a positive absence pin. Provider heading/AI-default
 * sibling structure, capability honesty ceiling, disconnect danger confirmation
 * (now type-to-confirm inside the management drawer), activation-409 → Pickup TAB
 * routing (with the legacy PickupDetailsModal fallback pinned for unwired shells),
 * charges-tab save contract (identical affordance, scope copy, Saved indicator,
 * inverted-tier rejection, zero charge), keyboard tablist. Real i18n + real en.json.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DeliverySettings from '../DeliverySettings';
import ProvidersTab from '../delivery/ProvidersTab';
import * as orderApi from '@/api/domains/order';

vi.mock('@/api/domains/order', () => ({
  getDeliverySettings: vi.fn(),
  updateDeliverySettings: vi.fn(),
  connectDeliveryProvider: vi.fn(),
  disconnectDeliveryProvider: vi.fn(),
  testDeliveryConnection: vi.fn(),
  activateDeliveryProvider: vi.fn(),
  deactivateDeliveryProvider: vi.fn(),
  setAiDefaultDeliveryProvider: vi.fn(),
  clearAiDefault: vi.fn(),
  getPickupLocations: vi.fn(async () => []),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  listProviderStores: vi.fn(async () => ({ stores: [], pickup_locations: [] })),
  importProviderStores: vi.fn(async () => ({ stores: [], pickup_locations: [] })),
  setProviderPickup: vi.fn(),
  createProviderStore: vi.fn(),
  setDefaultPickupLocation: vi.fn(),
  deletePickupLocation: vi.fn(),
  retryPickupSync: vi.fn(),
  getProviderAreas: vi.fn(async () => []),
  getPathaoCities: vi.fn(async () => []),
  getPathaoZones: vi.fn(async () => []),
  getPathaoAreas: vi.fn(async () => []),
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

const status = (provider: string, overrides: Record<string, unknown> = {}) => ({
  provider,
  display_name: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`,
  is_connected: false,
  is_active: false,
  is_sandbox: false,
  metadata: {},
  last_validated_at: null,
  connected_at: null,
  capabilities,
  ...overrides,
});

const settings = {
  default_delivery_charge: 60,
  cod_enabled: false,
  cod_charge: 0,
  non_refundable: false,
  area_pricing: [],
  weight_tiers: [{ from_kg: 0, to_kg: 1, extra_charge: 0 }],
};

const mockSettings = (providers: unknown[]) => {
  vi.mocked(orderApi.getDeliverySettings).mockResolvedValue({ providers, settings, pickup_locations: [] } as never);
};

const openChargesTab = async () => {
  await screen.findByTestId('delivery-tab-providers');
  fireEvent.click(screen.getByTestId('delivery-tab-charges'));
  return screen.findByTestId('charges-tab');
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings([status('pathao'), status('steadfast'), status('redx')]);
});

describe('page signal header removed (C1/C6 absence pins)', () => {
  it('renders no signal band, keeps the level-1 title and no header CTA', async () => {
    render(<DeliverySettings />);
    await screen.findByTestId('delivery-tab-providers');
    expect(screen.queryByTestId('delivery-signal')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
  });

  it('keeps active / action-required / load-failure truth at record level', async () => {
    mockSettings([status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' })]);
    const { unmount } = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByTestId('activation-status-pathao').textContent).toContain('Active'));
    expect(screen.queryByTestId('delivery-signal')).toBeNull();
    unmount();

    mockSettings([status('pathao', { is_connected: true, activation_status: 'ACTION_REQUIRED' })]);
    const second = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByTestId('activation-status-pathao').textContent).toContain('Action required'));
    expect(screen.queryByTestId('delivery-signal')).toBeNull();
    second.unmount();

    vi.mocked(orderApi.getDeliverySettings).mockRejectedValue(new Error('boom'));
    const third = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('delivery-signal')).toBeNull();
    third.unmount();
  });
});

describe('tab shell', () => {
  it('exposes a real tablist: roles, controlled panels and roving arrow-key focus', async () => {
    render(<DeliverySettings />);
    await screen.findByTestId('delivery-tab-providers');
    const providersTab = screen.getByTestId('delivery-tab-providers');
    const pickupTab = screen.getByTestId('delivery-tab-pickup');
    const chargesTab = screen.getByTestId('delivery-tab-charges');
    expect(providersTab).toHaveAttribute('role', 'tab');
    expect(providersTab).toHaveAttribute('aria-controls', 'delivery-panel-providers');
    const panel = document.getElementById('delivery-panel-providers');
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'delivery-tab-providers');

    fireEvent.keyDown(pickupTab, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('delivery-tab-charges')).toHaveAttribute('aria-selected', 'true'));
    expect(document.getElementById('delivery-panel-charges')).toHaveAttribute('aria-labelledby', 'delivery-tab-charges');

    fireEvent.keyDown(chargesTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(pickupTab).toHaveAttribute('aria-selected', 'true'));
  });
});

describe('provider cards', () => {
  it('keeps provider headings with the AI-default badge as a sibling', async () => {
    mockSettings([
      status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', is_ai_default: true }),
      status('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE' }),
    ]);
    render(<DeliverySettings />);
    const heading = await screen.findByRole('heading', { name: 'Pathao Courier' });
    expect(within(heading.parentElement as HTMLElement).getByText('AI Default')).toBeInTheDocument();
    expect(screen.getAllByText('AI Default')).toHaveLength(1);
    // The set/clear affordance moved into the contextual management drawer.
    fireEvent.click(screen.getByTestId('manage-steadfast'));
    const drawer = await screen.findByRole('dialog', { name: 'Manage Steadfast Courier' });
    expect(within(drawer).getByRole('button', { name: 'Set as AI default' })).toBeInTheDocument();
  });

  it('states capability truth without ever claiming live verification', async () => {
    mockSettings([status('steadfast', { is_connected: true })]);
    render(<DeliverySettings />);
    const panel = await screen.findByTestId('provider-capabilities-steadfast');
    fireEvent.click(within(panel).getByText('What this courier can do'));
    expect(screen.getByTestId('capability-steadfast-rate_quote')).toHaveTextContent('Not supported');
    expect(screen.getByTestId('capability-steadfast-coverage')).toHaveTextContent('Cannot be checked');
    expect(screen.getByTestId('capability-steadfast-create_parcel')).toHaveTextContent('Implemented, not live-verified');
    expect(screen.queryByText('Live-verified', { exact: true })).not.toBeInTheDocument();
  });

  it('disconnect requires an in-system type-to-confirm danger dialog inside the drawer', async () => {
    mockSettings([status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' })]);
    vi.mocked(orderApi.disconnectDeliveryProvider).mockResolvedValue({} as never);
    render(<DeliverySettings />);
    fireEvent.click(await screen.findByTestId('manage-pathao'));
    const trigger = await screen.findByTestId('disconnect-pathao');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: /Are you sure you want to disconnect/ });
    expect(orderApi.disconnectDeliveryProvider).not.toHaveBeenCalled();
    // §12: the destructive action is impossible without the typed provider name.
    expect(screen.getByTestId('delivery-disconnect-confirm')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type Pathao Courier to confirm/), { target: { value: 'Pathao' } });
    expect(screen.getByTestId('delivery-disconnect-confirm')).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Are you sure you want to disconnect/ })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    expect(orderApi.disconnectDeliveryProvider).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const dialog2 = await screen.findByRole('dialog', { name: /Are you sure you want to disconnect/ });
    fireEvent.change(screen.getByLabelText(/Type Pathao Courier to confirm/), { target: { value: 'Pathao Courier' } });
    fireEvent.click(within(dialog2).getByTestId('delivery-disconnect-confirm'));
    await waitFor(() => expect(orderApi.disconnectDeliveryProvider).toHaveBeenCalledWith('pathao'));
  });

  it('routes an activation 409 to the Pickup tab with the provider create form', async () => {
    mockSettings([status('pathao', {
      is_connected: true,
      activation_status: 'SETUP_INCOMPLETE',
      missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'],
    })]);
    vi.mocked(orderApi.activateDeliveryProvider).mockRejectedValue({
      statusCode: 409,
      details: { missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'] },
    });
    render(<DeliverySettings />);
    fireEvent.click(await screen.findByTestId('manage-pathao'));
    await screen.findByRole('dialog', { name: 'Manage Pathao Courier' });
    fireEvent.click(screen.getByTestId('drawer-activate-pathao'));

    await waitFor(() => expect(screen.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true'));
    // The pickup workspace replaces the old dialog: same required fields, in-tab now.
    const heading = await screen.findByRole('heading', { name: 'New Pathao pickup location' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Pickup name/i })).toBeInTheDocument();
    // The shell wiring means NO legacy modal opens.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still falls back to the legacy PickupDetailsModal when the shell has not wired tab routing', async () => {
    vi.mocked(orderApi.activateDeliveryProvider).mockRejectedValue({
      statusCode: 409,
      details: { missing: ['pickup_name', 'pickup_phone'] },
    });
    render(
      <ProvidersTab
        providers={[status('pathao', {
          is_connected: true,
          activation_status: 'SETUP_INCOMPLETE',
          missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'],
        })] as never}
        onMutate={vi.fn(async () => {})}
      />,
    );
    // No onCompletePickup → the card-level "Complete pickup details" opens the modal.
    fireEvent.click(screen.getByRole('button', { name: 'Complete pickup details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pickup details' });
    expect(within(dialog).getByRole('heading', { name: 'Pickup details' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Pickup name/i })).toBeInTheDocument();
  });
});

describe('pricing validation (charges tab)', () => {
  it('rejects inverted weight tiers before calling the API', async () => {
    render(<DeliverySettings />);
    await openChargesTab();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'From (kg) 1' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Each weight tier must have From (kg) less than To (kg)'));
    expect(orderApi.updateDeliverySettings).not.toHaveBeenCalled();
  });

  it('offers the same save affordance in both pricing cards with the scope copy and confirms beside it', async () => {
    vi.mocked(orderApi.updateDeliverySettings).mockResolvedValue(undefined as never);
    render(<DeliverySettings />);
    await openChargesTab();

    // The merchant edits inside the Charges tab; the save must live there too,
    // with the pinned scope copy stating exactly what one PUT persists.
    expect(screen.getAllByText('Saves the general, area and weight settings on this page.').length).toBeGreaterThanOrEqual(2);
    const weightSave = screen.getByTestId('weight-charges-save');
    const areaSave = screen.getByTestId('area-pricing-save');
    expect(weightSave).toHaveAccessibleName('Save delivery charges');
    expect(areaSave).toHaveAccessibleName('Save delivery charges');

    fireEvent.change(screen.getByRole('spinbutton', { name: 'To (kg) 1' }), { target: { value: '5' } });
    fireEvent.click(weightSave);
    await waitFor(() => expect(orderApi.updateDeliverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ weight_tiers: [{ from_kg: 0, to_kg: 5, extra_charge: 0 }] }),
    ));
    // Confirmation lands next to the action, not only in the page-top banner.
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0));
    // …and clears as soon as the merchant edits again.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'To (kg) 1' }), { target: { value: '7' } });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByTestId('delivery-charges-unsaved')).toBeInTheDocument();
  });

  it('accepts a zero default charge and persists it unchanged through the one PUT', async () => {
    vi.mocked(orderApi.updateDeliverySettings).mockResolvedValue(undefined as never);
    render(<DeliverySettings />);
    await openChargesTab();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Default Delivery Charge' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(orderApi.updateDeliverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ default_delivery_charge: 0 }),
    ));
  });

  it('says the weight tiers are recorded only, not applied to quotes', async () => {
    render(<DeliverySettings />);
    await openChargesTab();
    expect(screen.getByText(/not applied to delivery quotes or courier bookings yet/i)).toBeInTheDocument();
  });

  it('hydrates PERSISTED charges on a clean load and never claims unsaved state (A6 BLOCK-2 pin)', async () => {
    // Regression pin vs f574fd13, whose loader set settings from the server
    // UNCONDITIONALLY. The tabbed shell gates hydration on !dirtyRef.current,
    // but dirtyRef flips to true on first mount (snapshot is still null until
    // the first save), so the very first load can never hydrate: the merchant
    // sees platform defaults instead of their saved pricing and — worse —
    // pressing any enabled Save writes those defaults back over their real
    // values (data-unsafe). Evidence: prod-evidence/.../after-app-delivery-
    // charges-1440-en.png (fixture COD-on/25 vs rendered COD-off/0).
    const persisted = {
      default_delivery_charge: 500,
      cod_enabled: true,
      cod_charge: 25,
      non_refundable: true,
      area_pricing: [{ zone: 'inside_dhaka', charge: 40, cod_enabled: true }],
      weight_tiers: [{ from_kg: 2, to_kg: 5, extra_charge: 10 }],
    };
    vi.mocked(orderApi.getDeliverySettings).mockResolvedValue({
      providers: [status('pathao'), status('steadfast'), status('redx')],
      settings: persisted,
      pickup_locations: [],
    } as never);
    render(<DeliverySettings />);
    await openChargesTab();

    expect(screen.getByRole('spinbutton', { name: 'Default Delivery Charge' })).toHaveValue(500);
    expect(screen.getByRole('checkbox', { name: 'Enable Cash on Delivery' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Cash on Delivery Charge' })).toHaveValue(25);
    expect(screen.getByRole('checkbox', { name: 'Non-refundable Delivery Charge' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Delivery charge 1' })).toHaveValue(40);
    expect(screen.getByRole('spinbutton', { name: 'From (kg) 1' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'To (kg) 1' })).toHaveValue(5);
    expect(screen.getByRole('spinbutton', { name: 'Extra charge 1' })).toHaveValue(10);
    // A clean load is the saved state: no unsaved pill, saves disabled.
    expect(screen.queryByTestId('delivery-charges-unsaved')).toBeNull();
    expect(screen.getByTestId('area-pricing-save')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
  });
});
