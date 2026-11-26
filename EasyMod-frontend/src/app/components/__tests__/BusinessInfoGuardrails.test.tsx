/**
 * Business-info guardrails contracts (§8/§11/§16/§18 + ADR-0013 §1):
 * header-removal C1/C6 absence pins (no signal band, no header CTA, sr-only
 * h1 kept), label association, social group + char counter, dirty-gated save
 * with the 6-key payload (deliveryAreas/paymentMethods excluded), notice
 * roles, load-error retry, automation link, and the absence of any AI
 * control/radiogroup/range. Additive suite (real i18n en); the legacy
 * Form/Settings suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessInfoSettings from '../BusinessInfoSettings';
import { apiClient } from '@/api';

vi.mock('@/api', () => ({
  apiClient: {
    getShopBusinessInfo: vi.fn(),
    updateShopBusinessInfo: vi.fn(),
  },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getUser: vi.fn(() => ({ userId: 'user-1', shopId: 'shop-1' })),
    isAuthenticated: vi.fn(() => true),
    refreshShops: vi.fn(async () => undefined),
  },
}));

const fixture = (overrides: Record<string, unknown> = {}) => ({
  shopName: 'Test Shop',
  address: '123 Main St',
  phone: '01700000000',
  openingHours: '9am-6pm',
  additionalInfo: 'Exchange within 3 days.',
  socialLinks: { facebook: 'https://facebook.com/test' },
  deliveryAreas: ['Dhaka'],
  paymentMethods: ['COD'],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.getShopBusinessInfo).mockResolvedValue({ businessInfo: fixture(), shop: {} } as never);
  vi.mocked(apiClient.updateShopBusinessInfo).mockResolvedValue({ businessInfo: fixture() } as never);
});

async function renderPage(info: Record<string, unknown> = fixture()) {
  vi.mocked(apiClient.getShopBusinessInfo).mockResolvedValue({ businessInfo: info, shop: {} } as never);
  render(
    <MemoryRouter>
      <BusinessInfoSettings />
    </MemoryRouter>,
  );
  return screen.findByLabelText('Shop Name');
}

describe('page signal header removed (C1/C6 absence pins)', () => {
  it('renders no signal band, keeps the sr-only level-1 title and no header CTA', async () => {
    await renderPage();
    expect(screen.queryByTestId('business-signal')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Business Info' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    // The retired tally pills no longer render; the fields carry the truth.
    expect(screen.queryByText(/Social links:/)).toBeNull();
    expect(screen.queryByText(/Extra info:/)).toBeNull();
  });

  it('renders no signal band for an unnamed profile (the form is the ask)', async () => {
    await renderPage(fixture({ shopName: '' }));
    expect(screen.queryByTestId('business-signal')).toBeNull();
    expect(screen.getByLabelText('Shop Name')).toBeInTheDocument();
  });

  it('surfaces load failure through the alert with a working retry', async () => {
    vi.mocked(apiClient.getShopBusinessInfo)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ businessInfo: fixture(), shop: {} } as never);
    render(<MemoryRouter><BusinessInfoSettings /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error'));
    expect(screen.queryByTestId('business-signal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await screen.findByLabelText('Shop Name');
    expect(apiClient.getShopBusinessInfo).toHaveBeenCalledTimes(2);
  });
});

describe('form accessibility', () => {
  it('associates labels with inputs and groups the social pair', async () => {
    await renderPage();
    const name = screen.getByLabelText('Shop Name');
    expect(name).toHaveAttribute('id', 'bi-shopName');
    expect(screen.getByRole('textbox', { name: 'Phone' })).toHaveAttribute('id', 'bi-phone');
    expect(screen.getByRole('textbox', { name: 'Address' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Opening Hours' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Extra shop information' })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Social Media Links' });
    expect(within(group).getByLabelText('Facebook')).toBeInTheDocument();
    expect(within(group).getByLabelText('Website')).toBeInTheDocument();
  });

  it('keeps the 3000-char limit and shows a live counter', async () => {
    await renderPage();
    const info = screen.getByLabelText('Extra shop information');
    expect(info).toHaveAttribute('maxlength', '3000');
    fireEvent.change(info, { target: { value: 'Hello' } });
    expect(screen.getByText('5/3000')).toBeInTheDocument();
  });
});

describe('save flow', () => {
  it('gates save on dirty state and PUTs the 6-key payload without deliveryAreas/paymentMethods', async () => {
    await renderPage();
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Shop Name'), { target: { value: 'Updated Shop' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(apiClient.updateShopBusinessInfo).toHaveBeenCalled());
    const payload = vi.mocked(apiClient.updateShopBusinessInfo).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toHaveProperty('shopName', 'Updated Shop');
    expect(payload).not.toHaveProperty('deliveryAreas');
    expect(payload).not.toHaveProperty('paymentMethods');
  });

  it('renders success as status and the server error message as alert', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Shop Name'), { target: { value: 'Updated Shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Business info saved and ready for future replies.');

    vi.mocked(apiClient.updateShopBusinessInfo).mockRejectedValueOnce({
      type: 'VALIDATION_ERROR', statusCode: 400, message: 'Save failed', timestamp: '2026-08-02T00:00:00.000Z',
    });
    fireEvent.change(screen.getByLabelText('Shop Name'), { target: { value: 'Another Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
  });
});

describe('ADR-0013 §1 boundary', () => {
  it('links to automation defaults and carries no AI control, radiogroup or range', async () => {
    await renderPage();
    const link = screen.getByTestId('business-info-automation-link');
    expect(link).toHaveAttribute('href', '/manage-shop/automation');
    expect(screen.queryByTestId('ai-reply-mode')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.querySelector('input[type="range"]')).toBeNull();
  });
});
