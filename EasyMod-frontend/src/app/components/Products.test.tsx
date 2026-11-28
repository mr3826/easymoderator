import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Products, { effectiveStockQuantity, isLowStockProduct, isOutOfStockProduct, isStockExceptionProduct } from './Products';

const { mockState, mockUseQuery, mockNavigate, mockCreateProduct, mockDeleteProduct, mockGetProductOverview, mockExtractProductsFromUpload } = vi.hoisted(() => {
  const mockState: { products: any[]; categories: any[]; overview: any; extracted: any[]; searchParams: URLSearchParams } = {
    products: [],
    categories: [],
    overview: {},
    extracted: [],
    searchParams: new URLSearchParams(),
  };
  const matchesProducts = (params: Record<string, unknown>) => mockState.products.filter((product) => {
    if (params.search) {
      const query = String(params.search).toLowerCase();
      if (![product.name, product.sku, product.description].some((field) => String(field ?? '').toLowerCase().includes(query))) return false;
    }
    if (params.category_id && product.category_id !== params.category_id) return false;
    if (typeof params.is_active === 'boolean' && product.is_active !== params.is_active) return false;
    if (params.min_price !== undefined && product.price < Number(params.min_price)) return false;
    if (params.max_price !== undefined && product.price > Number(params.max_price)) return false;
    return true;
  });
  const mockUseQuery = vi.fn((options: any) => {
    const key = options?.queryKey?.[0];
    if (key === 'categories') return { data: mockState.categories, isLoading: false, isFetched: true, isError: false, error: null, refetch: vi.fn() };
    if (key === 'product-overview') return { data: mockState.overview, isLoading: false, isFetched: true, isError: false, error: null, refetch: vi.fn() };
    return { data: matchesProducts(options?.queryKey?.[2] ?? {}), isLoading: false, isFetched: true, isError: false, error: null, refetch: vi.fn() };
  });
  const mockCreateProduct = vi.fn().mockResolvedValue({ id: 'created-1' });
  const mockDeleteProduct = vi.fn().mockResolvedValue(undefined);
  const mockGetProductOverview = vi.fn().mockResolvedValue(mockState.overview);
  const mockExtractProductsFromUpload = vi.fn().mockImplementation(async () => ({ products: mockState.extracted }));
  return { mockState, mockUseQuery, mockNavigate: vi.fn(), mockCreateProduct, mockDeleteProduct, mockGetProductOverview, mockExtractProductsFromUpload };
});

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Cotton Shirt', price: 299, sku: 'SKU-001', description: 'Soft cotton',
  category: 'Clothing', category_id: 'cat-1', status: 'active', is_active: true,
  track_quantity: true, quantity: 12, low_stock_threshold: 3, variants: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const overview = (overrides: Record<string, unknown> = {}) => ({
  total: 81,
  active: 68,
  inactive: 13,
  low_stock: 5,
  out_of_stock: 2,
  scanned: 12,
  cap: 1000,
  coverage_complete: false,
  ...overrides,
});

const categoryData = [
  { id: 'cat-1', name: 'Clothing', is_active: true, subcategories: [{ id: 'child-1', name: 'Shirts', is_active: false }] },
  { id: 'cat-2', name: 'Clothing', subcategories: [] },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'products.resultsCount') return `${options?.count} products`;
      if (key === 'products.overview.incompleteCoverage') return `Only ${options?.scanned} of ${options?.cap} products were checked`;
      if (key === 'products.reviewModal.parseCompleteness') return `Parse completeness: ${options?.percent}%`;
      if (key === 'products.reviewModal.aiExtracted') return 'AI-extracted';
      if (key === 'products.reviewModal.unmappedCategory') return `Unmatched imported category: ${options?.category}`;
      if (key === 'products.reviewModal.sellingPriceBdt') return 'Selling price (BDT)';
      if (key === 'products.form.noCategory') return 'No category';
      if (key === 'products.form.inactiveCategory' || key === 'categories.status.inactive') return 'Inactive';
      if (key === 'products.openAria') return `Open ${options?.name}`;
      if (key === 'products.deleteAria') return `Delete ${options?.name}`;
      if (key === 'products.editAria') return `Edit ${options?.name}`;
      if (key === 'products.errors.bulkPartialFailure') return `${options?.failed} of ${options?.total} imports failed or need correction`;
      return key;
    },
  }),
}));

