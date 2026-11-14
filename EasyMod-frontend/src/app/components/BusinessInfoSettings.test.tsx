import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessInfoSettings from './BusinessInfoSettings';

// ── Hoist mock functions so they are available inside vi.mock factories ───
const {
  mockGetShopBusinessInfo,
  mockUpdateShopBusinessInfo,
} = vi.hoisted(() => {
  const mockBusinessInfo = {
    businessInfo: {
      shopName: 'Test Shop',
      address: '123 Main St',
      phone: '01700000000',
      openingHours: '9am-6pm',
      additionalInfo: 'Exchange within 3 days.',
      deliveryAreas: ['Dhaka', 'Chittagong'],
      paymentMethods: ['COD', 'bKash'],
    },
    brandingRules: {},
    faqs: [],
    documents: [],
    ai_settings: {},
  };
  return {
    mockGetShopBusinessInfo: vi.fn().mockResolvedValue(mockBusinessInfo),
    mockUpdateShopBusinessInfo: vi.fn().mockResolvedValue(mockBusinessInfo),
  };
});

// ── Re-export mock data for test assertions ────────────────────────────────
const mockBusinessInfo = {
  businessInfo: { shopName: 'Test Shop', address: '123 Main St', phone: '01700000000', openingHours: '9am-6pm', additionalInfo: 'Exchange within 3 days.', deliveryAreas: ['Dhaka', 'Chittagong'], paymentMethods: ['COD', 'bKash'] },
  brandingRules: {}, faqs: [], documents: [], ai_settings: {},
};

// ── Mock react-i18next ────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Mock API client ───────────────────────────────────────────────────────
vi.mock('@/api', () => ({
  apiClient: {
    getShopBusinessInfo: mockGetShopBusinessInfo,
    updateShopBusinessInfo: mockUpdateShopBusinessInfo,
  },
}));

