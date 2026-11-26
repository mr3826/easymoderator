/**
 * A4 PoliciesTab unit tests (Business & FAQ Settings redesign, Tab 3).
 *
 * House rules honored here (03 §6): the WHOLE "@/api" module is mocked —
 * including A0's wired client names getShopBusinessPolicies /
 * updateShopBusinessPolicies — authService is mocked for the owner/staff
 * boundary, and i18n goes through a LABELS map so raw text assertions stay
 * readable. MODE==='test' collapses motion via the ANIMATE gate, so nothing
 * asserts on animation. Payloads are pinned to the exact contract shape:
 * only edited policy kinds, never `{}` placeholders, never invented defaults.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PoliciesTab from '../PoliciesTab';
import { apiClient } from '@/api';

const { mockGetCurrentShop, mockLang } = vi.hoisted(() => ({
  mockGetCurrentShop: vi.fn(),
  mockLang: { language: 'en' },
}));

vi.mock('@/api', () => ({
  apiClient: {
    getShopBusinessPolicies: vi.fn(),
    updateShopBusinessPolicies: vi.fn(),
  },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: () => mockGetCurrentShop(),
  },
}));

const LABELS: Record<string, string> = {
  'manageShop.businessFaq.policies.title': 'Business Policies',
  'manageShop.businessFaq.policies.stated': 'Stated',
  'manageShop.businessFaq.policies.unsavedPill': 'Unsaved changes',
  'manageShop.businessFaq.policies.informational':
    'These policies inform customer answers. They do not automatically approve or reject cancellations, refunds, exchanges or warranty claims.',
  'manageShop.businessFaq.policies.emptyHint': 'Until you state them, replies will not guess.',
  'manageShop.businessFaq.policies.retryLoad': 'Try again',
  'manageShop.businessFaq.policies.loading': 'Loading policies',
  'manageShop.businessFaq.policies.save': 'Save policies',
  'manageShop.businessFaq.policies.saving': 'Saving…',
  'manageShop.businessFaq.policies.saved': 'Policies saved',
  'manageShop.businessFaq.policies.reset': 'Discard changes',
  'manageShop.businessFaq.policies.ownerOnly': 'Only the shop owner can change these policies.',
  'manageShop.businessFaq.policies.lastSaved': 'Last saved',
  'manageShop.businessFaq.policies.notSet': '—',
  'manageShop.businessFaq.policies.help.aiProjection':
    'Saved facts flow into the assistant knowledge for customer replies; they never authorize actions by themselves.',
  'manageShop.businessFaq.policies.stance': 'Position',
  'manageShop.businessFaq.policies.notStated': 'Not stated yet',
  'manageShop.businessFaq.policies.offered': 'We offer this',
  'manageShop.businessFaq.policies.notOffered': 'We do not offer this',
  'manageShop.businessFaq.policies.conditional': 'Offered with conditions',
  'manageShop.businessFaq.policies.card.returns': 'Returns',
  'manageShop.businessFaq.policies.card.exchange': 'Exchange',
  'manageShop.businessFaq.policies.card.refunds': 'Refunds',
  'manageShop.businessFaq.policies.card.warranty': 'Warranty',
  'manageShop.businessFaq.policies.periodDays': 'Window (days)',
  'manageShop.businessFaq.policies.periodDaysHelp': 'Whole days between 0 and 365.',
  'manageShop.businessFaq.policies.details': 'Details',
  'manageShop.businessFaq.policies.detailsConditionalHelp':
    'Required — describe the conditions in your own words.',
  'manageShop.businessFaq.policies.exclusions': 'Exclusions',
  'manageShop.businessFaq.policies.process': 'Refund process',
  'manageShop.businessFaq.policies.duration': 'Warranty period',
  'manageShop.businessFaq.policies.coverage': 'Coverage',
  'manageShop.businessFaq.policies.coverageExclusions': 'Coverage exclusions',
  'manageShop.businessFaq.policies.errors.load': 'Could not load business policies.',
  'manageShop.businessFaq.policies.errors.save': 'Policies were not saved.',
  'manageShop.businessFaq.policies.errors.periodRange': 'Enter a whole number of days between 0 and 365.',
  'manageShop.businessFaq.policies.errors.detailsRequired':
    'Conditions are required when the position is conditional.',
  'manageShop.businessFaq.policies.errors.fixBeforeSave': 'Fix the highlighted fields before saving.',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const base = LABELS[key] ?? key;
      if (opts && typeof opts === 'object' && typeof opts.count === 'number') {
        return base.replace('{{count}}', String(opts.count));
      }
      return base;
    },
    i18n: mockLang,
  }),
}));

// A0 owns the facade; until its wiring merges, the mock module is addressed
// through the same slice interface the component uses (exact names per 03 §2).
type PoliciesApiSlice = {
  getShopBusinessPolicies: ReturnType<typeof vi.fn>;
  updateShopBusinessPolicies: ReturnType<typeof vi.fn>;
};
const api = apiClient as unknown as PoliciesApiSlice;
const get = api.getShopBusinessPolicies;
const put = api.updateShopBusinessPolicies;

function renderTab() {
  return render(
    <MemoryRouter>
      <PoliciesTab />
    </MemoryRouter>,
  );
}

const card = (key: string) => screen.getByTestId(`policy-card-${key}`);
const stance = (key: string) => screen.getByTestId(`policy-stance-${key}`);
const saveButton = () => screen.getByRole('button', { name: 'Save policies' });

/** Await the mount GET having settled into the ready render (all four cards
 *  exist only in the ready phase; error tests wait on their own branch). */