vi.mock('@/api', () => ({
  apiClient: {
    getProducts: vi.fn(),
    getProductOverview: mockGetProductOverview,
    deleteProduct: mockDeleteProduct,
    getCategories: vi.fn(),
    extractProductsFromUpload: mockExtractProductsFromUpload,
    createProduct: mockCreateProduct,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mockUseQuery,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: { getCurrentShopId: vi.fn().mockReturnValue('shop-1') },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockState.searchParams, vi.fn()],
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon, Upload: Icon, Bot: Icon, CheckCircle: Icon, Edit2: Icon, Trash2: Icon,
    AlertCircle: Icon, Search: Icon, Filter: Icon, X: Icon, Loader2: Icon, Package: Icon,
    LayoutGrid: Icon, List: Icon, ChevronRight: Icon,
  };
});

vi.mock('./ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogOverlay: () => null,
}));

const renderProducts = () => render(<Products />);

const uploadCsv = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'products.import' }));
  const file = new File(['name,price'], 'products.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('name,price') });
  fireEvent.change(document.getElementById('file-upload') as HTMLInputElement, { target: { files: [file] } });
  await screen.findByRole('dialog');
  await screen.findAllByText('AI-extracted');
};

beforeEach(() => {
  mockState.products = [
    product(),
    product({ id: 'p2', name: 'Linen Trousers', price: 690, sku: 'SKU-002', category: 'Bottoms', category_id: 'cat-2', is_active: false, status: 'inactive', quantity: 0 }),
    product({ id: 'p3', name: 'Denim Jacket', price: 990, sku: 'SKU-003', category: 'Clothing', category_id: 'child-1', quantity: 2, low_stock_threshold: 3 }),
    product({ id: 'p4', name: 'Empty Shelf', price: 450, sku: 'SKU-004', category: 'Clothing', category_id: 'cat-1', quantity: 0 }),
  ];
  mockState.categories = categoryData;
  mockState.overview = overview();
  mockState.extracted = [{
    id: 'import-1', name: '', price: 0, sku: 'IM-1', category: 'Clothing',
    quantity: 3, track_quantity: true, confidence: 0.75, ai_generated: true,
    variants: [{ name: 'Color', options: ['Red', 'Blue'] }],
  }];
  mockState.searchParams = new URLSearchParams();
  mockUseQuery.mockClear();
  mockCreateProduct.mockReset().mockResolvedValue({ id: 'created-1' });
  mockDeleteProduct.mockReset().mockResolvedValue(undefined);
  mockGetProductOverview.mockReset().mockResolvedValue(mockState.overview);
  mockExtractProductsFromUpload.mockReset().mockImplementation(async () => ({ products: mockState.extracted }));
  mockNavigate.mockReset();
});

