/**
 * Delivery-settings guardrails contracts (§8/§16/§17/§29): channel signal
 * matrix, execution header without CTA, provider heading/AI-default sibling
 * structure, capability honesty ceiling, disconnect confirmation dialog,
 * activation-409 pickup flow, weight-tier validation. Additive suite; the
 * legacy DeliverySettings/PickupDetailsModal suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DeliverySettings from '../DeliverySettings';
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
  getPickupLocations: vi.fn(async () => []),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
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
  vi.mocked(orderApi.getDeliverySettings).mockResolvedValue({ providers, settings } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings([status('pathao'), status('steadfast'), status('redx')]);
});

describe('delivery signal header', () => {
  it('shows title + signal + pills and no header CTA', async () => {
    render(<DeliverySettings />);
    const signal = await screen.findByTestId('delivery-signal');
    expect(signal.textContent).toContain('Couriers need setup');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
  });

  it('maps active / action-required / load-failure to distinct signals', async () => {
    mockSettings([status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' })]);
    const { unmount } = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByTestId('delivery-signal').textContent).toContain('Couriers ready'));
    unmount();

    mockSettings([status('pathao', { is_connected: true, activation_status: 'ACTION_REQUIRED' })]);
    const second = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByTestId('delivery-signal').textContent).toContain('Couriers need setup'));
    second.unmount();

    vi.mocked(orderApi.getDeliverySettings).mockRejectedValue(new Error('boom'));
    const third = render(<DeliverySettings />);
    await waitFor(() => expect(screen.getByTestId('delivery-signal').textContent).toContain('Delivery settings unavailable'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    third.unmount();
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
    expect(screen.getByRole('button', { name: 'Set as AI default' })).toBeInTheDocument();
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

  it('disconnect requires an in-system danger confirmation', async () => {
    mockSettings([status('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE' })]);
    vi.mocked(orderApi.disconnectDeliveryProvider).mockResolvedValue({} as never);
    render(<DeliverySettings />);
    const trigger = await screen.findByTestId('disconnect-pathao');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(orderApi.disconnectDeliveryProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId('delivery-disconnect-confirm'));
    await waitFor(() => expect(orderApi.disconnectDeliveryProvider).toHaveBeenCalledWith('pathao'));
  });

  it('activation 409 opens the pickup-details dialog with the missing list', async () => {
    mockSettings([status('pathao', { is_connected: true, activation_status: 'SETUP_INCOMPLETE' })]);
    vi.mocked(orderApi.activateDeliveryProvider).mockRejectedValue({
      statusCode: 409,
      details: { missing: ['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address'] },
    });
    render(<DeliverySettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Pickup details' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Pickup name/i })).toBeInTheDocument();
  });
});

describe('pricing validation', () => {
  it('rejects inverted weight tiers before calling the API', async () => {
    render(<DeliverySettings />);
    await screen.findByTestId('delivery-signal');
    const fromInput = screen.getByPlaceholderText('From (kg)');
    fireEvent.change(fromInput, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Each weight tier must have From (kg) less than To (kg)'));
    expect(orderApi.updateDeliverySettings).not.toHaveBeenCalled();
  });

  it('offers the same save affordance in both pricing cards and confirms beside it', async () => {
    render(<DeliverySettings />);
    await screen.findByTestId('delivery-signal');
    // The merchant edits at the bottom of the page; the save must be there too,
    // not only in the General card header far above.
    const weightSave = screen.getByTestId('weight-charges-save');
    const areaSave = screen.getByTestId('area-pricing-save');
    expect(weightSave).toHaveAccessibleName('Save delivery charges');
    expect(areaSave).toHaveAccessibleName('Save delivery charges');

    fireEvent.change(screen.getByPlaceholderText('To (kg)'), { target: { value: '5' } });
    fireEvent.click(weightSave);
    await waitFor(() => expect(orderApi.updateDeliverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ weight_tiers: [{ from_kg: 0, to_kg: 5, extra_charge: 0 }] }),
    ));
    // Confirmation lands next to the action, not only in the page-top banner.
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0));
    // …and clears as soon as the merchant edits again.
    fireEvent.change(screen.getByPlaceholderText('To (kg)'), { target: { value: '7' } });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('says the weight tiers are recorded only, not applied to quotes', async () => {
    render(<DeliverySettings />);
    await screen.findByTestId('delivery-signal');
    expect(screen.getByText(/not applied to delivery quotes or courier bookings yet/i)).toBeInTheDocument();
  });
});
