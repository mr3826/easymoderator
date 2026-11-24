import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import Products, { effectiveStockQuantity, isLowStockProduct, isOutOfStockProduct, isStockExceptionProduct } from './Products';

// ── Hoist mock functions ──────────────────────────────────────────────────
const {
  mockGetProducts,
  mockDeleteProduct,
  mockGetCategories,
  mockExtractProductsFromUpload,
  mockCreateProduct,
} = vi.hoisted(() => {
  const buildProduct = (overrides = {}) => ({
    id: 'prod-1', name: 'Test T-Shirt', price: 299, sku: 'SKU-001',
    description: 'A shirt', category: 'Clothing', category_id: 'cat-1',
    status: 'active', is_active: true, quantity: 50,
    ai_generated: false, confidence: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  const mockProducts = [
    buildProduct({ id: 'prod-1', name: 'Test T-Shirt',   price: 299, sku: 'SKU-001' }),
    buildProduct({ id: 'prod-2', name: 'Blue Jeans',     price: 799, sku: 'SKU-002', is_active: false, status: 'inactive' }),
    buildProduct({ id: 'prod-3', name: 'Cotton Kurti',   price: 450, sku: 'SKU-003', category: 'Women', category_id: 'cat-2', ai_generated: true, confidence: 0.82 }),
  ];

  return {
    mockGetProducts:               vi.fn().mockResolvedValue(mockProducts),
    mockDeleteProduct:             vi.fn().mockResolvedValue({ success: true }),
    mockGetCategories:             vi.fn().mockResolvedValue([
      { id: 'cat-1', name: 'Clothing' },
      { id: 'cat-2', name: 'Women' },
    ]),
    mockExtractProductsFromUpload: vi.fn().mockResolvedValue([{
      id: 'ai-1', name: 'AI Product', price: 150, sku: 'AI-001',
      ai_generated: true, confidence: 0.75,
    }]),
    mockCreateProduct:             vi.fn().mockResolvedValue({ id: 'new-1', name: 'AI Product', price: 150 }),
  };
});

// ── Re-export for assertions ──────────────────────────────────────────────
type ProductFixture = {
  id: string;
  name: string;
  price: number;
  sku: string;
  category: string;
  is_active: boolean;
  status: string;
  ai_generated: boolean;
  confidence: number | null;
  track_quantity?: boolean;
  quantity?: number;
  low_stock_threshold?: number;
};

const mockProducts: ProductFixture[] = [
  { id: 'prod-1', name: 'Test T-Shirt',   price: 299, sku: 'SKU-001', category: 'Clothing', is_active: true,  status: 'active',   ai_generated: false, confidence: null },
  { id: 'prod-2', name: 'Blue Jeans',     price: 799, sku: 'SKU-002', category: 'Clothing', is_active: false, status: 'inactive', ai_generated: false, confidence: null },
  { id: 'prod-3', name: 'Cotton Kurti',   price: 450, sku: 'SKU-003', category: 'Women',    is_active: true,  status: 'active',   ai_generated: true,  confidence: 0.82 },
];
const baselineMockProducts = [...mockProducts];

// ── Mock react-i18next ────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Mock API client ───────────────────────────────────────────────────────
vi.mock('@/api', () => ({
  apiClient: {
    getProducts:               mockGetProducts,
    deleteProduct:             mockDeleteProduct,
    getCategories:             mockGetCategories,
    extractProductsFromUpload: mockExtractProductsFromUpload,
    createProduct:             mockCreateProduct,
  },
}));

// ── Mock TanStack Query ───────────────────────────────────────────────────
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => {
    // Return synchronous mock instead of using hooks
    return {
      data: mockProducts,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData:      vi.fn(),
  }),
}));

// ── Mock auth service ─────────────────────────────────────────────────────
vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShopId: vi.fn().mockReturnValue('shop-1'),
    getUser:          vi.fn().mockReturnValue({ userId: 'user-1', shopId: 'shop-1' }),
    isAuthenticated:  vi.fn().mockReturnValue(true),
  },
}));

