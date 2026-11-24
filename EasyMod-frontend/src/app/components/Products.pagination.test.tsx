/**
 * WP-04 regression: pagination must reset when source filters change.
 *
 * Contract under test (Products.tsx): the API returns the full list;
 * search/category/status/price filter server-side via queryParams, while
 * source (ai/manual) and lowStockOnly filter client-side. Pagination is
 * client-side (10/page). Before the fix, applyFilters and the debounced
 * search left `page` untouched: a stale page beyond the filtered window
 * sliced to an empty table, and Pagination unmounted when totalPages <= 1,
 * making matching products unreachable. clearFilters and lowStockOnly
 * already reset to page 1 — the fix extends that contract to every applied
 * filter change.
 *
 * Unlike Products.test.tsx (which returns a static list from useQuery), the
 * useQuery mock here honors queryKey[2] (queryParams) and mirrors the backend
 * list filters (product.service.js: search LIKE name/description/sku,
 * category_id/is_active equality, min_price/max_price bounds), so both the
 * server-side and client-side filter paths are exercised.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import Products from './Products';

// ── Hoisted mock state ────────────────────────────────────────────────────
const { mockState, mockUseQuery, mockNavigate } = vi.hoisted(() => {
  const mockState: { products: any[]; categories: any[] } = { products: [], categories: [] };

  // Mirrors the backend list endpoint's filter semantics.
  const serverFilter = (params: any) => mockState.products.filter((p) => {
    if (params.search) {
      const q = String(params.search).toLowerCase();
      const hit = [p.name, p.description, p.sku].some((v) => String(v ?? '').toLowerCase().includes(q));
      if (!hit) return false;
    }
    if (params.category_id && p.category_id !== params.category_id) return false;
    if (params.is_active !== undefined && p.is_active !== params.is_active) return false;
    if (params.min_price !== undefined && p.price < Number(params.min_price)) return false;
    if (params.max_price !== undefined && p.price > Number(params.max_price)) return false;
    return true;
  });

  const mockUseQuery = vi.fn((options: any) => {
    if (options?.queryKey?.[0] === 'categories') {
      return { data: mockState.categories, isLoading: false, isFetched: true, isError: false, error: null, refetch: vi.fn() };
    }
    return { data: serverFilter(options?.queryKey?.[2] ?? {}), isLoading: false, isFetched: true, isError: false, error: null, refetch: vi.fn() };
  });

  return { mockState, mockUseQuery, mockNavigate: vi.fn() };
});

// 25 products → 3 pages. AI-generated: 01–08 (client source filter).
// cat-a: 01–13 (2 pages), cat-b: 14–25 (2 pages). Low stock: 24–25.
const buildProducts = () => Array.from({ length: 25 }, (_, idx) => {
  const i = idx + 1;
  const ai = i <= 8;
  const lowStock = i >= 24;
  return {
    id: `p${i}`,
    name: `Product ${String(i).padStart(2, '0')}`,
    price: 100 + i,
    sku: `SKU-${i}`,
    description: '',
    category: i <= 13 ? 'Clothing' : 'Women',
    category_id: i <= 13 ? 'cat-a' : 'cat-b',
    status: 'active',
    is_active: true,
    ai_generated: ai,
    confidence: ai ? 0.9 : null,
    track_quantity: lowStock,
    ...(lowStock ? { quantity: 2, low_stock_threshold: 3 } : {}),
  };
});

// ── Mock react-i18next (keys as text; interpolate the page indicator) ─────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'products.pagination.pageOf'
        ? `Page ${opts?.current} of ${opts?.total}`
        : key,
  }),
}));

// ── Mock API client ───────────────────────────────────────────────────────
vi.mock('@/api', () => ({
  apiClient: {
    getProducts: vi.fn(),
    deleteProduct: vi.fn(),
    getCategories: vi.fn(),
    extractProductsFromUpload: vi.fn(),
    createProduct: vi.fn(),
  },
}));

// ── Mock TanStack Query (honors queryParams — see header) ─────────────────
vi.mock('@tanstack/react-query', () => ({
  useQuery: mockUseQuery,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

// ── Mock auth service ─────────────────────────────────────────────────────
vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShopId: vi.fn().mockReturnValue('shop-1'),
    getUser: vi.fn().mockReturnValue({ userId: 'user-1', shopId: 'shop-1' }),
    isAuthenticated: vi.fn().mockReturnValue(true),
  },
}));

// ── Mock react-router-dom ─────────────────────────────────────────────────
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  // Phase-1 D2: Products now reads ?stock= once on mount (fail-closed seed).
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

// ── Mock sonner ───────────────────────────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ── Mock lucide-react ─────────────────────────────────────────────────────
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon, Upload: Icon, Bot: Icon, CheckCircle: Icon,
    Edit2: Icon, Trash2: Icon, AlertCircle: Icon, Search: Icon,
    Filter: Icon, Download: Icon, X: Icon, Loader2: Icon, Package: Icon,
    ChevronRight: Icon, CheckCircle2: Icon, OctagonX: Icon, Clock4: Icon,
    TriangleAlert: Icon, Eye: Icon, BadgeCheck: Icon,
  };
});

// ── Mock Dialog components ────────────────────────────────────────────────
vi.mock('./ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogOverlay: ({ children }: any) => <div>{children}</div>,
}));

// ── Helpers ───────────────────────────────────────────────────────────────
const flushPromises = () => new Promise(r => setTimeout(r, 0));

const renderComponent = async () => {
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(<Products />);
    await flushPromises();
  });
  return utils!;
};

const visibleRows = () => screen.queryAllByText(/^Product \d+$/);

const clickNext = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'products.pagination.next' }));
  });
};

const openFilterPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: 'products.filter' }));
};

// Finds a panel <select> by its "all" option label (category/status/source).
const panelSelect = (allOptionKey: string): HTMLSelectElement => {
  const panel = document.getElementById('products-filter-panel');
  if (!panel) throw new Error('filter panel is not open');
  const select = Array.from(panel.querySelectorAll('select')).find(s =>
    Array.from(s.options).some(o => o.textContent === allOptionKey));
  if (!select) throw new Error(`no panel select with option "${allOptionKey}"`);
  return select;
};

const applyPanel = () => fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));
const clearPanel = () => fireEvent.click(screen.getByRole('button', { name: 'common.clear' }));

const productQueryParams = () => mockUseQuery.mock.calls
  .map(call => call[0])
  .filter(options => options?.queryKey?.[0] === 'products')
  .map(options => options.queryKey[2] ?? {});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Products pagination under filter changes (WP-04)', () => {
  beforeEach(() => {
    mockState.products = buildProducts();
    mockState.categories = [
      { id: 'cat-a', name: 'Clothing' },
      { id: 'cat-b', name: 'Women' },
    ];
    mockUseQuery.mockClear();
    mockNavigate.mockReset();
  });

  it('resets to page 1 when the client-side source filter narrows from a deep page', async () => {
    await renderComponent();

    // Deep page: 25 products → page 3 shows rows 21–25.
    await clickNext();
    await clickNext();
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('Product 21')).toBeInTheDocument();

    // Narrow to AI-generated only (8 matches → a single page). Before the
    // fix, page 3 sliced past the 8-item window: empty table, and the
    // pagination controls unmounted (totalPages <= 1) with no way back.
    openFilterPanel();
    fireEvent.change(panelSelect('products.allSources'), { target: { value: 'ai' } });
    applyPanel();

    await waitFor(() => {
      expect(screen.getByText('Product 01')).toBeInTheDocument();
    });
    expect(visibleRows()).toHaveLength(8);
    expect(screen.getByText('Product 08')).toBeInTheDocument();
    expect(screen.queryByText('Product 21')).not.toBeInTheDocument();
    // Single page of matches → controls hidden, first page rendered.
    expect(screen.queryByRole('button', { name: 'products.pagination.next' })).not.toBeInTheDocument();
  });

  it('resets to page 1 when a server-side category filter narrows from a deep page', async () => {
    await renderComponent();

    await clickNext();
    await clickNext();
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

    // cat-b matches products 14–25 (12 items → 2 pages). Stale page 3 would
    // slice to an empty table and show "Page 3 of 2".
    openFilterPanel();
    fireEvent.change(panelSelect('products.allCategories'), { target: { value: 'cat-b' } });
    applyPanel();

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    });
    // The category filter really went through the server queryParams.
    expect(productQueryParams().some(p => p.category_id === 'cat-b')).toBe(true);
    expect(screen.getByText('Product 14')).toBeInTheDocument();
    expect(screen.queryByText('Product 01')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'products.pagination.previous' })).toBeDisabled();
    expect(visibleRows()).toHaveLength(10);
  });

  it('resets to page 1 when the debounced search narrows from a deep page', async () => {
    await renderComponent();

    await clickNext();
    await clickNext();
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

    // "Product 2" matches names Product 20–25 only (6 items → 1 page).
    fireEvent.change(screen.getByLabelText('products.searchPlaceholder'), { target: { value: 'Product 2' } });

    await waitFor(() => {
      expect(screen.getByText('Product 20')).toBeInTheDocument();
    });
    expect(productQueryParams().some(p => p.search === 'Product 2')).toBe(true);
    expect(visibleRows()).toHaveLength(6);
    expect(screen.getByText('Product 25')).toBeInTheDocument();
    expect(screen.queryByText('Product 01')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'products.pagination.next' })).not.toBeInTheDocument();
  });

  it('resets to page 1 when a filter widens the result set from page > 1', async () => {
    await renderComponent();

    // Narrow to cat-a (13 items → 2 pages) and move to page 2.
    openFilterPanel();
    fireEvent.change(panelSelect('products.allCategories'), { target: { value: 'cat-a' } });
    applyPanel();
    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    await clickNext();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Product 11')).toBeInTheDocument();

    // Widen back to all categories (25 items). The merchant must land on the
    // first page of the widened set, not stay on the stale index.
    openFilterPanel();
    fireEvent.change(panelSelect('products.allCategories'), { target: { value: '' } });
    applyPanel();

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
    expect(screen.getByText('Product 01')).toBeInTheDocument();
    expect(screen.queryByText('Product 11')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'products.pagination.previous' })).toBeDisabled();
  });

  it('clearing filters from a deep page restores the full list at page 1', async () => {
    await renderComponent();

    // Apply a category filter plus a search, then sit on page 2 of the
    // category-filtered set before clearing everything.
    openFilterPanel();
    fireEvent.change(panelSelect('products.allCategories'), { target: { value: 'cat-a' } });
    applyPanel();
    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    await clickNext();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('products.searchPlaceholder'), { target: { value: 'Product 1' } });
    // Debounced search ∩ cat-a → products 10–13 (4 items, single page).
    await waitFor(() => expect(screen.getByText('Product 10')).toBeInTheDocument());
    expect(visibleRows()).toHaveLength(4);

    openFilterPanel();
    clearPanel();

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
    expect(visibleRows()).toHaveLength(10);
    expect(screen.getByText('Product 01')).toBeInTheDocument();
    expect(screen.getByLabelText('products.searchPlaceholder')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'products.pagination.previous' })).toBeDisabled();
  });

  it('resets to page 1 when the low-stock toggle narrows from a deep page', async () => {
    await renderComponent();

    await clickNext();
    await clickNext();
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

    // Only products 24–25 are tracked at/below threshold (D2 low state).
    fireEvent.click(screen.getByTestId('products-stock-low'));

    await waitFor(() => {
      expect(screen.getByText('Product 24')).toBeInTheDocument();
    });
    expect(visibleRows()).toHaveLength(2);
    expect(screen.getByText('Product 25')).toBeInTheDocument();
    expect(screen.queryByText('Product 21')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'products.pagination.next' })).not.toBeInTheDocument();
  });

  it('keeps the current page when Apply re-submits identical filters', async () => {
    await renderComponent();

    await clickNext();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    // No filter value changes → the result set is unchanged → preserve page.
    openFilterPanel();
    applyPanel();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'common.apply' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Product 11')).toBeInTheDocument();
  });
});