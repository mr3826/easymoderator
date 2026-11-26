/**
 * Products-catalog guardrails contracts (§8/§17/§18 + header-removal C1/C6):
 * compact page title with NO signal band or header CTA, low-stock client
 * semantics, and the upload dialog focus trap + Escape + label. Additive suite
 * (real i18n en); the legacy Products/AddProduct suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import Products from '../../Products';
import { useQuery } from '@tanstack/react-query';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  // Phase-1 D2: Products now reads ?stock= once on mount (fail-closed seed).
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock('@/api', () => ({
  apiClient: {
    getProducts: vi.fn(),
    deleteProduct: vi.fn(),
    getCategories: vi.fn(),
    extractProductsFromUpload: vi.fn(),
    createProduct: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: { getCurrentShopId: () => 'shop-1', getUser: () => ({ userId: 'u1', shopId: 'shop-1' }), isAuthenticated: () => true },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon, Upload: Icon, Bot: Icon, CheckCircle: Icon, Edit2: Icon, Trash2: Icon,
    AlertCircle: Icon, Search: Icon, Filter: Icon, Download: Icon, X: Icon, Loader2: Icon, Package: Icon,
    ChevronRight: Icon, CheckCircle2: Icon, OctagonX: Icon, Clock4: Icon, TriangleAlert: Icon, Eye: Icon, BadgeCheck: Icon,
  };
});

vi.mock('../../ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogOverlay: ({ children }: any) => <div>{children}</div>,
}));

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Test Product', price: 299, sku: 'SKU-001', status: 'active', is_active: true,
  quantity: 50, track_quantity: true, low_stock_threshold: 5, ...overrides,
});

function mockQuery(rows: unknown[]) {
  vi.mocked(useQuery).mockReturnValue({
    data: rows, isLoading: false, isError: false, error: null, isFetched: true, refetch: vi.fn(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery([product()]);
});

describe('page chrome (header removal C1/C6)', () => {
  it('renders a compact title, no signal band, no header CTA, and keeps the count in the toolbar', async () => {
    await act(async () => { render(<Products />); });
    expect(screen.getByRole('heading', { level: 1, name: 'Products & Inventory' })).toBeInTheDocument();
    // The removal itself is pinned: the signal badge must not exist at all.
    expect(screen.queryByTestId('products-signal')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
    // The low-stock pill was header-only; the D2 stock filter owns that truth now.
    expect(screen.queryByText(/Low stock:/)).toBeNull();
  });

  it('keeps low stock observable from the client-side threshold semantics via the stock filter', async () => {
    mockQuery([product({ quantity: 3, low_stock_threshold: 3 })]);
    await act(async () => { render(<Products />); });
    expect(await screen.findByTestId('products-stock-low')).toBeInTheDocument();
    expect(screen.queryByTestId('products-signal')).toBeNull();
  });
});

describe('upload dialog', () => {
  it('is labelled, traps focus, and closes on Escape', async () => {
    await act(async () => { render(<Products />); });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload Product File' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'products-upload-title');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