describe('Products workspace', () => {
  it('renders API-owned overview counts, incomplete coverage markers, and filtered result count', async () => {
    renderProducts();

    expect(await screen.findByTestId('products-overview-total')).toHaveTextContent('81');
    expect(screen.getByTestId('products-overview-active')).toHaveTextContent('68');
    expect(screen.getByTestId('products-overview-low')).toHaveTextContent('5+');
    expect(screen.getByTestId('products-overview-out')).toHaveTextContent('2+');
    // Interpolated coverage numbers go through the locale-aware formatter
    // (en-US grouping here; Bangla digits under bn) — screenshot packet P2.
    expect(screen.getByTestId('products-overview-coverage-note')).toHaveTextContent('12 of 1,000');
    expect(screen.getByTestId('products-filtered-count')).toHaveTextContent('4 products');
    expect(screen.getByText('81')).not.toBe(screen.getByTestId('products-filtered-count'));

    const overviewQuery = mockUseQuery.mock.calls.map(([options]) => options).find((options) => options.queryKey?.[0] === 'product-overview');
    expect(overviewQuery?.queryKey).toEqual(['product-overview', 'shop-1']);
    const controller = new AbortController();
    await overviewQuery?.queryFn({ signal: controller.signal });
    expect(mockGetProductOverview).toHaveBeenCalledWith(controller.signal);
  });

  it('clicking overview metrics applies the matching filter without using visible-page counts', async () => {
    renderProducts();
    fireEvent.click(await screen.findByTestId('products-overview-active'));

    await waitFor(() => {
      const productQueries = mockUseQuery.mock.calls.map(([options]) => options).filter((options) => options.queryKey?.[0] === 'products');
      expect(productQueries.some((options) => options.queryKey[2]?.is_active === true)).toBe(true);
    });
    expect(screen.getByText('Cotton Shirt')).toBeInTheDocument();
    expect(screen.queryByText('Linen Trousers')).not.toBeInTheDocument();
    expect(screen.getByTestId('products-filtered-count')).toHaveTextContent('3 products');
  });

  it('clicking an out-of-stock overview metric opens the matching stock exception filter', async () => {
    renderProducts();
    fireEvent.click(await screen.findByTestId('products-overview-out'));

    expect(screen.getByTestId('products-stock-out')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Empty Shelf')).toBeInTheDocument();
    expect(screen.queryByText('Cotton Shirt')).not.toBeInTheDocument();
    expect(screen.queryByText('Linen Trousers')).not.toBeInTheDocument();
    expect(screen.queryByText('Denim Jacket')).not.toBeInTheDocument();
  });

  it('uses canonical category IDs and sends status/search filters to the products query', async () => {
    renderProducts();
    fireEvent.click(await screen.findByRole('button', { name: 'products.filter' }));
    const panel = document.getElementById('products-filter-panel') as HTMLElement;
    const selects = panel.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'cat-2' } });
    fireEvent.change(selects[1], { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));

    await waitFor(() => {
      const productQueries = mockUseQuery.mock.calls.map(([options]) => options).filter((options) => options.queryKey?.[0] === 'products');
      expect(productQueries.some((options) => options.queryKey[2]?.category_id === 'cat-2' && options.queryKey[2]?.is_active === false)).toBe(true);
    });
    expect(screen.getByText('Linen Trousers')).toBeInTheDocument();
    expect(screen.queryByText('Cotton Shirt')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('products.searchPlaceholder'), { target: { value: 'Linen' } });
    await waitFor(() => {
      const productQueries = mockUseQuery.mock.calls.map(([options]) => options).filter((options) => options.queryKey?.[0] === 'products');
      expect(productQueries.some((options) => options.queryKey[2]?.search === 'Linen')).toBe(true);
    }, { timeout: 1000 });
  });

  it('keeps stock filters URL-seeded and uses active-variant effective quantities', async () => {
    mockState.searchParams = new URLSearchParams('stock=low');
    renderProducts();
    expect(await screen.findByText('Denim Jacket')).toBeInTheDocument();
    expect(screen.queryByText('Cotton Shirt')).not.toBeInTheDocument();
    expect(screen.getByTestId('products-stock-low')).toHaveAttribute('aria-pressed', 'true');

    const tracked = product({ quantity: 90, product_variants: [
      { id: 'v1', quantity: 1, is_active: true },
      { id: 'v2', quantity: 80, is_active: false },
    ] });
    expect(effectiveStockQuantity(tracked as never)).toBe(1);
    expect(isLowStockProduct(tracked as never)).toBe(true);
    expect(isOutOfStockProduct(product({ quantity: 5, product_variants: [{ id: 'v', quantity: 0, is_active: true }] }) as never)).toBe(true);
    expect(isStockExceptionProduct(product({ track_quantity: false, quantity: 0 }) as never)).toBe(false);
  });

  it('sorts results, switches to mobile-safe cards, and opens details by mouse and keyboard', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderProducts();
    const sort = screen.getByLabelText('products.sort.label');
    fireEvent.change(sort, { target: { value: 'price-desc' } });
    expect(screen.getByRole('row', { name: 'Open Denim Jacket' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'products.view.cards' }));
    const grid = screen.getByTestId('products-card-grid');
    expect(grid).toHaveClass('grid-cols-1');
    const productCard = screen.getByRole('article', { name: 'Open Cotton Shirt' });
    expect(productCard).toHaveClass('min-w-0');
    fireEvent.keyDown(productCard, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/products/p1');
    fireEvent.click(screen.getByRole('button', { name: 'products.view.table' }));
    fireEvent.click(screen.getByRole('row', { name: 'Open Linen Trousers' }));
    expect(mockNavigate).toHaveBeenCalledWith('/products/p2');
  });

  it('navigates Add product to the editor route and retains a shared delete confirm dialog', async () => {
    renderProducts();
    fireEvent.click(await screen.findByRole('button', { name: 'products.addProduct' }));
    expect(mockNavigate).toHaveBeenCalledWith('/products/add');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Cotton Shirt' }));
    expect(screen.getByText('products.deleteModal.title')).toBeInTheDocument();
    expect(mockDeleteProduct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(mockDeleteProduct).toHaveBeenCalledWith('p1'));
  });

  it('restricts uploads to CSV, TSV, and TXT and highlights shared validator errors with parsed variants', async () => {
    renderProducts();
    fireEvent.click(await screen.findByRole('button', { name: 'products.import' }));
    const rejected = new File(['x'], 'products.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.change(document.getElementById('file-upload') as HTMLInputElement, { target: { files: [rejected] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('products.errors.unsupportedFileType');
    expect(mockExtractProductsFromUpload).not.toHaveBeenCalled();

    await uploadCsv();
    expect(screen.getByLabelText(/products.form.productName/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Selling price \(BDT\)/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('products.form.errors.nameRequired')).toBeInTheDocument();
    expect(screen.getByText('products.form.errors.priceInvalid')).toBeInTheDocument();
    expect(screen.getByText('Parse completeness: 75%')).toBeInTheDocument();
    expect(screen.getByText('Color: Red, Blue')).toBeInTheDocument();
    expect(screen.getByText('Unmatched imported category: Clothing')).toBeInTheDocument();
    const categorySelect = screen.getByLabelText('products.columns.category');
    expect(within(categorySelect).getByRole('option', { name: 'No category' })).toBeInTheDocument();
    expect(within(categorySelect).getByRole('option', { name: /Clothing \/ Shirts \(Inactive\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.approve' })).toBeDisabled();
  });

  it('aborts extraction on cancel and does not reopen review after the request settles', async () => {
    let resolveExtraction!: (value: { products: typeof mockState.extracted }) => void;
    mockExtractProductsFromUpload.mockImplementation(() => new Promise((resolve) => { resolveExtraction = resolve; }));
    renderProducts();
    fireEvent.click(await screen.findByRole('button', { name: 'products.import' }));
    const file = new File(['name,price'], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('name,price') });
    fireEvent.change(document.getElementById('file-upload') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(mockExtractProductsFromUpload).toHaveBeenCalled());

    const signal = mockExtractProductsFromUpload.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'common.cancel' }));
    expect(signal.aborted).toBe(true);

    await act(async () => resolveExtraction({ products: mockState.extracted }));
    expect(screen.queryByText('products.reviewModal.title')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-extracted')).not.toBeInTheDocument();
  });

  it('creates only valid drafts, includes variants, strips provenance, and prevents duplicate in-flight approval', async () => {
    mockState.extracted = [{
      id: 'valid-1', name: 'Review Shirt', price: 125, sku: 'RV-1', track_quantity: true,
      quantity: 4, variants: [{ name: 'Size', options: ['S', 'M'] }], confidence: 0.91, ai_generated: true,
    }];
    let resolveCreate!: (value: unknown) => void;
    mockCreateProduct.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    renderProducts();
    await uploadCsv();
    const approve = screen.getByRole('button', { name: 'common.approve' });
    fireEvent.click(approve);
    fireEvent.click(approve);

    await waitFor(() => expect(mockCreateProduct).toHaveBeenCalledTimes(1));
    const payload = mockCreateProduct.mock.calls[0][0];
    expect(mockCreateProduct.mock.calls[0][1]).toEqual(expect.any(String));
    expect(payload).toMatchObject({ name: 'Review Shirt', price: 125, variants: [{ name: 'Size', options: ['S', 'M'], priceAdjustment: 0, sku: '' }] });
    expect(payload).not.toHaveProperty('ai_generated');
    expect(payload).not.toHaveProperty('confidence');
    await act(async () => resolveCreate({ id: 'created-1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('bulk approval uses allSettled, retains failed rows, and retry never duplicates successful rows', async () => {
    mockState.extracted = [
      { id: 'good', name: 'Good Product', price: 100 },
      { id: 'retry', name: 'Retry Product', price: 200 },
    ];
    mockCreateProduct.mockImplementation(async (payload: { name: string }) => {
      if (payload.name === 'Retry Product' && mockCreateProduct.mock.calls.filter(([call]) => call.name === 'Retry Product').length === 1) {
        throw new Error('temporary failure');
      }
      return { id: `created-${payload.name}` };
    });
    renderProducts();
    await uploadCsv();
    fireEvent.click(screen.getByRole('button', { name: 'products.reviewModal.approveAll' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('1 of 2 imports failed'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-review-form-good')).not.toBeInTheDocument();
    expect(screen.getByTestId('draft-review-form-retry')).toBeInTheDocument();
    expect(mockCreateProduct).toHaveBeenCalledTimes(2);
    const failedRowRequestKey = mockCreateProduct.mock.calls[1][1];

    fireEvent.click(screen.getByRole('button', { name: 'products.reviewModal.approveAll' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockCreateProduct).toHaveBeenCalledTimes(3);
    expect(mockCreateProduct.mock.calls.filter(([call]) => call.name === 'Good Product')).toHaveLength(1);
    expect(mockCreateProduct.mock.calls[2][1]).toBe(failedRowRequestKey);
  });
});
