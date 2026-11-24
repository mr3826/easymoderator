/**
 * A3 ChargesTab unit tests (Delivery Settings redesign, Tab 3).
 *
 * The tab is fully controlled by the shell (A0): every edit flows up through
 * onChange and the single PUT lives in the shell. These tests therefore mock
 * the whole '@/api/domains/order' module (defensive — the tab itself imports
 * no API) and use a tiny shell-harness that mirrors A0's contract: shared
 * settings state + saved-snapshot equality driving isDirty/justSaved.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ChargesTab, type ChargesTabProps } from '../ChargesTab';
import type { DeliveryShopSettings } from '@/api/types/order';

vi.mock('@/api/domains/order', () => ({
  getDeliverySettings: vi.fn(),
  updateDeliverySettings: vi.fn(),
}));

const LABELS: Record<string, string> = {
  'manageShop.deliverySettings.zoneInsideDhaka': 'Inside Dhaka',
  'manageShop.deliverySettings.zoneSubDhaka': 'Sub Dhaka',
  'manageShop.deliverySettings.zoneOutsideDhaka': 'Outside Dhaka',
  'manageShop.deliverySettings.generalSettings': 'General settings',
  'manageShop.deliverySettings.defaultCharge': 'Default charge',
  'manageShop.deliverySettings.codCharge': 'COD charge',
  'manageShop.deliverySettings.enableCOD': 'Enable COD',
  'manageShop.deliverySettings.nonRefundable': 'Non-refundable',
  'manageShop.deliverySettings.saveSettings': 'Save Settings',
  'manageShop.deliverySettings.saveCharges': 'Save delivery charges',
  'manageShop.deliverySettings.saveChargesScope': 'Saves the general, area and weight settings on this page.',
  'manageShop.deliverySettings.chargesSaved': 'Saved',
  'manageShop.deliverySettings.areaBasedPricing': 'Area pricing',
  'manageShop.deliverySettings.addArea': 'Add area',
  'manageShop.deliverySettings.codAllowed': 'COD allowed',
  'manageShop.deliverySettings.removeArea': 'Remove area',
  'manageShop.deliverySettings.weightCharges': 'Weight charges',
  'manageShop.deliverySettings.addTier': 'Add tier',
  'manageShop.deliverySettings.removeTier': 'Remove tier',
  'manageShop.deliverySettings.weightFrom': 'From (kg)',
  'manageShop.deliverySettings.weightTo': 'To (kg)',
  'manageShop.deliverySettings.extraCharge': 'Extra charge',
  'manageShop.deliverySettings.noTiers': 'No weight tiers added yet.',
  'manageShop.deliverySettings.weightTierTooltip': 'Weight tier guide',
  'manageShop.deliverySettings.weightTierInfo':
    'Recorded for your reference — these tiers are not applied to delivery quotes or courier bookings yet.',
  'manageShop.deliverySettings.errors.invalidWeightTiers':
    'Each weight tier must have From (kg) less than To (kg)',
  'manageShop.deliverySettings.errors.saveFailed': 'Failed to save delivery settings',
  'manageShop.deliverySettings.charges.unsavedChanges': 'Unsaved changes',
  'manageShop.deliverySettings.charges.allChangesSaved': 'All changes saved',
  'manageShop.deliverySettings.charges.fixBeforeSave': 'Fix the highlighted fields before saving.',
  'manageShop.deliverySettings.charges.duplicateZone':
    'Each area can appear only once. Choose a different area for this row.',
  'manageShop.deliverySettings.charges.overlappingTiers':
    'Weight ranges must not overlap, so each weight falls in one tier.',
  'manageShop.deliverySettings.charges.negativeValue':
    'Charge and weight values must be zero or more. Enter 0 for no charge.',
  'manageShop.deliverySettings.charges.areaCharge': 'Delivery charge',
  'manageShop.deliverySettings.charges.areaZone': 'Delivery area',
  'manageShop.deliverySettings.charges.enableCodToEdit': 'Turn on cash on delivery below to set this charge.',
  'manageShop.deliverySettings.charges.codChargeRecorded':
    'Saved for your records. Bot quotes and courier bookings do not add this charge yet.',
  'manageShop.deliverySettings.charges.nonRefundableRecorded':
    'Saved for your records. It does not change refund handling yet.',
  'manageShop.deliverySettings.charges.codAvailabilityNote':
    'This note is saved for your records. Whether the assistant offers cash on delivery follows Payment Settings.',
  'manageShop.deliverySettings.charges.areaCodRecorded':
    'These COD toggles are saved for your records; the assistant COD offer still comes from Payment Settings.',
  'manageShop.deliverySettings.charges.areasRevertNote':
    'With no area rows, the default pricing returns on save:',
  'manageShop.deliverySettings.charges.tiersRevertNote':
    'With no weight tiers, the default range returns on save:',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key.endsWith('.charges.areaCount')) {
        return `${values?.formatted ?? ''} ${values?.count === 1 ? 'area priced' : 'areas priced'}`;
      }
      if (key.endsWith('.charges.tierCount')) {
        return `${values?.formatted ?? ''} ${values?.count === 1 ? 'weight range' : 'weight ranges'}`;
      }
      if (key.endsWith('.charges.areasRevertNote') || key.endsWith('.charges.tiersRevertNote')) {
        return `${LABELS[key]} ${values?.defaults ?? ''}`;
      }
      return LABELS[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

const DEFAULT_AREAS: DeliveryShopSettings['area_pricing'] = [
  { zone: 'inside_dhaka', charge: 60, cod_enabled: false },
  { zone: 'sub_dhaka', charge: 80, cod_enabled: false },
  { zone: 'outside_dhaka', charge: 120, cod_enabled: false },
];

const DEFAULT_TIERS: DeliveryShopSettings['weight_tiers'] = [{ from_kg: 0, to_kg: 1, extra_charge: 0 }];

const baseSettings = (): DeliveryShopSettings => ({
  default_delivery_charge: 60,
  cod_enabled: false,
  cod_charge: 0,
  non_refundable: false,
  area_pricing: DEFAULT_AREAS.map((area) => ({ ...area })),
  weight_tiers: DEFAULT_TIERS.map((tier) => ({ ...tier })),
});

// Mirrors the shell's applyDefaults (empty list -> platform defaults).
const applyDefaults = (incoming?: Partial<DeliveryShopSettings> | null): DeliveryShopSettings => ({
  default_delivery_charge: Number.isFinite(Number(incoming?.default_delivery_charge))
    ? Number(incoming?.default_delivery_charge)
    : 60,
  cod_enabled: incoming?.cod_enabled ?? false,
  cod_charge: Number.isFinite(Number(incoming?.cod_charge)) ? Number(incoming?.cod_charge) : 0,
  non_refundable: incoming?.non_refundable ?? false,
  area_pricing: incoming?.area_pricing && incoming.area_pricing.length > 0
    ? incoming.area_pricing
    : DEFAULT_AREAS.map((area) => ({ ...area })),
  weight_tiers: incoming?.weight_tiers && incoming.weight_tiers.length > 0
    ? incoming.weight_tiers
    : DEFAULT_TIERS.map((tier) => ({ ...tier })),
});

function renderStatic(overrides: Partial<ChargesTabProps> = {}) {
  const props: ChargesTabProps = {
    settings: baseSettings(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    onDirtyChange: vi.fn(),
    isDirty: false,
    justSaved: false,
    errors: null,
    applyDefaults,
    ...overrides,
  };
  render(<ChargesTab {...props} />);
  return props;
}

/** Shell-harness: shared settings + snapshot-equality dirty/saved semantics. */
function setupHarness(initial: DeliveryShopSettings = baseSettings()) {
  const onSave = vi.fn();
  const onDirtyChange = vi.fn();
  // Mirrors the shell's one shared settings object (the tab never owns it).
  const shared: { settings: DeliveryShopSettings } = { settings: initial };

  function Harness() {
    const [settings, setSettings] = useState<DeliveryShopSettings>(initial);
    const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initial));
    const [justSaved, setJustSaved] = useState(false);
    const isDirty = savedSnapshot !== JSON.stringify(settings);

    const handleChange = (next: DeliveryShopSettings) => {
      shared.settings = next;
      setJustSaved(false); // editing drops the card back to unsaved
      setSettings(next);
    };
    const handleSave = () => {
      // Records the payload and simulates the server-confirmed PUT outcome.
      onSave(JSON.parse(JSON.stringify(settings)));
      setSavedSnapshot(JSON.stringify(settings));
      setJustSaved(true);
    };

    return (
      <ChargesTab
        settings={settings}
        onChange={handleChange}
        onSave={handleSave}
        onDirtyChange={onDirtyChange}
        isDirty={isDirty}
        justSaved={justSaved}
        errors={null}
        applyDefaults={applyDefaults}
      />
    );
  }

  render(<Harness />);
  return { onSave, onDirtyChange, getSettings: () => shared.settings };
}