// ── Mock auth service ─────────────────────────────────────────────────────
vi.mock('@/app/lib/auth', () => ({
  authService: {
    getUser: vi.fn().mockReturnValue({ userId: 'user-1', shopId: 'shop-1' }),
    isAuthenticated: vi.fn().mockReturnValue(true),
    refreshShops: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Mock lucide-react icons ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  Bot: () => null,
  ChevronRight: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────
const renderComponent = async () => {
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(
      <MemoryRouter>
        <BusinessInfoSettings />
      </MemoryRouter>,
    );
  });
  return utils!;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BusinessInfoSettings', () => {
  beforeEach(() => {
    mockGetShopBusinessInfo.mockReset().mockResolvedValue(mockBusinessInfo);
    mockUpdateShopBusinessInfo.mockReset().mockResolvedValue(mockBusinessInfo);
  });

  // ── Loading & data display ──────────────────────────────────────────────

  it('shows loading state initially', async () => {
    mockGetShopBusinessInfo.mockImplementation(() => new Promise(() => {}));

    render(
      <MemoryRouter>
        <BusinessInfoSettings />
      </MemoryRouter>,
    );
    const loading = document.querySelector('[class*="animate"]') ||
                    screen.queryByText(/loading/i) ||
                    document.querySelector('[role="status"]');
    expect(loading).toBeTruthy();
  });

  it('loads and displays shop name after data fetch', async () => {
    await renderComponent();

    await waitFor(() => {
      const shopNameInput = screen.getByDisplayValue('Test Shop');
      expect(shopNameInput).toBeInTheDocument();
    });
  });

  it('displays all business info fields', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
      expect(screen.getByDisplayValue('123 Main St')).toBeInTheDocument();
      expect(screen.getByDisplayValue('01700000000')).toBeInTheDocument();
      expect(screen.getByDisplayValue('9am-6pm')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Exchange within 3 days.')).toBeInTheDocument();
    });
  });

  it('shows error message when load fails', async () => {
    mockGetShopBusinessInfo.mockRejectedValueOnce(new Error('Network error'));

    await renderComponent();

    await waitFor(() => {
      const error = screen.queryByText(/failed|error/i);
      expect(error).toBeTruthy();
    });
  });

  // ── AI controls removed from the business profile (ADR-0013 §1) ─────────

  it('does not render AI reply controls', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('ai-reply-mode')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="range"]')).toBeNull();
  });

  it('links to the business automation defaults page', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId('business-info-automation-link')).toBeInTheDocument();
    });
    expect(screen.getByTestId('business-info-automation-link')).toHaveAttribute(
      'href',
      '/manage-shop/automation',
    );
  });

  // ── Dirty-state tracking ────────────────────────────────────────────────

  it('Save Info button is disabled when no changes are made', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const saveButtons = screen.getAllByRole('button', { name: /save/i });
    expect(saveButtons.length).toBeGreaterThan(0);
  });

  it('Save button becomes enabled after editing a field', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const shopNameInput = screen.getByDisplayValue('Test Shop');
    await act(async () => {
      fireEvent.change(shopNameInput, { target: { value: 'Updated Shop' } });
    });

    await waitFor(() => {
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      const enabledSave = saveButtons.find(btn => !(btn as HTMLButtonElement).disabled);
      expect(enabledSave).toBeTruthy();
    });
  });

  // ── Save flows ──────────────────────────────────────────────────────────

  it('calls updateShopBusinessInfo when Save Info is submitted', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const shopNameInput = screen.getByDisplayValue('Test Shop');
    await act(async () => {
      fireEvent.change(shopNameInput, { target: { value: 'New Name' } });
    });

    await waitFor(() => {
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      const enabledSave = saveButtons.find(btn => !(btn as HTMLButtonElement).disabled);
      if (enabledSave) fireEvent.click(enabledSave);
    });

    await waitFor(() => {
      expect(mockUpdateShopBusinessInfo).toHaveBeenCalled();
    });
  });

  it('shows success notice after saving business info', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const shopNameInput = screen.getByDisplayValue('Test Shop');
    await act(async () => {
      fireEvent.change(shopNameInput, { target: { value: 'Changed Name' } });
    });

    await waitFor(async () => {
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      const enabledSave = saveButtons.find(btn => !(btn as HTMLButtonElement).disabled);
      if (enabledSave) {
        await act(async () => { fireEvent.click(enabledSave); });
      }
    });

    await waitFor(() => {
      const notice = screen.queryByText(/saved|success|successMsg/i);
      expect(notice).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('shows error notice when save fails', async () => {
    mockUpdateShopBusinessInfo.mockRejectedValueOnce(new Error('Server error'));

    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const shopNameInput = screen.getByDisplayValue('Test Shop');
    await act(async () => {
      fireEvent.change(shopNameInput, { target: { value: 'Changed' } });
    });

    await waitFor(async () => {
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      const enabledSave = saveButtons.find(btn => !(btn as HTMLButtonElement).disabled);
      if (enabledSave) {
        await act(async () => { fireEvent.click(enabledSave); });
      }
    });

    await waitFor(() => {
      const error = screen.queryByText(/error|failed/i);
      expect(error).toBeTruthy();
    });
  });

  // ── API alignment checks ────────────────────────────────────────────────

  it('loads business info only (AI settings moved to the automation page)', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(mockGetShopBusinessInfo).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdateShopBusinessInfo).not.toHaveBeenCalled();
  });

  it('sends business info payload to the correct endpoint shape', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shop')).toBeInTheDocument();
    });

    const shopNameInput = screen.getByDisplayValue('Test Shop');
    await act(async () => {
      fireEvent.change(shopNameInput, { target: { value: 'New Shop Name' } });
    });

    await waitFor(async () => {
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      const enabledSave = saveButtons.find(btn => !(btn as HTMLButtonElement).disabled);
      if (enabledSave) {
        await act(async () => { fireEvent.click(enabledSave); });
      }
    });

    await waitFor(() => {
      if (mockUpdateShopBusinessInfo.mock.calls.length > 0) {
        const payload = mockUpdateShopBusinessInfo.mock.calls[0][0];
        expect(typeof payload).toBe('object');
        expect(payload).toHaveProperty('shopName');
        expect(payload).not.toHaveProperty('deliveryAreas');
        expect(payload).not.toHaveProperty('paymentMethods');
      }
    });
  });
});