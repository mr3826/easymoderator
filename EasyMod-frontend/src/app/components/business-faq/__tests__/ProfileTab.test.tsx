import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProfileTab from '../ProfileTab';

// Mock the whole api domain surface this tab touches (§ house rule: components
// self-test via vi.mock of the api module). The shell/client wiring is A0's; this
// test pins the tab's own load/persist/exclude/gate behaviour.
const mockGetShopBusinessInfo = vi.fn();
const mockUpdateShopBusinessInfo = vi.fn();
const mockRefreshShops = vi.fn();
const mockGetCurrentShop = vi.fn(() => null);

vi.mock('@/api', () => ({
  apiClient: {
    getShopBusinessInfo: () => mockGetShopBusinessInfo(),
    updateShopBusinessInfo: (data: unknown) => mockUpdateShopBusinessInfo(data),
  },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    refreshShops: () => mockRefreshShops(),
    getCurrentShop: () => mockGetCurrentShop(),
  },
}));

// Keys render literally (t returns the key); language is controllable so the
// bn-numerals counter is testable without a real i18n instance.
let mockLanguage = 'en';
const mockT = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: mockLanguage } }),
}));

const FULL_INFO = {
  shopName: 'Meena Store',
  nameEn: 'Meena Store English',
  tagline: 'Best fabric in town',
  email: 'meena@example.com',
  city: 'Dhaka',
  phone: '01712345678',
  address: 'Mirpur 10, Dhaka',
  openingHours: 'Sat–Thu 9am–9pm',
  additionalInfo: 'Exchange allowed within 3 days.',
  deliveryAreas: ['Dhaka', 'Chattogram'],
  paymentMethods: ['bKash', 'COD'],
  socialLinks: {
    facebook: 'https://facebook.com/meena',
    website: 'https://meena.com',
    instagram: 'https://instagram.com/meena',
    whatsapp: '01712345678',
    tiktok: 'https://tiktok.com/@meena',
    youtube: 'https://youtube.com/@meena',
  },
};

const renderTab = (props: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <ProfileTab {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockLanguage = 'en';
  mockGetShopBusinessInfo.mockResolvedValue({ businessInfo: FULL_INFO });
  mockUpdateShopBusinessInfo.mockResolvedValue({ businessInfo: FULL_INFO });
  mockRefreshShops.mockResolvedValue(undefined);
});