async function settled() {
  await waitFor(() => expect(screen.getByTestId('policy-card-returns')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLang.language = 'en';
  mockGetCurrentShop.mockReturnValue({ shop_name: 'Amber Boutique', role: 'owner' });
  get.mockResolvedValue({});
  put.mockResolvedValue({});
});

afterEach(() => {
  mockLang.language = 'en';
});

describe('PoliciesTab — absence honesty (Y3: absent ≠ {} ≠ not_offered)', () => {
  it('renders an empty GET as four "Not stated yet" cards and fabricates nothing', async () => {
    const { container } = renderTab();
    await settled();

    for (const key of ['returns', 'exchange', 'refunds', 'warranty']) {
      expect(stance(key)).toHaveValue('unspecified');
      expect(within(card(key)).queryByLabelText('Window (days)')).toBeNull();
      expect(within(card(key)).queryByLabelText('Details')).toBeNull();
    }

    // Nothing is dirty, so NOTHING may be written — no defaults ever leave the client.
    expect(saveButton()).toBeDisabled();
    expect(put).not.toHaveBeenCalled();

    // C1/C6: the tab signal band is an absence pin; the relocated stated
    // pill agrees with the empty server row.
    expect(screen.queryByTestId('policies-signal')).toBeNull();
    expect(screen.getByText('Stated: 0/4')).toBeInTheDocument();
    expect(screen.getByText('Until you state them, replies will not guess.')).toBeInTheDocument();

    // Mission §7 / Y4 disclosure is present in plain language.
    expect(screen.getByText(/do not automatically approve or reject cancellations/)).toBeInTheDocument();

    // P12 workspace boundary: native selects only — no ranges, no radiogroups.
    expect(container.querySelectorAll('input[type=range]')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('keeps absence and "not offered" as distinct server semantics on round-trip', async () => {
    get.mockResolvedValue({
      returns: { stance: 'offered', period_days: 7, details: 'Unopened only', exclusions: 'Final sale items' },
      exchange: { stance: 'not_offered' },
      refunds: { stance: 'conditional', details: 'Within 24h if unopened', process: 'Refund via bKash' },
    });
    renderTab();
    await settled();

    expect(stance('returns')).toHaveValue('offered');
    expect(within(card('returns')).getByLabelText('Window (days)')).toHaveValue(7);
    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Unopened only');
    expect(within(card('returns')).getByLabelText('Exclusions')).toHaveValue('Final sale items');

    // not_offered is an EXPLICIT stated position, visually distinct from absence:
    expect(stance('exchange')).toHaveValue('not_offered');
    expect(stance('warranty')).toHaveValue('unspecified');
    expect(within(card('exchange')).queryByLabelText('Window (days)')).toBeNull();
    // and it counts differently: 3/4 stated (warranty absent).
    expect(screen.getByText('Stated: 3/4')).toBeInTheDocument();

    expect(stance('refunds')).toHaveValue('conditional');
    expect(within(card('refunds')).getByLabelText('Refund process')).toHaveValue('Refund via bKash');
    // refunds has NO period_days kind — never rendered for it.
    expect(within(card('refunds')).queryByLabelText('Window (days)')).toBeNull();
    expect(within(card('refunds')).getByText('Required — describe the conditions in your own words.')).toBeInTheDocument();
  });

  it('shows the "—" notSet style for empty optional fields in the read-only view', async () => {
    mockGetCurrentShop.mockReturnValue({ shop_name: 'Amber Boutique', role: 'staff' });
    get.mockResolvedValue({ returns: { stance: 'offered', period_days: 7, details: 'Unopened only' } });
    renderTab();
    await settled();

    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Unopened only');
    // optional field without a stored value renders the honest em-dash, not ''.
    expect(within(card('returns')).getByLabelText('Exclusions')).toHaveAttribute('placeholder', '—');
  });
});

describe('PoliciesTab — save payload is the contract, byte for byte', () => {
  it('sends ONLY the edited policy kind, with stance + that kind\'s fields and nothing foreign', async () => {
    get.mockResolvedValue({
      returns: { stance: 'offered', period_days: 7, details: 'Unopened only', exclusions: 'Final sale' },
      exchange: { stance: 'offered', period_days: 3 },
      refunds: { stance: 'not_offered' },
      warranty: { stance: 'conditional', details: 'Manufacturing faults only', duration: '1 year', coverage: 'Parts', coverage_exclusions: 'Physical damage' },
    });
    renderTab();
    await settled();

    fireEvent.change(stance('exchange'), { target: { value: 'not_offered' } });
    expect(screen.getByTestId('policies-unsaved')).toBeInTheDocument();

    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    const body = put.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(['exchange']);
    expect(body).not.toHaveProperty('returns');
    expect(body).not.toHaveProperty('refunds');
    expect(body).not.toHaveProperty('warranty');
    // not_offered clears every field of THAT kind (period_days/details/exclusions)…
    expect(body.exchange).toEqual({ stance: 'not_offered', period_days: null, details: null, exclusions: null });
    // …and never carries another kind's fields.
    expect(body.exchange).not.toHaveProperty('process');
    expect(body.exchange).not.toHaveProperty('coverage');
  });

  it('writes an explicit "Not stated yet" as stance unspecified with nulls (absent ≠ this)', async () => {
    get.mockResolvedValue({
      warranty: { stance: 'offered', details: 'Motor only', exclusions: null, duration: '1 year', coverage: 'Parts', coverage_exclusions: 'Damage' },
    });
    renderTab();
    await settled();

    fireEvent.change(stance('warranty'), { target: { value: 'unspecified' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    const body = put.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(['warranty']);
    expect(body.warranty).toEqual({
      stance: 'unspecified',
      details: null,
      exclusions: null,
      duration: null,
      coverage: null,
      coverage_exclusions: null,
    });
  });

  it('trims edited text into the payload and numbers period_days (refunds shape)', async () => {
    renderTab();
    await settled();

    fireEvent.change(stance('refunds'), { target: { value: 'conditional' } });
    fireEvent.change(within(card('refunds')).getByLabelText('Details'), { target: { value: '  Within 24h, unopened  ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    expect(put.mock.calls[0][0]).toEqual({
      refunds: { stance: 'conditional', details: 'Within 24h, unopened', exclusions: null, process: null },
    });
  });
});

describe('PoliciesTab — validation blocks bad input before the server is asked', () => {
  it('rejects an out-of-range period_days, keeps the edit, and recovers after a fix', async () => {
    get.mockResolvedValue({ returns: { stance: 'offered', period_days: 7, details: 'Unopened only', exclusions: null } });
    renderTab();
    await settled();

    const period = within(card('returns')).getByLabelText('Window (days)');
    fireEvent.change(period, { target: { value: '400' } });
    fireEvent.click(saveButton());

    expect(put).not.toHaveBeenCalled();
    expect(period).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a whole number of days between 0 and 365.')).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted fields before saving.')).toBeInTheDocument();
    // §12 preserve input: the bad value is still there for correction.
    expect(period).toHaveValue(400);

    fireEvent.change(period, { target: { value: '15' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0].returns.period_days).toBe(15);
  });

  it('requires details before a conditional policy can be saved', async () => {
    renderTab();
    await settled();

    fireEvent.change(stance('refunds'), { target: { value: 'conditional' } });
    fireEvent.click(saveButton());

    expect(put).not.toHaveBeenCalled();
    expect(within(card('refunds')).getByLabelText('Details')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Conditions are required when the position is conditional.')).toBeInTheDocument();

    fireEvent.change(within(card('refunds')).getByLabelText('Details'), { target: { value: 'Only if unopened' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0].refunds).toEqual({
      stance: 'conditional',
      details: 'Only if unopened',
      exclusions: null,
      process: null,
    });
  });
});

describe('PoliciesTab — server-confirmed results only', () => {
  it('shows the status notice only after the awaited PUT and re-seeds from the RESPONSE', async () => {
    get.mockResolvedValue({ returns: { stance: 'offered', period_days: 7, details: 'old', exclusions: null } });
    put.mockResolvedValue({ returns: { stance: 'offered', period_days: 10, details: 'Unopened packaging', exclusions: null } });
    renderTab();
    await settled();

    fireEvent.change(within(card('returns')).getByLabelText('Window (days)'), { target: { value: '10' } });
    fireEvent.change(within(card('returns')).getByLabelText('Details'), { target: { value: '  Unopened packaging  ' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByText('Policies saved')).toBeInTheDocument();
    // Re-seeded from the server-normalized response, not the optimistic edit:
    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Unopened packaging');
    expect(within(card('returns')).getByLabelText('Window (days)')).toHaveValue(10);
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByTestId('policies-unsaved')).toBeNull();
  });

  it('shows role=alert on a rejected PUT, preserves edits, and claims no success', async () => {
    renderTab();
    await settled();

    fireEvent.change(stance('returns'), { target: { value: 'offered' } });
    fireEvent.change(within(card('returns')).getByLabelText('Details'), { target: { value: 'Defective items only' } });
    put.mockRejectedValue(new Error('Policy write failed'));

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Policy write failed')).toBeInTheDocument();
    expect(screen.queryByText('Policies saved')).toBeNull();
    // §12: edits survive the failure.
    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Defective items only');
    expect(within(card('returns')).getByLabelText('Exclusions')).toBeInTheDocument();
  });

  it('shows an honest em-dash for Last saved — the contract exposes no timestamp', async () => {
    renderTab();
    await settled();

    expect(screen.getByText('Last saved: —')).toBeInTheDocument();
  });
});

describe('PoliciesTab — load error, retry and permission boundary', () => {
  it('offers retry on load failure and recovers the cards from the server', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    get.mockResolvedValue({ returns: { stance: 'offered', period_days: 7, details: 'Unopened only', exclusions: null } });
    renderTab();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('policies-signal')).toBeNull();
    expect(screen.queryByTestId('policy-card-returns')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('policy-card-returns')).toBeInTheDocument());
    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Unopened only');
  });

  it('renders a read-only view with the owner note for non-owners (Y6)', async () => {
    mockGetCurrentShop.mockReturnValue({ shop_name: 'Amber Boutique', role: 'staff' });
    get.mockResolvedValue({ returns: { stance: 'offered', period_days: 7, details: 'Unopened only', exclusions: null } });
    renderTab();
    await settled();

    expect(stance('returns')).toBeDisabled();
    expect(stance('warranty')).toBeDisabled();
    expect(within(card('returns')).getByLabelText('Details')).toBeDisabled();
    expect(within(card('returns')).getByLabelText('Window (days)')).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Only the shop owner can change these policies.');
    // No affordance that could only 403 (the PUT is requireOwner server-side).
    expect(screen.queryByTestId('policies-save')).toBeNull();
    expect(put).not.toHaveBeenCalled();
    // Read values still render from the GET.
    expect(within(card('returns')).getByLabelText('Details')).toHaveValue('Unopened only');
  });
});

describe('PoliciesTab — localization', () => {
  it('formats the stated count with bn-BD numerals', async () => {
    mockLang.language = 'bn';
    get.mockResolvedValue({
      returns: { stance: 'offered' },
      exchange: { stance: 'not_offered' },
      refunds: { stance: 'conditional', details: 'x' },
    });
    renderTab();
    await settled();

    expect(screen.getByText('Stated: ৩/৪')).toBeInTheDocument();
  });
});