describe('ChargesTab — pricing forms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the shared scope copy, the recorded-only disclosures and bn-aware counts', () => {
    renderStatic();

    // Test-pinned scope copy on every save row.
    expect(screen.getAllByText('Saves the general, area and weight settings on this page.').length).toBeGreaterThanOrEqual(2);
    // Test-pinned weight-tier honesty band + tooltip.
    expect(screen.getByText(
      'Recorded for your reference — these tiers are not applied to delivery quotes or courier bookings yet.',
    )).toBeInTheDocument();
    expect(screen.getByTitle('Weight tier guide')).toBeInTheDocument();
    // Dead-field honesty copy — never a claim that these change charges.
    expect(screen.getByText('Saved for your records. Bot quotes and courier bookings do not add this charge yet.')).toBeInTheDocument();
    expect(screen.getByText('Saved for your records. It does not change refund handling yet.')).toBeInTheDocument();
    expect(screen.getByText('This note is saved for your records. Whether the assistant offers cash on delivery follows Payment Settings.')).toBeInTheDocument();
    expect(screen.getByText('These COD toggles are saved for your records; the assistant COD offer still comes from Payment Settings.')).toBeInTheDocument();
    // Counts render through Intl.NumberFormat (bn-BD numerals for bn).
    expect(screen.getByText('3 areas priced')).toBeInTheDocument();
    expect(screen.getByText('1 weight range')).toBeInTheDocument();
  });

  it('keeps the COD charge disabled and explained until COD availability is on', () => {
    const harness = setupHarness();

    expect(screen.getByRole('spinbutton', { name: 'COD charge' })).toBeDisabled();
    expect(screen.getByText('Turn on cash on delivery below to set this charge.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable COD' }));
    expect(harness.getSettings().cod_enabled).toBe(true);
    expect(screen.getByRole('spinbutton', { name: 'COD charge' })).toBeEnabled();
    expect(screen.queryByText('Turn on cash on delivery below to set this charge.')).not.toBeInTheDocument();
  });

  it('accepts a zero-valued charge and persists it through the shared settings prop', () => {
    const harness = setupHarness();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Default charge' }), { target: { value: '0' } });
    expect(harness.getSettings().default_delivery_charge).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(harness.onSave).toHaveBeenCalledTimes(1);
    expect(harness.onSave.mock.calls[0][0]).toEqual(expect.objectContaining({ default_delivery_charge: 0 }));

    // Zero area charge is accepted too (Joi only requires >= 0).
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Delivery charge 1' }), { target: { value: '0' } });
    expect(harness.getSettings().area_pricing[0].charge).toBe(0);
    fireEvent.click(screen.getByTestId('area-pricing-save'));
    expect(harness.onSave).toHaveBeenCalledTimes(2);
    expect(harness.onSave.mock.calls[1][0]).toEqual(expect.objectContaining({
      area_pricing: expect.arrayContaining([expect.objectContaining({ charge: 0 })]),
    }));
  });

  it('rejects a negative area charge before onSave (Joi min(0) mirror)', () => {
    const harness = setupHarness();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Delivery charge 1' }), { target: { value: '-5' } });
    expect(screen.getByText('Charge and weight values must be zero or more. Enter 0 for no charge.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('area-pricing-save'));
    expect(harness.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('must be zero or more');
  });

  it('toggles per-area COD and persists it via onSave', () => {
    const harness = setupHarness();

    const codBoxes = screen.getAllByRole('checkbox', { name: 'COD allowed' });
    fireEvent.click(codBoxes[1]);
    expect(harness.getSettings().area_pricing[1].cod_enabled).toBe(true);

    fireEvent.click(screen.getByTestId('area-pricing-save'));
    expect(harness.onSave).toHaveBeenCalledWith(expect.objectContaining({
      area_pricing: expect.arrayContaining([expect.objectContaining({ zone: 'sub_dhaka', cod_enabled: true })]),
    }));
  });

  it('rejects an inverted weight tier before onSave and preserves the input', () => {
    const harness = setupHarness();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'From (kg) 1' }), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('weight-charges-save'));

    expect(harness.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Each weight tier must have From (kg) less than To (kg)');
    // Input preserved after rejection (§12).
    expect(screen.getByRole('spinbutton', { name: 'From (kg) 1' })).toHaveValue(5);

    // Fixing the row clears the rejection and lets the save through.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'To (kg) 1' }), { target: { value: '6' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByTestId('weight-charges-save'));
    expect(harness.onSave).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping weight tiers before onSave', () => {
    const harness = setupHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Add tier' }));
    // New tier continues from the heaviest range: 1–2, valid next to 0–1.
    expect(harness.getSettings().weight_tiers).toHaveLength(2);
    expect(harness.getSettings().weight_tiers[1]).toEqual({ from_kg: 1, to_kg: 2, extra_charge: 0 });

    // Make it overlap 0–1 on purpose.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'From (kg) 2' }), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('weight-charges-save'));

    expect(harness.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Weight ranges must not overlap, so each weight falls in one tier.');
  });

  it('rejects a duplicate zone before onSave', () => {
    const harness = setupHarness();

    fireEvent.change(screen.getByRole('combobox', { name: 'Area pricing 2' }), { target: { value: 'inside_dhaka' } });
    expect(screen.getByText('Each area can appear only once. Choose a different area for this row.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('area-pricing-save'));
    expect(harness.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Each area can appear only once');
  });

  it('flags the honest duplicate when every zone is already priced', () => {
    const harness = setupHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Add area' }));
    const areas = harness.getSettings().area_pricing;
    expect(areas).toHaveLength(4);
    expect(areas[3].zone).toBe('inside_dhaka');
    expect(screen.getByText('Each area can appear only once. Choose a different area for this row.')).toBeInTheDocument();
  });

  it('walks clean -> unsaved -> saved with a clear indicator per state', () => {
    setupHarness();

    // Clean at rest: save disabled with a visible reason, nothing scary.
    const saveButton = screen.getByTestId('area-pricing-save');
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAccessibleName('Save delivery charges');
    // The same status chip appears on every save affordance — assert it, not a count.
    expect(screen.getAllByText('All changes saved').length).toBeGreaterThan(0);

    // Edit: unsaved indicator + enabled save; dirty flag reported to the shell.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Default charge' }), { target: { value: '70' } });
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);
    expect(screen.getByTestId('area-pricing-save')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled();

    // Server-confirmed save: Saved indicator returns on every card.
    fireEvent.click(screen.getByTestId('area-pricing-save'));
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);
    expect(screen.getByTestId('weight-charges-save')).toBeDisabled();
  });

  it('reports tab dirty state to the shell', () => {
    const harness = setupHarness();
    expect(harness.onDirtyChange).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Extra charge 1' }), { target: { value: '20' } });
    expect(harness.onDirtyChange).toHaveBeenCalledWith(true);
    expect(harness.getSettings().weight_tiers[0].extra_charge).toBe(20);
  });

  it('shows honest fallback copy naming the real defaults when rows are cleared', () => {
    const harness = setupHarness();

    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remove area' })[0]);
    }
    expect(harness.getSettings().area_pricing).toHaveLength(0);
    expect(screen.getByText(/With no area rows, the default pricing returns on save:/)).toHaveTextContent(
      'Inside Dhaka ৳60 · Sub Dhaka ৳80 · Outside Dhaka ৳120',
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove tier' })[0]);
    expect(screen.getByText('No weight tiers added yet.')).toBeInTheDocument();
    expect(screen.getByText(/With no weight tiers, the default range returns on save:/)).toHaveTextContent('0–1 kg');
  });

  it('surfaces the shell save error inline and lets the merchant retry', () => {
    const props = renderStatic({ errors: 'Failed to save delivery settings', isDirty: true });

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save delivery settings');
    expect(screen.getByTestId('area-pricing-save')).toBeEnabled();

    fireEvent.click(screen.getByTestId('area-pricing-save'));
    // Valid data still goes up to the shell — the retry is the shell's PUT.
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });
});