describe('ProfileTab', () => {
  it('loads and renders every preserved + added field', async () => {
    renderTab();

    await waitFor(() =>
      expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toHaveValue('Meena Store'),
    );
    expect(screen.getByLabelText('manageShop.businessInfo.nameEn')).toHaveValue('Meena Store English');
    expect(screen.getByLabelText('manageShop.businessInfo.tagline')).toHaveValue('Best fabric in town');
    expect(screen.getByLabelText('manageShop.businessInfo.email')).toHaveValue('meena@example.com');
    expect(screen.getByLabelText('manageShop.businessInfo.city')).toHaveValue('Dhaka');
    expect(screen.getByLabelText('manageShop.businessInfo.address')).toHaveValue('Mirpur 10, Dhaka');
    expect(screen.getByLabelText('manageShop.businessInfo.openingHours')).toHaveValue('Sat–Thu 9am–9pm');
    // BDPhoneInput hydrates the raw 01712345678 into its grouped display form.
    expect(screen.getByDisplayValue('01712-345-678')).toBeInTheDocument();

    // All six social inputs are enabled (was facebook + website only).
    expect(screen.getByLabelText('manageShop.businessInfo.social.instagramLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('manageShop.businessInfo.social.whatsappLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('manageShop.businessInfo.social.tiktokLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('manageShop.businessInfo.social.youtubeLabel')).toBeInTheDocument();
  });

  it('nameEn never replaces the authoritative identity (shopName)', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toHaveValue('Meena Store'));

    const nameEn = screen.getByLabelText('manageShop.businessInfo.nameEn');
    await userEvent.clear(nameEn);
    await userEvent.type(nameEn, 'Renamed English');

    // Editing the English display name leaves the authoritative identity intact.
    expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toHaveValue('Meena Store');
    expect(nameEn).toHaveValue('Renamed English');
  });

  it('blocks save on an invalid email and keeps the input value', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toBeInTheDocument());

    const email = screen.getByLabelText('manageShop.businessInfo.email');
    await userEvent.clear(email);
    await userEvent.type(email, 'not-an-email');

    const save = screen.getByTestId('profile-save');
    expect(save).toBeDisabled();
    expect(screen.getByText('manageShop.businessInfo.errors.emailInvalid')).toBeInTheDocument();
    expect(email).toHaveValue('not-an-email');
    expect(mockUpdateShopBusinessInfo).not.toHaveBeenCalled();

    // Correcting the address clears the block.
    await userEvent.clear(email);
    await userEvent.type(email, 'real@example.com');
    await waitFor(() => expect(save).not.toBeDisabled());
    expect(screen.queryByText('manageShop.businessInfo.errors.emailInvalid')).not.toBeInTheDocument();
  });

  it('gates save on dirty state and shows server-confirmed success', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toBeInTheDocument());

    const save = screen.getByTestId('profile-save');
    expect(save).toBeDisabled(); // nothing edited yet

    const city = screen.getByLabelText('manageShop.businessInfo.city');
    await userEvent.clear(city);
    await userEvent.type(city, 'Sylhet');
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(mockUpdateShopBusinessInfo).toHaveBeenCalledTimes(1));
    // Success only after the server confirmed; refreshShops follows the PUT.
    await waitFor(() => expect(screen.getByText('manageShop.businessInfo.successMsg')).toBeInTheDocument());
    expect(mockRefreshShops).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(save).toBeDisabled()); // re-baselined → clean
  });

  it('persists all new fields and never sends deliveryAreas / paymentMethods', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toBeInTheDocument());

    const save = screen.getByTestId('profile-save');
    const tagline = screen.getByLabelText('manageShop.businessInfo.tagline');
    await userEvent.clear(tagline);
    await userEvent.type(tagline, 'Fresh tagline');

    fireEvent.click(save);
    await waitFor(() => expect(mockUpdateShopBusinessInfo).toHaveBeenCalledTimes(1));

    const payload = mockUpdateShopBusinessInfo.mock.calls[0][0];
    expect(payload).toMatchObject({
      shopName: 'Meena Store',
      nameEn: 'Meena Store English',
      tagline: 'Fresh tagline',
      email: 'meena@example.com',
      city: 'Dhaka',
      phone: '01712345678',
      socialLinks: expect.objectContaining({
        instagram: 'https://instagram.com/meena',
        whatsapp: '01712345678',
        tiktok: 'https://tiktok.com/@meena',
        youtube: 'https://youtube.com/@meena',
      }),
    });
    expect(payload).not.toHaveProperty('deliveryAreas');
    expect(payload).not.toHaveProperty('paymentMethods');
  });

  it('renders the additional-info counter in Bengali numerals for bn (shell-driven data)', () => {
    mockLanguage = 'bn';
    renderTab({ initialData: { ...FULL_INFO, additionalInfo: 'abc' } });

    // Intl bn-BD: 3 → ৩, 3000 → ৩,০০০. Purely numeric, honestly derived.
    expect(screen.getByText('৩/৩,০০০')).toBeInTheDocument();
  });

  it('preserves inputs and never claims success when the server rejects', async () => {
    // The axios interceptor throws a NormalizedApiError (needs `type` +
    // `statusCode` for getErrorMessage to surface its message).
    mockUpdateShopBusinessInfo.mockRejectedValue({
      type: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'server rejected',
      timestamp: '2026-11-26T00:00:00.000Z',
    });
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toBeInTheDocument());

    const address = screen.getByLabelText('manageShop.businessInfo.address');
    await userEvent.clear(address);
    await userEvent.type(address, 'New Address');

    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(screen.getByText('server rejected')).toBeInTheDocument());
    // §12 — the merchant's edit survives the failed save.
    expect(address).toHaveValue('New Address');
    expect(screen.queryByText('manageShop.businessInfo.successMsg')).not.toBeInTheDocument();
    expect(mockRefreshShops).not.toHaveBeenCalled();
  });

  it('keeps the automation deep-link', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('manageShop.businessInfo.shopName')).toBeInTheDocument());
    expect(screen.getByTestId('business-info-automation-link')).toHaveAttribute('href', '/manage-shop/automation');
  });
});
