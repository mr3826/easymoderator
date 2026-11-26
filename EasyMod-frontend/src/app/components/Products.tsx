import { useState, useRef, useEffect, useMemo, ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, Bot, CheckCircle, Edit2, Trash2, AlertCircle, Search, Filter, X, Loader2, Package } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogOverlay } from "./ui/dialog";
import { apiClient } from "@/api";
import type { Product } from "@/api/types/product";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { authService } from "../lib/auth";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { PageHeader } from "./dashboard/PageHeader";
import { useDialogFocus } from "./inbox/useDialogFocus";

const ANIMATE = import.meta.env.MODE !== "test";

interface Category {
  id: string;
  name: string;
}

const isAiProduct = (product: Product): boolean =>
  Boolean(product.aiGenerated ?? product.ai_generated);

/**
 * D2 stock-exception predicate (single definition, shared with the server
 * `GET /api/product/stock-exceptions` authority and the Products nav badge).
 * A8 MAJOR-1: the SERVER is the authority — the client mirrors its scope and
 * edge semantics token-for-token so badge == list even for synthetic payloads:
 *  - scope: `is_active` (the server scans `is_active: true` — a retired but
 *    still-tracked product is NOT an exception: it can never sell) AND
 *    `track_quantity`;
 *  - effective quantity = Σ ACTIVE variant quantities when active variants
 *    carry finite quantities (variants are the ordering authority since
 *    D-P2-02); a non-finite variant quantity contributes NOTHING (the server
 *    drops it), and a product whose active variants are all non-finite falls
 *    back to the parent quantity;
 *  - an unparseable parent stock level classifies as OUT OF STOCK (the
 *    server's fail-toward-a-visible-exception honesty), never silent in-stock;
 *  - out ≤ 0; low 0 < q ≤ low_stock_threshold; exceptions = out + low
 *    (disjoint by construction). Exported so the parity unit tests pin client
 *    and server to the same rule.
 */
export const effectiveStockQuantity = (product: Product): number | null => {
  const variantQuantities = (product.product_variants ?? [])
    .filter((variant) => variant?.is_active === true)
    .map((variant) => Number(variant.quantity ?? 0))
    .filter((quantity) => Number.isFinite(quantity));
  if (variantQuantities.length > 0) {
    return variantQuantities.reduce((sum, quantity) => sum + quantity, 0);
  }
  // Parent fallback — null = unparseable (the predicates treat it as out).
  const parentQuantity = Number(product.quantity ?? 0);
  return Number.isFinite(parentQuantity) ? parentQuantity : null;
};

export const isOutOfStockProduct = (product: Product): boolean => {
  if (product.is_active === false) return false; // server scope: is_active only
  if (product.track_quantity !== true) return false;
  const quantity = effectiveStockQuantity(product);
  // Unparseable parent stock fails toward a VISIBLE exception (server rule).
  return quantity === null || quantity <= 0;
};

export const isLowStockProduct = (product: Product): boolean => {
  if (product.is_active === false) return false; // server scope: is_active only
  if (product.track_quantity !== true) return false;
  const quantity = effectiveStockQuantity(product);
  return quantity !== null
    && quantity > 0
    && typeof product.low_stock_threshold === 'number'
    && Number.isFinite(product.low_stock_threshold)
    && quantity <= product.low_stock_threshold;
};

export const isStockExceptionProduct = (product: Product): boolean =>
  isOutOfStockProduct(product) || isLowStockProduct(product);

/** Fail-closed ?stock= seed values (mirrors the Orders bucket seed). */
export type ProductsStockFilter = 'all' | 'exceptions' | 'low' | 'out';
const parseStockParam = (value: string | null): ProductsStockFilter => (
  value === 'exceptions' || value === 'low' || value === 'out' ? value : 'all'
);