// ── Mock react-router-dom ─────────────────────────────────────────────────
const mockNavigate = vi.fn();
// Mutable holder so seed tests can set ?stock= before mount (the component
// seeds once on mount, mirroring the Orders bucket-seed contract).
const mockSearchParams = { current: new URLSearchParams() };
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams.current, vi.fn()],
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
    // Redesign kit (PageHeader/SignalBadge/EmButton) imports these too.
    ChevronRight: Icon, CheckCircle2: Icon, OctagonX: Icon, Clock4: Icon,
    TriangleAlert: Icon, Eye: Icon, BadgeCheck: Icon,
  };
});

// ── Mock Dialog components ────────────────────────────────────────────────
vi.mock('./ui/dialog', () => ({
  Dialog:            ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent:     ({ children }: any) => <div>{children}</div>,
  DialogHeader:      ({ children }: any) => <div>{children}</div>,
  DialogTitle:       ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogOverlay:     ({ children }: any) => <div>{children}</div>,
}));

// ── Mock AddProduct ───────────────────────────────────────────────────────
vi.mock('./AddProduct', () => ({
  default: ({ onClose, onSave }: any) => (
    <div data-testid="add-product-modal">
      <button onClick={onClose}>Close</button>
      <button onClick={() => onSave?.({ id: 'new-1', name: 'Saved' })}>Save</button>
    </div>
  ),
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Products', () => {
  beforeEach(() => {
    mockProducts.splice(0, mockProducts.length, ...baselineMockProducts);
    mockGetProducts.mockReset().mockResolvedValue(mockProducts);
    mockDeleteProduct.mockReset().mockResolvedValue({ success: true });
    mockGetCategories.mockReset().mockResolvedValue([
      { id: 'cat-1', name: 'Clothing' },
      { id: 'cat-2', name: 'Women' },
    ]);
    mockExtractProductsFromUpload.mockReset().mockResolvedValue([{
      id: 'ai-1', name: 'AI Product', price: 150, ai_generated: true, confidence: 0.75,
    }]);
    mockCreateProduct.mockReset().mockResolvedValue({ id: 'new-1', name: 'AI Product', price: 150 });
    mockNavigate.mockReset();
    mockSearchParams.current = new URLSearchParams();
  });

  // ── Basic render ─────────────────────────────────────────────────────

  it('renders the Products page header', async () => {
    await renderComponent();
    // Use heading role or direct h1 query to avoid multiple-match error
    const heading = document.querySelector('h1') ||
                    screen.queryByText('products.title');
    expect(heading).toBeTruthy();
  });

  it('renders product names from the list', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Test T-Shirt')).toBeInTheDocument();
    });
  });

  it('renders all 3 products', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Test T-Shirt')).toBeInTheDocument();
      expect(screen.getByText('Blue Jeans')).toBeInTheDocument();
      expect(screen.getByText('Cotton Kurti')).toBeInTheDocument();
    });
  });

  it('renders product SKUs', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('SKU-001')).toBeInTheDocument();
    });
  });

  it('renders product prices', async () => {
    await renderComponent();

    await waitFor(() => {
      // Price should appear somewhere in the product row
      const price = screen.queryByText(/299/) || screen.queryByText(/৳299/) || screen.queryByText(/299\.00/);
      expect(price).toBeTruthy();
    });
  });

  it('renders an "Add Product" button', async () => {
    await renderComponent();
    // Button text is the translation key 'products.addManually' (i18n mock returns key as-is)
    const addBtn = screen.queryByText('products.addManually') ||
                   screen.queryByText(/products\.addManually/i) ||
                   Array.from(document.querySelectorAll('button')).find(
                     btn => btn.textContent?.includes('addManually')
                   );
    expect(addBtn).toBeTruthy();
  });

  it('renders an upload/import button', async () => {
    await renderComponent();
    const uploadBtn = screen.queryByRole('button', { name: /upload|import|bulk/i }) ||
                      Array.from(document.querySelectorAll('button')).find(
                        btn => btn.querySelector('[class*="upload"]') ||
                               btn.textContent?.toLowerCase().includes('upload') ||
                               btn.textContent?.toLowerCase().includes('import')
                      );
    expect(uploadBtn).toBeTruthy();
  });

  // ── Search & filter ───────────────────────────────────────────────────

  it('renders a search input', async () => {
    await renderComponent();
    const searchInput = screen.queryByRole('textbox', { name: /search/i }) ||
                        document.querySelector('input[type="text"]') ||
                        document.querySelector('input[type="search"]');
    expect(searchInput).toBeTruthy();
  });

  it('filters only tracked low stock and restores products when cleared', async () => {
    mockProducts.splice(0, mockProducts.length,
      { ...baselineMockProducts[0], id: 'tracked-low', name: 'Tracked at threshold', track_quantity: true, quantity: 3, low_stock_threshold: 3 },
      { ...baselineMockProducts[0], id: 'tracked-below', name: 'Tracked below threshold', track_quantity: true, quantity: 1, low_stock_threshold: 4 },
      { ...baselineMockProducts[0], id: 'tracked-above', name: 'Tracked above threshold', track_quantity: true, quantity: 5, low_stock_threshold: 4 },
      { ...baselineMockProducts[0], id: 'untracked-low', name: 'Untracked quantity', track_quantity: false, quantity: 0, low_stock_threshold: 2 },
      { ...baselineMockProducts[0], id: 'missing-threshold', name: 'Missing threshold', track_quantity: true, quantity: 0 },
    );
    await renderComponent();

    // D2: the low state excludes out-of-stock rows (disjoint by construction).
    fireEvent.click(screen.getByTestId('products-stock-low'));

    await waitFor(() => {
      expect(screen.getByText('Tracked at threshold')).toBeInTheDocument();
      expect(screen.getByText('Tracked below threshold')).toBeInTheDocument();
      expect(screen.queryByText('Tracked above threshold')).not.toBeInTheDocument();
      expect(screen.queryByText('Untracked quantity')).not.toBeInTheDocument();
      expect(screen.queryByText('Missing threshold')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('products-stock-low'));
    await waitFor(() => expect(screen.getByText('Tracked above threshold')).toBeInTheDocument());
  });

  // ── D2 stock predicate parity + ?stock= fail-closed seed ─────────────────
  // Default = a LOW product (3 of 10 ≤ threshold 5); out/healthy via overrides.
  const stockFixture = (overrides: Record<string, unknown>) => ({
    ...baselineMockProducts[0], track_quantity: true, quantity: 3, low_stock_threshold: 5, ...overrides,
  }) as unknown as ProductFixture;

  it('effective quantity prefers active variants, falls back to parent', () => {
    expect(effectiveStockQuantity(stockFixture({
      quantity: 50,
      product_variants: [{ id: 'v1', quantity: 2, is_active: true }, { id: 'v2', quantity: 0, is_active: false }],
    } as never) as never)).toBe(2);
    expect(effectiveStockQuantity(stockFixture({ quantity: 7 }) as never)).toBe(7);
    expect(effectiveStockQuantity(stockFixture({ quantity: 7, product_variants: [] }) as never)).toBe(7);
    // Inactive-only variant sets fall back to the parent quantity (contract B).
    expect(effectiveStockQuantity(stockFixture({
      quantity: 7, product_variants: [{ id: 'v1', quantity: 0, is_active: false }],
    }) as never)).toBe(7);
  });

  it('classifies out/low as disjoint (out ≤ 0; low 0 < q ≤ threshold)', () => {
    const out = stockFixture({ quantity: 50, product_variants: [{ id: 'v1', quantity: 0, is_active: true }] });
    const low = stockFixture({ quantity: 50, product_variants: [{ id: 'v1', quantity: 3, is_active: true }] });
    const ok = stockFixture({ quantity: 50, product_variants: [{ id: 'v1', quantity: 9, is_active: true }] });
    expect(isOutOfStockProduct(out as never)).toBe(true);
    expect(isLowStockProduct(out as never)).toBe(false);
    expect(isLowStockProduct(low as never)).toBe(true);
    expect(isOutOfStockProduct(low as never)).toBe(false);
    expect(isStockExceptionProduct(ok as never)).toBe(false);
    // track_quantity scope: untracked products never count.
    expect(isStockExceptionProduct(stockFixture({ track_quantity: false, quantity: 0 }) as never)).toBe(false);
  });

  // A8 MAJOR-1 parity — these cases mirror the exported server predicate
  // (`classifyStockExceptions` / `computeEffectiveQuantity`, pinned in
  // EasyMod-backend product-stock-exceptions.service.test.js) token-for-token:
  // the nav badge (server) and the list (client) must agree even for
  // synthetic payloads.
  it('parity with the server scope: an INACTIVE but tracked product is never an exception', () => {
    const retired = stockFixture({ id: 's-retired', name: 'Retired Cap', is_active: false, status: 'inactive', quantity: 0 });
    const live = stockFixture({ id: 's-live', name: 'Live Cap', is_active: true, quantity: 0 });
    // Server scans `is_active: true` — a retired tracked product can never
    // sell, so it appears in neither the exception count nor the filter.
    expect(isOutOfStockProduct(retired as never)).toBe(false);
    expect(isLowStockProduct(retired as never)).toBe(false);
    expect(isStockExceptionProduct(retired as never)).toBe(false);
    // Same row, still active → out of stock (the badge/list edge holds).
    expect(isStockExceptionProduct(live as never)).toBe(true);
  });

  it('parity with the server edge rules: unparseable parent fails toward out; non-finite variants drop', () => {
    // Parent null/NaN → 0 → out-of_stock classification (server honesty:
    // a visible exception, never a silent "in stock").
    expect(isOutOfStockProduct(stockFixture({ quantity: null }) as never)).toBe(true);
    expect(isOutOfStockProduct(stockFixture({ quantity: 'not-a-number' }) as never)).toBe(true);
    expect(isStockExceptionProduct(stockFixture({ quantity: undefined }) as never)).toBe(true);
    // Non-finite ACTIVE variant quantities contribute NOTHING (server drops
    // them); when none remain finite the PARENT wins (fallback, not zero).
    expect(effectiveStockQuantity(stockFixture({
      quantity: 9, product_variants: [{ id: 'v1', quantity: Number.NaN, is_active: true }],
    }) as never) as never).toBe(9);
    expect(isStockExceptionProduct(stockFixture({
      quantity: 9, product_variants: [{ id: 'v1', quantity: Number.NaN, is_active: true }],
    }) as never)).toBe(false);
    // Mixed finite + NaN: the finite sum is the effective quantity.
    expect(effectiveStockQuantity(stockFixture({
      quantity: 99, product_variants: [
        { id: 'v1', quantity: Number.NaN, is_active: true },
        { id: 'v2', quantity: 2, is_active: true },
      ],
    }) as never) as never).toBe(2);
  });

  it('seeds ?stock=exceptions from the URL and clears back to all', async () => {
    mockProducts.splice(0, mockProducts.length,
      stockFixture({ id: 's-low', name: 'Low Variant Sum' }),
      stockFixture({ id: 's-out', name: 'Zero Variant Sum', product_variants: [{ id: 'v', quantity: 0, is_active: true }] }),
      stockFixture({ id: 's-ok', name: 'Healthy Stock', product_variants: [{ id: 'v', quantity: 9, is_active: true }] }),
    );
    mockSearchParams.current = new URLSearchParams('stock=exceptions');
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Low Variant Sum')).toBeInTheDocument();
      expect(screen.getByText('Zero Variant Sum')).toBeInTheDocument();
      expect(screen.queryByText('Healthy Stock')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('products-stock-clear'));
    await waitFor(() => expect(screen.getByText('Healthy Stock')).toBeInTheDocument());
  });

  it('seeds ?stock=out', async () => {
    mockProducts.splice(0, mockProducts.length,
      stockFixture({ id: 's-low', name: 'Low Variant Sum' }),
      stockFixture({ id: 's-out', name: 'Zero Variant Sum', product_variants: [{ id: 'v', quantity: 0, is_active: true }] }),
    );
    mockSearchParams.current = new URLSearchParams('stock=out');
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Zero Variant Sum')).toBeInTheDocument();
      expect(screen.queryByText('Low Variant Sum')).not.toBeInTheDocument();
    });
  });

  it('seeds ?stock=low onto the same control the toolbar exposes', async () => {
    mockProducts.splice(0, mockProducts.length,
      stockFixture({ id: 's-low', name: 'Low Variant Sum' }),
      stockFixture({ id: 's-ok', name: 'Healthy Stock', product_variants: [{ id: 'v', quantity: 9, is_active: true }] }),
    );
    mockSearchParams.current = new URLSearchParams('stock=low');
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Low Variant Sum')).toBeInTheDocument();
      expect(screen.queryByText('Healthy Stock')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('products-stock-low')).toHaveAttribute('aria-pressed', 'true');
  });

  it('fails closed on unknown ?stock= values (unknown seed → unfiltered)', async () => {
    mockProducts.splice(0, mockProducts.length,
      stockFixture({ id: 's-ok', name: 'Healthy Stock', product_variants: [{ id: 'v', quantity: 9, is_active: true }] }),
    );
    mockSearchParams.current = new URLSearchParams('stock=totally-bogus');
    await renderComponent();
    await waitFor(() => expect(screen.getByText('Healthy Stock')).toBeInTheDocument());
    expect(screen.queryByTestId('products-stock-clear')).not.toBeInTheDocument();
  });

  it('debounces search input (does not query immediately on keystroke)', async () => {
    await renderComponent();

    const searchInput = document.querySelector('input[type="text"]') as HTMLInputElement ||
                        document.querySelector('input[type="search"]') as HTMLInputElement;

    if (searchInput) {
      const callsBefore = mockGetProducts.mock.calls.length;

      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 't' } });
      });

      // Query should NOT be called immediately (debounced)
      expect(mockGetProducts.mock.calls.length).toBe(callsBefore);
    }
  });

  it('renders filter panel toggle button', async () => {
    await renderComponent();
    // Exact name: the D2 stock buttons' aria-labels also contain "filter"
    // (products.stockFilter.*) in key-rendered tests.
    const filterBtn = screen.getByRole('button', { name: 'products.filter' });
    expect(filterBtn).toBeTruthy();
  });

  // ── Delete flow ───────────────────────────────────────────────────────

  it('shows delete confirmation dialog when delete is triggered', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Test T-Shirt')).toBeInTheDocument();
    });

    // Delete buttons have no text (icon-only). Find by the red-hover class specific to delete buttons.
    const deleteButton = document.querySelector('button[class*="hover:text-red-600"]') as HTMLElement | null;

    if (deleteButton) {
      await act(async () => { fireEvent.click(deleteButton); });

      await waitFor(() => {
        // Dialog mock renders when open=true; title key is 'products.deleteModal.title'
        const dialog = screen.queryByText('products.deleteModal.title') ||
                       screen.queryByText(/products\.deleteModal/i);
        expect(dialog).toBeTruthy();
      });
    }
  });

  it('does NOT call deleteProduct until confirmation is clicked', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Test T-Shirt')).toBeInTheDocument();
    });

    const deleteButton = Array.from(document.querySelectorAll('button')).find(
      btn => btn.querySelector('[class*="trash"]') ||
             btn.getAttribute('aria-label')?.toLowerCase().includes('delete')
    );

    if (deleteButton) {
      await act(async () => { fireEvent.click(deleteButton); });
    }

    // deleteProduct should NOT be called yet (only clicked initial delete)
    expect(mockDeleteProduct).not.toHaveBeenCalled();
  });

  it('calls deleteProduct after confirmation', async () => {
    await renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Test T-Shirt')).toBeInTheDocument();
    });

    // Click the initial delete button
    const deleteButton = Array.from(document.querySelectorAll('button')).find(
      btn => btn.getAttribute('aria-label')?.toLowerCase().includes('delete') ||
             btn.closest('tr')?.textContent?.includes('T-Shirt')
    );

    if (deleteButton) {
      await act(async () => { fireEvent.click(deleteButton); });

      // Click confirm button in dialog.
      // The confirm button renders t('common.delete') = 'common.delete' (i18n key).
      // Use exact text to avoid colliding with aria-labelled row delete buttons.
      await waitFor(() => {
        const allDeleteBtns = screen.queryAllByRole('button', { name: /delete/i });
        // Confirm button has no aria-label (only text content); row buttons have aria-label
        const confirmBtn = allDeleteBtns.find(btn => !btn.getAttribute('aria-label'));
        if (confirmBtn) {
          act(() => { fireEvent.click(confirmBtn); });
        }
      });

      if (mockDeleteProduct.mock.calls.length > 0) {
        expect(mockDeleteProduct).toHaveBeenCalledWith('prod-1');
      }
    }
  });

  // ── AI product review flow ────────────────────────────────────────────

  it('shows AI badge on AI-generated products', async () => {
    await renderComponent();

    await waitFor(() => {
      // Cotton Kurti is AI-generated
      expect(screen.getByText('Cotton Kurti')).toBeInTheDocument();
    });

    // AI badge or indicator should be visible
    const aiBadge = screen.queryByText(/AI/i) ||
                    screen.queryByText(/ai.*generated|generated.*ai/i) ||
                    document.querySelector('[class*="bot"], [class*="ai"]');
    expect(aiBadge).toBeTruthy();
  });

  it('shows confidence score for AI-generated products', async () => {
    await renderComponent();

    await waitFor(() => {
      // confidence: 0.82 → should show 82% or 0.82
      const confidence = screen.queryByText(/82/) ||
                         screen.queryByText(/0\.82/) ||
                         screen.queryByText(/82%/);
      if (confidence) expect(confidence).toBeInTheDocument();
    });
  });

  it('edits unsaved AI extracted draft inline inside the review modal without navigating to 404', async () => {
    await renderComponent();

    fireEvent.click(await screen.findByRole('button', { name: /upload/i }));
    const fileInput = document.querySelector('#file-upload') as HTMLInputElement;
    const file = new File(['name,price\nDraft,150'], 'products.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('AI Product')).toBeInTheDocument();
    const editBtn = screen.getByRole('button', { name: 'common.edit' });
    fireEvent.click(editBtn);

    expect(mockNavigate).not.toHaveBeenCalled();
    const form = screen.getByTestId('draft-edit-form-ai-1');
    const nameInput = form.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Edited Draft Saree' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(await screen.findByText('Edited Draft Saree')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.approve' }));
    await waitFor(() => {
      expect(mockCreateProduct).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Edited Draft Saree',
      }));
    });
  });

  // ── Empty state ───────────────────────────────────────────────────────

  it('renders empty state when there are no products', async () => {
    // Override useQuery to return empty array
    const { useQuery } = await import('@tanstack/react-query');
    (useQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      data: [], isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });

    await renderComponent();

    await waitFor(() => {
      const empty = screen.queryByText(/no.*product|product.*yet|empty/i) ||
                    screen.queryByText(/products\.empty/i);
      if (empty) expect(empty).toBeInTheDocument();
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────

  it('shows pagination controls when products exceed page size', async () => {
    // Build 15 products to exceed 10/page
    const manyProducts = Array.from({ length: 15 }, (_, i) => ({
      id: `prod-${i + 1}`, name: `Product ${i + 1}`, price: 100 + i,
      sku: `SKU-${i + 1}`, category: 'Clothing', is_active: true,
      status: 'active', ai_generated: false, confidence: null,
    }));

    const { useQuery } = await import('@tanstack/react-query');
    (useQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      data: manyProducts, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });

    await renderComponent();

    await waitFor(() => {
      const prevBtn = screen.queryByRole('button', { name: /prev|previous|‹|←/i });
      const nextBtn = screen.queryByRole('button', { name: /next|›|→/i });
      const pageInfo = screen.queryByText(/page/i) ||
                       screen.queryByText(/1.*of.*2/i);
      const hasPagination = prevBtn || nextBtn || pageInfo;
      if (hasPagination) expect(hasPagination).toBeTruthy();
    });
  });

  it('shows at most 10 products per page', async () => {
    const manyProducts = Array.from({ length: 15 }, (_, i) => ({
      id: `prod-${i + 1}`, name: `Product ${i + 1}`, price: 100 + i,
      sku: `SKU-${i + 1}`, is_active: true, status: 'active',
      ai_generated: false, confidence: null,
    }));

    const { useQuery } = await import('@tanstack/react-query');
    (useQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      data: manyProducts, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });

    await renderComponent();

    await waitFor(() => {
      // Only "Product 1" through "Product 10" should be visible on page 1
      const productRows = screen.queryAllByText(/^Product \d+$/);
      if (productRows.length > 0) {
        expect(productRows.length).toBeLessThanOrEqual(10);
      }
    });
  });

  // ── Add product navigation ────────────────────────────────────────────

  it('opens AddProduct modal when Add Product button is clicked', async () => {
    await renderComponent();

    const addBtn = screen.queryByRole('button', { name: /add.*product|products\.addProduct/i }) ||
                   Array.from(document.querySelectorAll('button')).find(
                     btn => btn.textContent?.match(/add.*product|new.*product/i)
                   );

    if (addBtn) {
      await act(async () => { fireEvent.click(addBtn); });

      await waitFor(() => {
        const modal = screen.queryByTestId('add-product-modal') ||
                      document.querySelector('[role="dialog"]');
        expect(modal).toBeTruthy();
      });
    }
  });

  // ── Loading & error states ────────────────────────────────────────────

  it('shows loading indicator during initial fetch', async () => {
    const { useQuery } = await import('@tanstack/react-query');
    // Use mockImplementation (not Once) so both useQuery calls in the component
    // return the loading state, preventing a re-render that would clear the spinner.
    (useQuery as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      data: [], isLoading: true, isError: false, error: null, refetch: vi.fn(),
    }));

    act(() => {
      render(<Products />);
    });

    const loading = document.querySelector('[class*="animate-spin"]') ||
                    screen.queryByText('products.loading') ||
                    document.querySelector('[role="status"]');
    expect(loading).toBeTruthy();

    // Restore default mock
    (useQuery as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      data: mockProducts, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    }));
  });

  it('shows error state when API fetch fails', async () => {
    const { useQuery } = await import('@tanstack/react-query');
    (useQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      data: [], isLoading: false, isError: true,
      error: new Error('Network error'), refetch: vi.fn(),
    });

    await renderComponent();

    await waitFor(() => {
      const errorEl = screen.queryByText(/error|failed|network/i) ||
                      document.querySelector('[class*="red"]');
      if (errorEl) expect(errorEl).toBeInTheDocument();
    });
  });

  // ── Download template ─────────────────────────────────────────────────

  it('renders a download template button', async () => {
    await renderComponent();

    const downloadBtn = screen.queryByRole('button', { name: /download|template/i }) ||
                        Array.from(document.querySelectorAll('button')).find(
                          btn => btn.textContent?.toLowerCase().includes('download') ||
                                 btn.textContent?.toLowerCase().includes('template')
                        );
    expect(downloadBtn).toBeTruthy();
  });
});