export default function Products() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [aiGeneratedProducts, setAiGeneratedProducts] = useState<Product[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftEditValues, setDraftEditValues] = useState<{ name: string; price: string; sku: string; category: string }>({
    name: '',
    price: '',
    sku: '',
    category: '',
  });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [approvingIds, setApprovingIds] = useState<string[]>([]);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [categoryNameMap, setCategoryNameMap] = useState<Record<string, string>>({});

  // Pagination state (client-side for now as API returns full list)
  const [page, setPage] = useState(1);
  const itemsPerPage = 10;

  // Search and Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  // D2: one stock filter carries the toolbar control AND the fail-closed
  // ?stock= seed ('exceptions' | 'out' | 'low'). Unknown seeds → 'all'.
  const [stockFilter, setStockFilter] = useState<ProductsStockFilter>('all');
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    category_id: '',
    is_active: '',
    source: '',
    minPrice: '',
    maxPrice: '',
  });

  // Applied filters state - only used after clicking Apply
  const [appliedFilters, setAppliedFilters] = useState({
    category_id: '',
    is_active: '',
    source: '',
    minPrice: '',
    maxPrice: '',
  });

  const [appliedSearchQuery, setAppliedSearchQuery] = useState('');
  const searchDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delete confirmation dialog state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [productToDelete, setProductToDelete] = useState<{ id: string; name: string } | null>(null);

  // Use TanStack Query for products
  const shopId = authService.getCurrentShopId();

  const queryParams = useMemo(() => {
    const params: any = {};
    if (appliedSearchQuery) params.search = appliedSearchQuery;
    if (appliedFilters.category_id) params.category_id = appliedFilters.category_id;
    if (appliedFilters.is_active) params.is_active = appliedFilters.is_active === 'active';
    if (appliedFilters.minPrice) params.min_price = appliedFilters.minPrice;
    if (appliedFilters.maxPrice) params.max_price = appliedFilters.maxPrice;
    return params;
  }, [appliedSearchQuery, appliedFilters]);

  const {
    data: allProducts = [],
    isLoading,
    isFetched,
    isError,
    error: queryError,
    refetch: fetchProducts
  } = useQuery({
    queryKey: ["products", shopId, queryParams],
    queryFn: async () => {
      if (!shopId) throw new Error("No shop selected");
      return apiClient.getProducts(queryParams);
    },
    enabled: !!shopId,
    // The axios client already retries 5xx twice with 1s + 2s backoff
    // ([client.ts:159-174]). Layering react-query's default retry: 2 on top
    // produced ~30 s of spinner before the user saw any error — see plan
    // cached-finding-lerdorf.md Phase 3.2. One retry is enough here.
    retry: 1
  });

  // Use TanStack Query for categories — same retry rationale as products above.
  const {
    data: categoriesData = []
  } = useQuery({
    queryKey: ["categories"],
    queryFn: () => apiClient.getCategories(),
    retry: 1
  });

  // Build categoryNameMap and categoryMap from categoriesData
  const categoryMap = useMemo(() => {
    const map: Record<string, string> = {};
    categoriesData.forEach((category: Category) => {
      if (category?.name) {
        map[category.name] = category.id;
      }
    });
    return map;
  }, [categoriesData]);

  useEffect(() => {
    if (categoriesData.length) {
      const map: Record<string, string> = {};
      categoriesData.forEach((category: Category) => {
        if (category?.name) {
          map[category.name.trim().toLowerCase()] = category.id;
        }
      });
      setCategoryNameMap(map);
    }
  }, [categoriesData]);

  // Query errors render inline below via `isError + queryError` so we don't
  // mirror them into `error` (which would double-display them in the top banner).

  // Get unique categories list
  const categoriesList = useMemo(() => categoriesData.map((c: Category) => c.name), [categoriesData]);

  // Deep link (/products?stock=exceptions|low|out) from the Products nav badge
  // and BusinessHealth: seed the existing client filter fail-closed (unknown or
  // missing values keep 'all'), mirroring the Orders bucket-seed contract. The
  // server owns the D2 predicate; this only selects the matching rows with the
  // SAME predicate (parity-tested), so the badge can never advertise rows the
  // filtered list cannot show.
  useEffect(() => {
    const seeded = parseStockParam(searchParams.get('stock'));
    if (seeded !== 'all') setStockFilter(seeded);
  // Seeds once on mount, like the Orders bucket effect it mirrors.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Client-side pagination and source filtering (backend queryParams covers category/status/price/search)
  const filteredProducts = useMemo(() => {
    let list = stockFilter === 'exceptions' ? allProducts.filter(isStockExceptionProduct)
      : stockFilter === 'out' ? allProducts.filter(isOutOfStockProduct)
      : stockFilter === 'low' ? allProducts.filter(isLowStockProduct)
      : allProducts;
    if (appliedFilters.source === 'ai') {
      list = list.filter(isAiProduct);
    } else if (appliedFilters.source === 'manual') {
      list = list.filter((product) => !isAiProduct(product));
    }
    return list;
  }, [allProducts, stockFilter, appliedFilters.source]);
  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);
  const products = filteredProducts.slice((page - 1) * itemsPerPage, page * itemsPerPage);

  // WP-04: reset to the first page whenever an applied filter value changes.
  // A stale page index beyond the filtered window slices to an empty table,
  // and Pagination unmounts when totalPages <= 1 — leaving matching products
  // unreachable. This matches the reset contract already used by clearFilters
  // and the lowStockOnly toggle. Keyed on the primitive applied values (not the
  // appliedFilters object) so re-applying identical filters keeps the page.
  useEffect(() => {
    setPage(1);
  }, [
    appliedSearchQuery,
    appliedFilters.category_id,
    appliedFilters.is_active,
    appliedFilters.source,
    appliedFilters.minPrice,
    appliedFilters.maxPrice,
    stockFilter,
  ]);

  // Pagination component
  const Pagination = () => {
    if (totalPages <= 1) return null;
    return (
      <div className="flex justify-center items-center gap-2 mt-6">
        <button
          className="px-3 py-1 rounded border bg-em-bg-surface disabled:opacity-50 text-sm hover:bg-em-bg-muted"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
        >
          {t('products.pagination.previous')}
        </button>
        <span className="text-sm text-em-text-primary">
          {t('products.pagination.pageOf', { current: page, total: totalPages })}
        </span>
        <button
          className="px-3 py-1 rounded border bg-em-bg-surface disabled:opacity-50 text-sm hover:bg-em-bg-muted"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
        >
          {t('products.pagination.next')}
        </button>
      </div>
    );
  };

  // Debounce search input - wait 2 seconds after user stops typing
  useEffect(() => {
    // Clear previous timer if exists
    if (searchDebounceTimer.current) {
      clearTimeout(searchDebounceTimer.current);
    }

    // Set new timer
    searchDebounceTimer.current = setTimeout(() => {
      setAppliedSearchQuery(searchQuery);
    }, 300);

    // Cleanup on unmount or when searchQuery changes
    return () => {
      if (searchDebounceTimer.current) {
        clearTimeout(searchDebounceTimer.current);
      }
    };
  }, [searchQuery]);

  const readFileContent = async (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension === 'csv' || extension === 'txt' || extension === 'tsv') {
      return file.text();
    }
    throw new Error(t('products.errors.unsupportedFileType'));
  };

  const mapExtractedProduct = (product: any): Product => {
    return {
      ...product,
      price: typeof product.price === 'number' ? product.price : Number(product.price) || 0,
      aiGenerated: product.aiGenerated ?? product.ai_generated ?? true,
      confidence: product.confidence ?? product.ai_confidence ?? 0,
      status: product.status || 'pending',
      createdAt: product.createdAt || product.created_at || new Date().toISOString(),
      updatedAt: product.updatedAt || product.updated_at || new Date().toISOString(),
    } as Product;
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploadProgress(10);

    try {
      const content = await readFileContent(file);
      setUploadProgress(40);
      const result = await apiClient.extractProductsFromUpload({
        filename: file.name,
        content_type: file.type,
        content
      });
      setUploadProgress(90);

      const extractedSource = Array.isArray(result)
        ? result
        : Array.isArray(result?.products)
          ? result.products
          : [];
      const extracted = extractedSource.map(mapExtractedProduct);
      if (extracted.length === 0) {
        throw new Error(t('products.errors.noProductsExtracted'));
      }

      setAiGeneratedProducts(extracted);
      setShowReviewModal(true);
      setShowUploadModal(false);
    } catch (error: any) {
      setError(getErrorMessage(error, t('products.errors.uploadFailed')));
    } finally {
      setUploadProgress(0);
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const buildCreatePayload = (product: Product) => {
    const categoryName = product.category?.trim().toLowerCase() || '';
    const resolvedCategoryId = product.category_id || (categoryName ? categoryNameMap[categoryName] : undefined);
    const payload: any = {
      name: product.name,
      price: product.price,
      sku: product.sku || undefined,
      description: product.description || undefined,
      category: product.category || undefined,
      category_id: resolvedCategoryId,
      tags: Array.isArray(product.tags) ? product.tags : undefined,
      quantity: product.quantity ?? undefined,
      track_quantity: product.quantity !== undefined && product.quantity !== null,
      ai_generated: true,
      confidence: product.confidence ?? undefined,
      brand: product.brand || undefined,
      weight: product.weight ?? undefined,
      weight_unit: product.weight_unit || undefined
    };

    return payload;
  };

  const handleApproveProduct = async (product: Product) => {
    if (!product.price || product.price <= 0) {
      setError(t('products.errors.invalidPrice', { name: product.name }));
      return;
    }

    setApprovingIds(prev => [...prev, product.id]);
    try {
      await apiClient.createProduct(buildCreatePayload(product));
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setAiGeneratedProducts(prev => prev.filter(p => p.id !== product.id));
    } catch (error: any) {
      setError(getErrorMessage(error, t('products.errors.approveFailed')));
    } finally {
      setApprovingIds(prev => prev.filter(id => id !== product.id));
    }
  };

  const handleApproveAll = async () => {
    if (aiGeneratedProducts.length === 0) return;
    setBulkApproving(true);
    setError(null);

    const validProducts = aiGeneratedProducts.filter(product => product.price && product.price > 0);
    const invalidProducts = aiGeneratedProducts.filter(product => !product.price || product.price <= 0);
    if (invalidProducts.length > 0) {
      setError(t('products.errors.someInvalidPrices'));
    }

    await Promise.allSettled(
      validProducts.map(product =>
        apiClient.createProduct(buildCreatePayload(product))
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["products"] });
            setAiGeneratedProducts(prev => prev.filter(p => p.id !== product.id));
          })
          .catch(error => {
            setError(getErrorMessage(error, t('products.errors.approveNamedFailed', { name: product.name })));
          })
      )
    );

    setBulkApproving(false);
    setShowReviewModal(false);
  };

  const handleEditProduct = (product: Product) => {
    navigate(`/products/${product.id}/edit`);
  };

  const handleRejectProduct = (productId: string) => {
    setAiGeneratedProducts(aiGeneratedProducts.filter(p => p.id !== productId));
  };

  const handleDeleteProduct = async (productId: string) => {
    // Find product to get its name for confirmation dialog
    const product = products.find(p => p.id === productId);
    if (product) {
      setProductToDelete({ id: productId, name: product.name });
      setShowDeleteConfirm(true);
    }
  };

  const confirmDelete = async () => {
    if (!productToDelete) return;

    try {
      await apiClient.deleteProduct(productToDelete.id);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setShowDeleteConfirm(false);
      setProductToDelete(null);
      toast.success(t('products.deleteModal.success'));
    } catch (error: any) {
      toast.error(getErrorMessage(error, t('products.deleteModal.failed')));
      setShowDeleteConfirm(false);
      setProductToDelete(null);
    }
  };

  const cancelDelete = () => {
    setShowDeleteConfirm(false);
    setProductToDelete(null);
  };

  const handleDownloadTemplate = () => {
    const csvContent = [
      'name,price,sku,category,description,brand,weight,weight_unit,quantity,variants',
      'Example Product,100,SKU-001,Electronics,A great product,BrandName,0.5,kg,10,"Color: Red|Blue"',
      'Another Product,250,SKU-002,Clothing,Nice shirt,FashionCo,0.3,kg,25,"Size: S|M|L|XL"',
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'product-upload-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const applyFilters = () => {
    setShowFilterPanel(false);
    // Copy filters to applied filters to trigger fetch
    setAppliedFilters({
      category_id: filters.category_id,
      is_active: filters.is_active,
      source: filters.source,
      minPrice: filters.minPrice,
      maxPrice: filters.maxPrice,
    });
  };

  const clearFilters = () => {
    // Reset both filter states
    setFilters({
      category_id: '',
      is_active: '',
      source: '',
      minPrice: '',
      maxPrice: '',
    });
    setSearchQuery('');
    setStockFilter('all');
    setPage(1);
    setAppliedFilters({
      category_id: '',
      is_active: '',
      source: '',
      minPrice: '',
      maxPrice: '',
    });
    setAppliedSearchQuery('');
  };

  const uploadDialogRef = useRef<HTMLDivElement>(null);
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(uploadDialogRef, showUploadModal);
  useDialogFocus(reviewDialogRef, showReviewModal);

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-products min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-4">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          <PageHeader title={t('products.title')} />
        </motion.div>
      {error && (
        <div role="alert" className="mb-6 bg-em-danger-100 border border-em-danger-700/20 text-em-danger-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {isError && !isLoading ? (
        <div role="alert" className="flex flex-col items-center justify-center py-12 gap-3">
          <AlertCircle className="h-8 w-8 text-em-danger-700" />
          <p className="text-em-text-primary">{queryError instanceof Error ? queryError.message : t('products.loadError', 'Could not load products. Please try again.')}</p>
          <button
            onClick={() => fetchProducts()}
            className="px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 text-sm"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : isLoading ? (
        <div role="status" className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-em-info-700" />
          <span className="ml-2 text-em-text-secondary">{t('products.loading')}</span>
        </div>
      ) : isFetched && allProducts.length === 0 && !appliedSearchQuery && !appliedFilters.category_id && !appliedFilters.is_active && !appliedFilters.minPrice && !appliedFilters.maxPrice ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 bg-em-bg-surface rounded-xl border border-dashed border-em-border-strong">
          <Package className="h-12 w-12 text-em-text-secondary" />
          <div className="text-center max-w-md">
            <h3 className="text-lg font-semibold text-em-text-primary mb-1">{t('products.emptyTitle', 'Add your first product')}</h3>
            <p className="text-sm text-em-text-secondary">{t('products.emptySubtitle', 'Add products so EasyModerator can recommend the right price, stock, size, and delivery details in customer conversations.')}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setShowUploadModal(true)}
              className="flex min-h-11 items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
            >
              <Upload className="w-5 h-5" />
              {t('products.uploadFile')}
            </button>
            <button
              onClick={() => navigate('/products/add')}
              className="flex min-h-11 items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
            >
              <Plus className="w-5 h-5" />
              {t('products.addManually')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-end mb-6 md:mb-8 gap-3 flex-wrap">
            <div className="flex gap-3">
              <div className="relative">
                <button
                  onClick={() => setShowUploadModal(true)}
                  className="flex min-h-11 items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
                >
                  <Upload className="w-5 h-5" />
                  {t('products.uploadFile')}
                </button>
                <button
                  onClick={handleDownloadTemplate}
                  className="absolute -bottom-6 right-0 text-xs text-em-violet-700 hover:text-em-violet-700 hover:underline whitespace-nowrap"
                >
                  {t('products.downloadTemplate')}
                </button>
              </div>
              <button
                onClick={() => navigate('/products/add')}
                className="flex min-h-11 items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
              >
                <Plus className="w-5 h-5" />
                {t('products.addManually')}
              </button>
            </div>

          </div>
          {totalPages > 1 && <Pagination />}

          {/* Search and Filter Toolbar */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            {/* Search Input */}
            <div className="flex-1 min-w-[300px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-em-text-secondary" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('products.searchPlaceholder')}
                aria-label={t('products.searchPlaceholder')}
                className="w-full pl-10 pr-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
              />
            </div>

            {/* D2 stock filter: the low-stock toggle in variant-aware form,
                plus the exception/out views the badge and BusinessHealth seed
                (?stock=exceptions|low|out). Published stockFilter keys only. */}
            <div className="flex flex-wrap items-center gap-2" data-testid="products-stock-filter">
              {([
                { value: 'exceptions' as const, label: t('products.stockFilter.exceptions'), aria: t('products.stockFilter.exceptionsAria') },
                { value: 'low' as const, label: t('products.stockFilter.low'), aria: t('products.stockFilter.lowAria') },
                { value: 'out' as const, label: t('products.stockFilter.out'), aria: undefined },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={stockFilter === option.value}
                  aria-label={option.aria}
                  data-testid={`products-stock-${option.value}`}
                  onClick={() => {
                    setStockFilter(stockFilter === option.value ? 'all' : option.value);
                    setPage(1);
                  }}
                  className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${stockFilter === option.value ? 'border-em-violet-600 bg-em-violet-50 text-em-violet-700' : 'border-em-border-strong bg-em-bg-surface text-em-text-primary hover:bg-em-bg-muted'}`}
                >
                  {option.label}
                </button>
              ))}
              {stockFilter !== 'all' && (
                <button
                  type="button"
                  data-testid="products-stock-clear"
                  onClick={() => { setStockFilter('all'); setPage(1); }}
                  className="flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50"
                >
                  {t('products.stockFilter.clear')}
                </button>
              )}
            </div>

            {/* Filter Button */}
            <div className="relative">
              <button
                onClick={() => setShowFilterPanel(!showFilterPanel)}
                aria-expanded={showFilterPanel}
                aria-controls="products-filter-panel"
                className="flex items-center gap-2 px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
              >
                <Filter className="w-5 h-5" />
                {t('products.filter')}
                {(stockFilter !== 'all' || appliedFilters.category_id || appliedFilters.is_active || appliedFilters.source || appliedFilters.minPrice || appliedFilters.maxPrice) && (
                  <span className="w-2 h-2 bg-em-violet-600 rounded-full"></span>
                )}
              </button>

              {/* Filter Panel */}
              {showFilterPanel && (
                <div id="products-filter-panel" className="absolute top-full mt-2 right-0 w-80 max-w-[calc(100vw-2rem)] bg-em-bg-surface border border-em-border rounded-lg shadow-lg z-10 p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-em-text-primary">{t('products.filterTitle')}</h3>
                    <button
                      onClick={() => setShowFilterPanel(false)}
                      aria-label={t('common.close')}
                      className="text-em-text-secondary hover:text-em-text-primary"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    {/* Category Filter */}
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.filterCategory')}
                      </label>
                      <select
                        value={filters.category_id}
                        onChange={(e) => setFilters({ ...filters, category_id: e.target.value })}
                        className="w-full px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      >
                        <option value="">{t('products.allCategories')}</option>
                        {categoriesList.map(catName => (
                          <option key={categoryMap[catName]} value={categoryMap[catName]}>{catName}</option>
                        ))}
                      </select>
                    </div>

                    {/* Status Filter */}
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.filterStatus')}
                      </label>
                      <select
                        value={filters.is_active}
                        onChange={(e) => setFilters({ ...filters, is_active: e.target.value })}
                        className="w-full px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      >
                        <option value="">{t('products.allStatus')}</option>
                        <option value="active">{t('products.statusActive')}</option>
                        <option value="inactive">{t('products.statusInactive')}</option>
                      </select>
                    </div>

                    {/* Source Filter */}
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.filterSource')}
                      </label>
                      <select
                        value={filters.source}
                        onChange={(e) => setFilters({ ...filters, source: e.target.value })}
                        className="w-full px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      >
                        <option value="">{t('products.allSources')}</option>
                        <option value="ai">{t('products.sourceAI')}</option>
                        <option value="manual">{t('products.sourceManual')}</option>
                      </select>
                    </div>

                    {/* Price Range Filter */}
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.filterPrice')}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={filters.minPrice}
                          onChange={(e) => setFilters({ ...filters, minPrice: e.target.value })}
                          placeholder={t('products.priceMin')}
                          className="flex-1 px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                          step="0.01"
                          min="0"
                        />
                        <span className="text-em-text-secondary">–</span>
                        <input
                          type="number"
                          value={filters.maxPrice}
                          onChange={(e) => setFilters({ ...filters, maxPrice: e.target.value })}
                          placeholder={t('products.priceMax')}
                          className="flex-1 px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                          step="0.01"
                          min="0"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-4 pt-4 border-t border-em-border">
                    <button
                      onClick={clearFilters}
                      className="flex-1 px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                    >
                      {t('common.clear')}
                    </button>
                    <button
                      onClick={applyFilters}
                      className="flex-1 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
                    >
                      {t('common.apply')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Catalog count relocated from the retired header band (C2). */}
            <span
              className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary"
              data-testid="products-total-count"
            >
              {t('products.totalCountLabel')}: {allProducts.length}
            </span>
          </div>

          {/* Products Table */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-em-bg-muted border-b border-em-border">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.product')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.sku')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.price')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.quantity')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.category')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.variants')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.status')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.source')}</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-em-text-secondary uppercase tracking-wider">{t('products.columns.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-em-border">
                {products.map((product) => (
                  <tr key={product.id} className="hover:bg-em-bg-muted">
                    <td className="px-6 py-4">
                      <div className="font-medium text-em-text-primary">{product.name}</div>
                    </td>
                    <td className="px-6 py-4 text-sm text-em-text-secondary">{product.sku}</td>
                    <td className="px-6 py-4 text-sm text-em-text-primary">৳{product.price}</td>
                    <td className="px-6 py-4 text-sm text-em-text-primary">
                      {product.track_quantity ? product.quantity || 0 : '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-em-text-secondary">{product.category}</td>
                    <td className="px-6 py-4 text-sm text-em-text-secondary">
                      {product.variants && Array.isArray(product.variants) && product.variants.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {product.variants.map((variant, idx) => (
                            <span key={idx} className="inline-block px-2 py-1 bg-em-info-100 text-em-info-700 text-xs rounded">
                              {typeof variant === 'object' && variant !== null ? String((variant as { name?: unknown }).name ?? '') : String(variant)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-em-text-secondary">{t('products.noVariants')}</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-3 py-1 rounded-full text-sm ${product.status === 'active'
                        ? 'bg-em-success-100 text-em-success-700'
                        : product.status === 'inactive'
                          ? 'bg-em-bg-muted text-em-text-primary'
                          : 'bg-em-warning-100 text-em-warning-700'
                        }`}>
                        {t(`products.status.${product.status}`, { defaultValue: product.status || '' })}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {isAiProduct(product) ? (
                        <div className="flex items-center gap-1 text-sm text-em-violet-700">
                          <Bot className="w-4 h-4" />
                          <span>
                            {typeof product.confidence === 'number' && Number.isFinite(product.confidence)
                              ? t('products.aiSource', { confidence: Math.round(product.confidence * 100) })
                              : t('products.sourceAI')}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-em-text-secondary">{t('products.sourceManual')}</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEditProduct(product)}
                          aria-label={t('products.editAria', { name: product.name })}
                          className="p-2 text-em-text-secondary hover:text-em-violet-700 hover:bg-em-violet-50 rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteProduct(product.id)}
                          aria-label={t('products.deleteAria', { name: product.name })}
                          className="p-2 text-em-text-secondary hover:text-em-danger-700 hover:bg-em-danger-100 rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Upload Modal */}
          {showUploadModal && (
            <div
              ref={uploadDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="products-upload-title"
              className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4"
              onKeyDown={(e) => { if (e.key === 'Escape') setShowUploadModal(false); }}
              onClick={(e) => { if (e.target === e.currentTarget) setShowUploadModal(false); }}
            >
              <div className="bg-em-bg-surface rounded-xl p-4 md:p-8 max-w-lg w-full">
                <h2 id="products-upload-title" className="text-2xl font-bold text-em-text-primary mb-2">{t('products.uploadModal.title')}</h2>
                <p className="text-em-text-secondary mb-6">{t('products.uploadModal.description')}</p>

                {uploadProgress === 0 ? (
                  <div className="border-2 border-dashed border-em-border-strong rounded-lg p-12 text-center">
                    <Upload className="w-12 h-12 text-em-text-secondary mx-auto mb-4" />
                    <p className="text-em-text-secondary mb-4">{t('products.uploadModal.dragDrop')}</p>
                    <input
                      type="file"
                      onChange={handleFileUpload}
                      accept=".csv,.xlsx,.xls,.pdf,.txt,.doc,.docx"
                      className="hidden"
                      id="file-upload"
                    />
                    <label
                      htmlFor="file-upload"
                      className="inline-block px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 cursor-pointer"
                    >
                      {t('products.uploadModal.chooseFile')}
                    </label>
                    <p className="text-sm text-em-text-secondary mt-4">{t('products.uploadModal.supported')}</p>
                  </div>
                ) : (
                  <div>
                    <div className="mb-4">
                      <div className="flex items-center justify-between text-sm text-em-text-secondary mb-2">
                        <span>{t('products.uploadModal.processing')}</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full bg-em-bg-muted rounded-full h-2">
                        <div
                          role="progressbar"
                          aria-valuenow={uploadProgress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="bg-em-violet-600 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        ></div>
                      </div>
                    </div>
                    <p className="text-sm text-em-text-secondary text-center">
                      {t('products.uploadModal.extracting')}
                    </p>
                  </div>
                )}

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => {
                      setShowUploadModal(false);
                      setUploadProgress(0);
                    }}
                    className="flex-1 px-6 py-3 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Review AI Products Modal */}
          {showReviewModal && aiGeneratedProducts.length > 0 && (
            <div
              ref={reviewDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="products-review-title"
              className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4 overflow-y-auto"
              onKeyDown={(e) => { if (e.key === 'Escape') setShowReviewModal(false); }}
              onClick={(e) => { if (e.target === e.currentTarget) setShowReviewModal(false); }}
            >
              <div className="bg-em-bg-surface rounded-xl p-4 md:p-8 max-w-4xl w-full my-4 md:my-8">
                <div className="flex items-center gap-3 mb-6">
                  <Bot className="w-8 h-8 text-em-violet-700" />
                  <div>
                    <h2 id="products-review-title" className="text-2xl font-bold text-em-text-primary">{t('products.reviewModal.title')}</h2>
                    <p className="text-em-text-secondary">{t('products.reviewModal.description')}</p>
                  </div>
                </div>

                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {aiGeneratedProducts.map((product) => {
                    const isEditingDraft = editingDraftId === product.id;
                    return (
                    <div key={product.id} className="border-2 border-em-violet-300 rounded-lg p-4 bg-em-violet-50">
                      {isEditingDraft ? (
                        <div className="space-y-3" data-testid={`draft-edit-form-${product.id}`}>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="mb-1 block text-xs font-medium text-em-text-secondary">{t('products.columns.product')}</label>
                              <input
                                type="text"
                                aria-label={t('products.columns.product')}
                                value={draftEditValues.name}
                                onChange={(e) => setDraftEditValues((prev) => ({ ...prev, name: e.target.value }))}
                                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium text-em-text-secondary">{t('products.columns.price')}</label>
                              <input
                                type="number"
                                min="0.01"
                                step="0.01"
                                aria-label={t('products.columns.price')}
                                value={draftEditValues.price}
                                onChange={(e) => setDraftEditValues((prev) => ({ ...prev, price: e.target.value }))}
                                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium text-em-text-secondary">{t('products.columns.sku')}</label>
                              <input
                                type="text"
                                aria-label={t('products.columns.sku')}
                                value={draftEditValues.sku}
                                onChange={(e) => setDraftEditValues((prev) => ({ ...prev, sku: e.target.value }))}
                                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium text-em-text-secondary">{t('products.columns.category')}</label>
                              <input
                                type="text"
                                aria-label={t('products.columns.category')}
                                value={draftEditValues.category}
                                onChange={(e) => setDraftEditValues((prev) => ({ ...prev, category: e.target.value }))}
                                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light"
                              />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const parsedPrice = Number(draftEditValues.price);
                                setAiGeneratedProducts((prev) => prev.map((item) => (
                                  item.id === product.id
                                    ? {
                                        ...item,
                                        name: draftEditValues.name.trim() || item.name,
                                        price: Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : item.price,
                                        sku: draftEditValues.sku.trim(),
                                        category: draftEditValues.category.trim() || undefined,
                                      }
                                    : item
                                )));
                                setEditingDraftId(null);
                              }}
                              className="min-h-11 rounded-lg bg-em-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-em-violet-700"
                            >
                              {t('common.save')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingDraftId(null)}
                              className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-semibold text-em-text-primary">{product.name}</h3>
                            {typeof product.confidence === 'number' && Number.isFinite(product.confidence) && (
                              <span className="px-2 py-1 bg-em-violet-100 text-em-violet-700 text-xs rounded">
                                {t('products.reviewModal.confidence', { percent: Math.round(product.confidence * 100) })}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <span className="text-em-text-secondary">{t('products.reviewModal.skuLabel')}</span>
                              <span className="ml-2 text-em-text-primary">{product.sku}</span>
                            </div>
                            <div>
                              <span className="text-em-text-secondary">{t('products.reviewModal.priceLabel')}</span>
                              <span className="ml-2 text-em-text-primary">৳{product.price}</span>
                            </div>
                            <div>
                              <span className="text-em-text-secondary">{t('products.reviewModal.categoryLabel')}</span>
                              <span className="ml-2 text-em-text-primary">{product.category}</span>
                            </div>
                            <div>
                              <span className="text-em-text-secondary">{t('products.reviewModal.variantsLabel')}</span>
                              <span className="ml-2 text-em-text-primary">{product.variants?.join(', ')}</span>
                            </div>
                          </div>
                          {product.aliases && (
                            <div className="mt-2 text-sm">
                              <span className="text-em-text-secondary">{t('products.reviewModal.aliasesLabel')}</span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {product.aliases.map((alias, i) => (
                                  <span key={i} className="px-2 py-1 bg-em-bg-surface text-em-text-primary text-xs rounded border border-em-violet-300">
                                    {alias}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingDraftId(product.id);
                            setDraftEditValues({
                              name: product.name || '',
                              price: String(product.price ?? ''),
                              sku: product.sku || '',
                              category: product.category || '',
                            });
                          }}
                          className="flex min-h-11 items-center gap-1 px-3 py-2 bg-em-bg-surface border border-em-violet-300 text-em-violet-700 rounded-lg hover:bg-em-violet-100 text-sm"
                        >
                          <Edit2 className="w-4 h-4" />
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => handleApproveProduct(product)}
                          disabled={approvingIds.includes(product.id)}
                          className="flex min-h-11 items-center gap-1 px-3 py-2 bg-em-success-700 text-white rounded-lg hover:bg-em-success-700/90 text-sm"
                        >
                          <CheckCircle className="w-4 h-4" />
                          {approvingIds.includes(product.id) ? t('common.approving') : t('common.approve')}
                        </button>
                        <button
                          onClick={() => handleRejectProduct(product.id)}
                          className="flex min-h-11 items-center gap-1 px-3 py-2 bg-em-danger-700 text-white rounded-lg hover:bg-em-danger-700/90 text-sm"
                        >
                          <AlertCircle className="w-4 h-4" />
                          {t('common.reject')}
                        </button>
                      </div>
                        </>
                      )}
                    </div>
                    );
                  })}
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setShowReviewModal(false)}
                    className="px-6 py-3 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                  >
                    {t('common.close')}
                  </button>
                  <button
                    onClick={handleApproveAll}
                    disabled={bulkApproving}
                    className="px-6 py-3 bg-em-success-700 text-white rounded-lg hover:bg-em-success-700/90 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {bulkApproving ? t('common.approving') : t('products.reviewModal.approveAll')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Delete Confirmation Dialog (Radix) */}
          <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
            <DialogOverlay />
            <DialogContent className="max-w-sm w-full mx-4">
              <DialogHeader>
                <DialogTitle>{t('products.deleteModal.title')}</DialogTitle>
                <DialogDescription>
                  {t('products.deleteModal.description', { name: productToDelete?.name })}
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-3 mt-6">
                <button onClick={cancelDelete} className="flex-1 px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted">{t('common.cancel')}</button>
                <button onClick={confirmDelete} className="flex-1 px-4 py-2 bg-em-danger-700 text-white rounded-lg hover:bg-em-danger-700/90">{t('common.delete')}</button>
              </div>
            </DialogContent>
          </Dialog>

        </>
      )}
      </div>
    </div>
    </MotionConfig>
  );
}
