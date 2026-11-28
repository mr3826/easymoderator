import { useState, useRef, useEffect, useMemo, type ChangeEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, Bot, CheckCircle, Edit2, Trash2, AlertCircle, Search, Filter, X, Loader2, Package, LayoutGrid, List } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { apiClient } from "@/api";
import type { Product, ProductOverview } from "@/api/types/product";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { authService } from "../lib/auth";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { PageHeader } from "./dashboard/PageHeader";
import { useDialogFocus } from "./inbox/useDialogFocus";
import { ProductFormFieldView, ProductTextInput } from "./ProductFormFields";
import { createIdempotencyKey, normalizeProduct, toCreatePayload, validateProductDraft, type ProductDraft } from "./products/productForm";
import { ProductDeleteDialog } from "./products/ProductDeleteDialog";

const ANIMATE = import.meta.env.MODE !== "test";

interface Category {
  id: string;
  name: string;
  is_active?: boolean;
  subcategories?: Array<{ id?: string; name: string; is_active?: boolean }>;
}

type ExtractedProduct = Product & { parseCompleteness?: number };
type ProductsSort = 'name' | 'price-asc' | 'price-desc' | 'stock-asc' | 'stock-desc';
type ProductsView = 'table' | 'cards';

const variantLabel = (variant: unknown): string => {
  if (typeof variant === 'string') return variant;
  if (typeof variant !== 'object' || variant === null) return String(variant ?? '');
  const record = variant as { name?: unknown; options?: unknown };
  const name = typeof record.name === 'string' ? record.name : '';
  const options = Array.isArray(record.options) ? record.options.filter((option): option is string => typeof option === 'string') : [];
  return [name, options.join(', ')].filter(Boolean).join(': ');
};

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
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? 'en';
  const formatNumber = (value: number) => new Intl.NumberFormat(language.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US').format(value);
  const inactiveCategoryLabel = t('categories.status.inactive');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aiGeneratedProducts, setAiGeneratedProducts] = useState<ExtractedProduct[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, ProductDraft>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [approvingIds, setApprovingIds] = useState<string[]>([]);
  const [bulkApproving, setBulkApproving] = useState(false);
  const approvalInFlight = useRef(new Set<string>());
  const bulkApprovalInFlight = useRef(false);
  const approvalRequestKeysRef = useRef(new Map<string, { fingerprint: string; key: string }>());
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const getApprovalRequestKey = (productId: string, payload: ReturnType<typeof toCreatePayload>) => {
    const fingerprint = JSON.stringify(payload);
    const current = approvalRequestKeysRef.current.get(productId);
    if (current?.fingerprint === fingerprint) return current.key;
    const key = createIdempotencyKey();
    approvalRequestKeysRef.current.set(productId, { fingerprint, key });
    return key;
  };

  // Pagination state (client-side for now as API returns full list)
  const [page, setPage] = useState(1);
  const itemsPerPage = 10;
  const [sortBy, setSortBy] = useState<ProductsSort>('name');
  const [view, setView] = useState<ProductsView>('table');

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
    minPrice: '',
    maxPrice: '',
  });

  // Applied filters state - only used after clicking Apply
  const [appliedFilters, setAppliedFilters] = useState({
    category_id: '',
    is_active: '',
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
    queryFn: () => apiClient.getCategories({ include_inactive: true }),
    retry: 1
  });

  const selectableCategories = useMemo(() => {
    const rows = categoriesData.flatMap((category: Category) => {
      const rootLabel = category.is_active === false
        ? `${category.name} (${inactiveCategoryLabel})`
        : category.name;
      return [
        { id: category.id, name: category.name, label: rootLabel },
        ...(category.subcategories ?? []).filter((subcategory) => subcategory.id).map((subcategory) => ({
          id: subcategory.id as string,
          name: subcategory.name,
          label: `${rootLabel} / ${subcategory.name}${subcategory.is_active === false ? ` (${inactiveCategoryLabel})` : ''}`,
        })),
      ];
    });
    const labelCounts = new Map<string, number>();
    rows.forEach((category) => labelCounts.set(category.label.toLowerCase(), (labelCounts.get(category.label.toLowerCase()) ?? 0) + 1));
    return rows.map((category) => labelCounts.get(category.label.toLowerCase())! > 1
      ? { ...category, label: `${category.label} · ${category.id.slice(0, 6)}` }
      : category);
  }, [categoriesData, inactiveCategoryLabel]);
  const categoryIdByName = useMemo(() => {
    const matches = new Map<string, string[]>();
    selectableCategories.forEach((category) => {
      if (!category?.name) return;
      const keys = new Set([category.name, category.label].map((value) => value.trim().toLowerCase()));
      keys.forEach((key) => matches.set(key, [...(matches.get(key) ?? []), category.id]));
    });
    const map: Record<string, string> = {};
    matches.forEach((ids, name) => { if (ids.length === 1) map[name] = ids[0]; });
    return map;
  }, [selectableCategories]);
  const categoryNameById = useMemo(() => {
    const map: Record<string, string> = {};
    selectableCategories.forEach((category) => {
      if (category?.id && category?.label) map[category.id] = category.label;
    });
    return map;
  }, [selectableCategories]);

  const {
    data: overview,
    isLoading: isOverviewLoading,
  } = useQuery<ProductOverview>({
    queryKey: ["product-overview", shopId],
    queryFn: ({ signal }) => apiClient.getProductOverview(signal),
    enabled: !!shopId,
    retry: 1,
  });

  // Query errors render inline below via `isError + queryError` so we don't
  // mirror them into `error` (which would double-display them in the top banner).

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

  // Search, category, status, and price use the API; stock buckets mirror the
  // server predicate and sorting/pagination are applied to the loaded result.
  const filteredProducts = useMemo(() => {
    return stockFilter === 'exceptions' ? allProducts.filter(isStockExceptionProduct)
      : stockFilter === 'out' ? allProducts.filter(isOutOfStockProduct)
      : stockFilter === 'low' ? allProducts.filter(isLowStockProduct)
      : allProducts;
  }, [allProducts, stockFilter]);
  const sortedProducts = useMemo(() => [...filteredProducts].sort((left, right) => {
    if (sortBy === 'name') return left.name.localeCompare(right.name);
    if (sortBy === 'price-asc') return Number(left.price) - Number(right.price);
    if (sortBy === 'price-desc') return Number(right.price) - Number(left.price);
    const leftStock = effectiveStockQuantity(left) ?? Number.NEGATIVE_INFINITY;
    const rightStock = effectiveStockQuantity(right) ?? Number.NEGATIVE_INFINITY;
    return sortBy === 'stock-asc' ? leftStock - rightStock : rightStock - leftStock;
  }), [filteredProducts, sortBy]);
  const totalPages = Math.ceil(sortedProducts.length / itemsPerPage);
  const products = sortedProducts.slice((page - 1) * itemsPerPage, page * itemsPerPage);

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
    appliedFilters.minPrice,
    appliedFilters.maxPrice,
    stockFilter,
    sortBy,
  ]);

  // Pagination component
  const Pagination = () => {
    if (totalPages <= 1) return null;
    return (
      <div className="flex justify-center items-center gap-2 mt-6">
        <button
          className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm hover:bg-em-bg-muted disabled:opacity-50"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
        >
          {t('products.pagination.previous')}
        </button>
        <span className="text-sm text-em-text-primary">
          {t('products.pagination.pageOf', { current: formatNumber(page), total: formatNumber(totalPages) })}
        </span>
        <button
          className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm hover:bg-em-bg-muted disabled:opacity-50"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
        >
          {t('products.pagination.next')}
        </button>
      </div>
    );
  };

  // Debounce server search after the latest keystroke.
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

  const cancelImport = () => {
    uploadAbortControllerRef.current?.abort();
    uploadAbortControllerRef.current = null;
    setShowUploadModal(false);
    setUploadProgress(0);
  };

  const mapExtractedProduct = (product: Record<string, unknown>, index: number): ExtractedProduct => {
    const fields = { ...product };
    const rawCompleteness = fields.confidence;
    const rawAiCompleteness = fields.ai_confidence;
    const rawParseCompleteness = fields.parse_completeness;
    delete fields.aiGenerated;
    delete fields.ai_generated;
    delete fields.confidence;
    delete fields.ai_confidence;
    delete fields.parse_completeness;
    const category = typeof fields.category === 'string' ? fields.category : undefined;
    const categoryId = typeof fields.category_id === 'string' && categoryNameById[fields.category_id]
      ? fields.category_id
      : category ? categoryIdByName[category.trim().toLowerCase()] : undefined;
    const sourceCategory = category
      ?? (typeof fields.category_id === 'string' ? fields.category_id : undefined);
    const rawId = typeof fields.id === 'string' && fields.id ? fields.id : `import-${index + 1}`;
    const parsedCompleteness = Number(rawParseCompleteness ?? rawCompleteness ?? rawAiCompleteness);
    return {
      ...fields,
      id: rawId,
      name: typeof fields.name === 'string' ? fields.name : '',
      price: typeof fields.price === 'number' ? fields.price : Number(fields.price) || 0,
      category: sourceCategory,
      category_id: categoryId,
      createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : new Date().toISOString(),
      updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : new Date().toISOString(),
      parseCompleteness: Number.isFinite(parsedCompleteness)
        ? Math.max(0, Math.min(1, parsedCompleteness > 1 ? parsedCompleteness / 100 : parsedCompleteness))
        : undefined,
    } as ExtractedProduct;
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const controller = new AbortController();
    uploadAbortControllerRef.current = controller;
    setError(null);
    setUploadProgress(10);

    try {
      const content = await readFileContent(file);
      if (controller.signal.aborted) return;
      setUploadProgress(40);
      const result = await apiClient.extractProductsFromUpload({
        filename: file.name,
        content_type: file.type,
        content
      }, controller.signal);
      if (controller.signal.aborted) return;
      setUploadProgress(90);

      const extractedSource = Array.isArray(result)
        ? result
        : Array.isArray(result?.products)
          ? result.products
          : [];
      const extracted = extractedSource.map((product: unknown, index: number) => (
        mapExtractedProduct(typeof product === 'object' && product !== null ? product as Record<string, unknown> : {}, index)
      ));
      if (extracted.length === 0) {
        throw new Error(t('products.errors.noProductsExtracted'));
      }

      setAiGeneratedProducts(extracted);
      setDraftValues(Object.fromEntries(extracted.map((product) => {
        const normalized = normalizeProduct(product);
        const categoryName = product.category?.trim().toLowerCase();
        if (!normalized.category_id && categoryName) normalized.category_id = categoryIdByName[categoryName] ?? '';
        return [product.id, normalized];
      })));
      setShowReviewModal(true);
      setShowUploadModal(false);
    } catch (error: any) {
      if (!controller.signal.aborted) setError(getErrorMessage(error, t('products.errors.uploadFailed')));
    } finally {
      if (uploadAbortControllerRef.current === controller) {
        uploadAbortControllerRef.current = null;
        setUploadProgress(0);
      }
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const handleApproveProduct = async (product: Product) => {
    if (approvalInFlight.current.has(product.id) || bulkApprovalInFlight.current) return;
    const draft = draftValues[product.id] ?? normalizeProduct(product);
    if (Object.keys(validateProductDraft(draft)).length > 0) return;
    approvalInFlight.current.add(product.id);
    setApprovingIds(prev => [...prev, product.id]);
    setError(null);
    try {
      const payload = toCreatePayload(draft);
      await apiClient.createProduct(payload, getApprovalRequestKey(product.id, payload));
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-overview"] });
      approvalRequestKeysRef.current.delete(product.id);
      setAiGeneratedProducts(prev => prev.filter(p => p.id !== product.id));
      if (aiGeneratedProducts.length === 1) setShowReviewModal(false);
      setDraftValues((prev) => {
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
    } catch (error: any) {
      setError(getErrorMessage(error, t('products.errors.approveFailed')));
    } finally {
      approvalInFlight.current.delete(product.id);
      setApprovingIds(prev => prev.filter(id => id !== product.id));
    }
  };

  const handleApproveAll = async () => {
    if (aiGeneratedProducts.length === 0 || bulkApprovalInFlight.current || approvalInFlight.current.size > 0) return;
    bulkApprovalInFlight.current = true;
    setBulkApproving(true);
    setError(null);

    const validProducts = aiGeneratedProducts.filter((product) => {
      const draft = draftValues[product.id] ?? normalizeProduct(product);
      return Object.keys(validateProductDraft(draft)).length === 0;
    });
    const invalidCount = aiGeneratedProducts.length - validProducts.length;
    const results = await Promise.allSettled(validProducts.map((product) => {
      const draft = draftValues[product.id] ?? normalizeProduct(product);
      const payload = toCreatePayload(draft);
      return apiClient.createProduct(payload, getApprovalRequestKey(product.id, payload));
    }));
    const successfulIds = validProducts.filter((_, index) => results[index]?.status === 'fulfilled').map((product) => product.id);
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (successfulIds.length > 0) {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-overview"] });
      setAiGeneratedProducts((prev) => prev.filter((product) => !successfulIds.includes(product.id)));
      successfulIds.forEach((id) => approvalRequestKeysRef.current.delete(id));
      setDraftValues((prev) => {
        const next = { ...prev };
        successfulIds.forEach((id) => delete next[id]);
        return next;
      });
    }

    const remaining = aiGeneratedProducts.length - successfulIds.length;
    if (failedCount + invalidCount > 0) {
      setError(t('products.errors.bulkPartialFailure', { failed: failedCount + invalidCount, total: aiGeneratedProducts.length }));
    }
    setBulkApproving(false);
    bulkApprovalInFlight.current = false;
    if (remaining === 0) setShowReviewModal(false);
  };

  const handleEditProduct = (product: Product) => {
    navigate(`/products/${product.id}/edit`);
  };

  const handleRejectProduct = (productId: string) => {
    if (approvalInFlight.current.has(productId) || bulkApprovalInFlight.current) return;
    setAiGeneratedProducts((prev) => prev.filter(p => p.id !== productId));
    approvalRequestKeysRef.current.delete(productId);
    setDraftValues((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  };

  const handleDeleteProduct = async (productId: string) => {
    // Find product to get its name for confirmation dialog
    const product = products.find(p => p.id === productId);
    if (product) {
      setDeleteError(null);
      setProductToDelete({ id: productId, name: product.name });
      setShowDeleteConfirm(true);
    }
  };

  const confirmDelete = async () => {
    if (!productToDelete || isDeleting) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.deleteProduct(productToDelete.id);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-overview"] });
      setShowDeleteConfirm(false);
      setProductToDelete(null);
      toast.success(t('products.deleteModal.success'));
    } catch (error: any) {
      const message = getErrorMessage(error, t('products.deleteModal.failed'));
      setDeleteError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const cancelDelete = () => {
    if (isDeleting) return;
    setShowDeleteConfirm(false);
    setProductToDelete(null);
    setDeleteError(null);
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
      minPrice: filters.minPrice,
      maxPrice: filters.maxPrice,
    });
  };

  const clearFilters = () => {
    // Reset both filter states
    setFilters({
      category_id: '',
      is_active: '',
      minPrice: '',
      maxPrice: '',
    });
    setSearchQuery('');
    setStockFilter('all');
    setPage(1);
    setAppliedFilters({
      category_id: '',
      is_active: '',
      minPrice: '',
      maxPrice: '',
    });
    setAppliedSearchQuery('');
  };

  const uploadDialogRef = useRef<HTMLDivElement>(null);
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(uploadDialogRef, showUploadModal);
  useDialogFocus(reviewDialogRef, showReviewModal);

  useEffect(() => () => uploadAbortControllerRef.current?.abort(), []);

  const showOverviewFilter = (filter: 'all' | 'active' | 'low' | 'out') => {
    const nextFilters = {
      category_id: '',
      is_active: filter === 'active' ? 'active' : '',
      minPrice: '',
      maxPrice: '',
    };
    setFilters(nextFilters);
    setAppliedFilters(nextFilters);
    setSearchQuery('');
    setAppliedSearchQuery('');
    setStockFilter(filter === 'low' || filter === 'out' ? filter : 'all');
    setPage(1);
  };

  const updateDraft = <K extends keyof ProductDraft,>(product: ExtractedProduct, field: K, value: ProductDraft[K]) => {
    setDraftValues((previous) => ({
      ...previous,
      [product.id]: { ...(previous[product.id] ?? normalizeProduct(product)), [field]: value },
    }));
  };

  const openProductDetails = (product: Product) => navigate(`/products/${product.id}`);
  const handleProductRowKeyDown = (event: KeyboardEvent<HTMLElement>, product: Product) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProductDetails(product);
    }
  };

  const renderProductActions = (product: Product) => (
    <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => handleEditProduct(product)}
        aria-label={t('products.editAria', { name: product.name })}
        className="flex min-h-11 min-w-11 items-center justify-center rounded p-2 text-em-text-secondary hover:bg-em-violet-50 hover:text-em-violet-700"
      >
        <Edit2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => handleDeleteProduct(product.id)}
        aria-label={t('products.deleteAria', { name: product.name })}
        className="flex min-h-11 min-w-11 items-center justify-center rounded p-2 text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );

  const productStatus = (product: Product) => product.status ?? (product.is_active === false ? 'inactive' : 'active');
  const productCategory = (product: Product) => (product.category_id ? categoryNameById[product.category_id] : '') || product.category || t('products.uncategorized');
  const productStock = (product: Product) => {
    if (!product.track_quantity) return t('products.notTracked');
    const quantity = effectiveStockQuantity(product);
    return quantity === null ? '—' : formatNumber(quantity);
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-products min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-4">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          <PageHeader
            title={t('products.title')}
            meta={(
              <span className="text-sm text-em-text-secondary" data-testid="products-filtered-count">
                {t('products.resultsCount', {
                  count: filteredProducts.length,
                  formattedCount: formatNumber(filteredProducts.length),
                })}
              </span>
            )}
          />
        </motion.div>
      {error && !showUploadModal && !showReviewModal && (
        <div role="alert" className="mb-6 bg-em-danger-100 border border-em-danger-700/20 text-em-danger-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <section aria-label={t('products.overview.ariaLabel')} className="space-y-2">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            { key: 'total', label: t('products.totalCountLabel'), value: overview?.total, filter: 'all' as const },
            { key: 'active', label: t('products.statusActive'), value: overview?.active, filter: 'active' as const },
            { key: 'low', label: t('products.stockFilter.low'), value: overview?.low_stock, filter: 'low' as const, partial: overview?.coverage_complete === false },
            { key: 'out', label: t('products.stockFilter.out'), value: overview?.out_of_stock, filter: 'out' as const, partial: overview?.coverage_complete === false },
          ]).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => showOverviewFilter(item.filter)}
              disabled={!overview}
              data-testid={`products-overview-${item.key}`}
              className="min-h-20 rounded-xl border border-em-border bg-em-bg-surface px-4 py-3 text-left transition hover:border-em-violet-300 hover:bg-em-bg-muted disabled:cursor-wait disabled:opacity-70"
            >
              <span className="block text-xs font-medium text-em-text-secondary">{item.label}</span>
              <span className="em-tabular mt-1 block text-xl font-semibold text-em-text-primary">
                {isOverviewLoading || item.value === undefined ? '—' : `${formatNumber(item.value)}${item.partial ? '+' : ''}`}
              </span>
            </button>
          ))}
        </div>
        {overview?.coverage_complete === false && (
          <p className="text-xs text-em-text-secondary" role="note" data-testid="products-overview-coverage-note">
            {t('products.overview.incompleteCoverage', { scanned: formatNumber(overview.scanned), cap: formatNumber(overview.cap) })}
          </p>
        )}
      </section>

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
      ) : isFetched && allProducts.length === 0 && stockFilter === 'all' && !appliedSearchQuery && !appliedFilters.category_id && !appliedFilters.is_active && !appliedFilters.minPrice && !appliedFilters.maxPrice ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 bg-em-bg-surface rounded-xl border border-dashed border-em-border-strong">
          <Package className="h-12 w-12 text-em-text-secondary" />
          <div className="text-center max-w-md">
            <h3 className="text-lg font-semibold text-em-text-primary mb-1">{t('products.emptyTitle', 'Add your first product')}</h3>
            <p className="text-sm text-em-text-secondary">{t('products.emptySubtitle', 'Add products so EasyModerator can recommend the right price, stock, size, and delivery details in customer conversations.')}</p>
          </div>
          <div className="flex gap-3">
              <button
                onClick={() => navigate('/products/add')}
                className="flex min-h-11 items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
              >
                <Plus className="w-5 h-5" />
                {t('products.addProduct')}
              </button>
              <button
                onClick={() => setShowUploadModal(true)}
                className="flex min-h-11 items-center gap-2 px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
              >
                <Upload className="w-5 h-5" />
                {t('products.import')}
              </button>
          </div>
        </div>
      ) : (
        <>
          {/* Search and Filter Toolbar */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <button
                type="button"
                onClick={() => navigate('/products/add')}
                className="flex min-h-11 items-center gap-2 rounded-lg bg-em-violet-600 px-4 py-2 font-medium text-white hover:bg-em-violet-700"
              >
                <Plus className="h-5 w-5" />
                {t('products.addProduct')}
              </button>
              <button
                type="button"
                onClick={() => setShowUploadModal(true)}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-em-text-primary hover:bg-em-bg-muted"
              >
                <Upload className="h-5 w-5" />
                {t('products.import')}
              </button>
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-em-violet-700 hover:bg-em-violet-50"
              >
                {t('products.downloadTemplate')}
              </button>
            </div>
            {/* Search Input */}
            <div className="relative min-w-0 flex-1 basis-full sm:basis-64">
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
                {(stockFilter !== 'all' || appliedFilters.category_id || appliedFilters.is_active || appliedFilters.minPrice || appliedFilters.maxPrice) && (
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
                        {selectableCategories.map((category) => (
                          <option key={category.id} value={category.id}>{category.name}</option>
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

            <label className="flex min-h-11 items-center gap-2 text-sm text-em-text-secondary">
              <span>{t('products.sort.label')}</span>
              <select
                aria-label={t('products.sort.label')}
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as ProductsSort)}
                className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-em-text-primary"
              >
                <option value="name">{t('products.sort.name')}</option>
                <option value="price-asc">{t('products.sort.priceLowHigh')}</option>
                <option value="price-desc">{t('products.sort.priceHighLow')}</option>
                <option value="stock-asc">{t('products.sort.stockLowHigh')}</option>
                <option value="stock-desc">{t('products.sort.stockHighLow')}</option>
              </select>
            </label>
            <div className="flex min-h-11 items-center rounded-lg border border-em-border-strong bg-em-bg-surface p-1" role="group" aria-label={t('products.view.label')}>
              <button
                type="button"
                aria-label={t('products.view.table')}
                aria-pressed={view === 'table'}
                onClick={() => setView('table')}
                className={`flex min-h-9 min-w-10 items-center justify-center rounded-md ${view === 'table' ? 'bg-em-violet-100 text-em-violet-700' : 'text-em-text-secondary hover:bg-em-bg-muted'}`}
              >
                <List className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t('products.view.cards')}
                aria-pressed={view === 'cards'}
                onClick={() => setView('cards')}
                className={`flex min-h-9 min-w-10 items-center justify-center rounded-md ${view === 'cards' ? 'bg-em-violet-100 text-em-violet-700' : 'text-em-text-secondary hover:bg-em-bg-muted'}`}
              >
                <LayoutGrid className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

          </div>

          {view === 'table' ? (
            <div className="overflow-x-auto rounded-xl border border-em-border bg-em-bg-surface">
              <table className="w-full min-w-[760px]">
                <thead className="border-b border-em-border bg-em-bg-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.product')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.sku')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.price')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.quantity')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.category')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.status')}</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-em-text-secondary">{t('products.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-em-border">
                  {products.map((product) => {
                    const status = productStatus(product);
                    return (
                      <tr
                        key={product.id}
                        tabIndex={0}
                        aria-label={t('products.openAria', { name: product.name })}
                        onClick={() => openProductDetails(product)}
                        onKeyDown={(event) => handleProductRowKeyDown(event, product)}
                        className="cursor-pointer hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-em-focus-light"
                      >
                        <td className="px-4 py-4 font-medium text-em-text-primary">{product.name}</td>
                        <td className="px-4 py-4 text-sm text-em-text-secondary">{product.sku || '—'}</td>
                        <td className="px-4 py-4 text-sm text-em-text-primary">৳{formatNumber(Number(product.price))}</td>
                        <td className="px-4 py-4 text-sm text-em-text-primary">{productStock(product)}</td>
                        <td className="px-4 py-4 text-sm text-em-text-secondary">{productCategory(product)}</td>
                        <td className="px-4 py-4">
                          <span className={`rounded-full px-3 py-1 text-sm ${status === 'active' ? 'bg-em-success-100 text-em-success-700' : status === 'inactive' ? 'bg-em-bg-muted text-em-text-primary' : 'bg-em-warning-100 text-em-warning-700'}`}>
                            {t(`products.status.${status}`, { defaultValue: status })}
                          </span>
                        </td>
                        <td className="px-4 py-2">{renderProductActions(product)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {products.length === 0 && <p className="p-8 text-center text-sm text-em-text-secondary">{t('products.emptyResults')}</p>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="products-card-grid">
              {products.map((product) => {
                const status = productStatus(product);
                return (
                  <article
                    key={product.id}
                    tabIndex={0}
                    aria-label={t('products.openAria', { name: product.name })}
                    onClick={() => openProductDetails(product)}
                    onKeyDown={(event) => handleProductRowKeyDown(event, product)}
                    className="min-w-0 cursor-pointer rounded-xl border border-em-border bg-em-bg-surface p-4 shadow-sm hover:border-em-violet-300 focus-visible:outline-2 focus-visible:outline-em-focus-light"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="break-words font-semibold text-em-text-primary">{product.name}</h2>
                        <p className="mt-1 break-words text-sm text-em-text-secondary">{product.sku || '—'}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${status === 'active' ? 'bg-em-success-100 text-em-success-700' : status === 'inactive' ? 'bg-em-bg-muted text-em-text-primary' : 'bg-em-warning-100 text-em-warning-700'}`}>
                        {t(`products.status.${status}`, { defaultValue: status })}
                      </span>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      <div className="min-w-0"><dt className="text-xs text-em-text-secondary">{t('products.columns.price')}</dt><dd className="break-words font-medium text-em-text-primary">৳{formatNumber(Number(product.price))}</dd></div>
                      <div className="min-w-0"><dt className="text-xs text-em-text-secondary">{t('products.columns.quantity')}</dt><dd className="break-words font-medium text-em-text-primary">{productStock(product)}</dd></div>
                      <div className="col-span-2 min-w-0"><dt className="text-xs text-em-text-secondary">{t('products.columns.category')}</dt><dd className="break-words text-em-text-primary">{productCategory(product)}</dd></div>
                    </dl>
                    <div className="mt-3 border-t border-em-border pt-2">{renderProductActions(product)}</div>
                  </article>
                );
              })}
              {products.length === 0 && <p className="col-span-full rounded-xl border border-em-border bg-em-bg-surface p-8 text-center text-sm text-em-text-secondary">{t('products.emptyResults')}</p>}
            </div>
          )}
          <Pagination />

          {/* Upload Modal */}
          {showUploadModal && (
            <div
              ref={uploadDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="products-upload-title"
              className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4"
              onKeyDown={(e) => { if (e.key === 'Escape') cancelImport(); }}
              onClick={(e) => { if (e.target === e.currentTarget) cancelImport(); }}
            >
              <div className="bg-em-bg-surface rounded-xl p-4 md:p-8 max-w-lg w-full">
                <h2 id="products-upload-title" className="text-2xl font-bold text-em-text-primary mb-2">{t('products.uploadModal.title')}</h2>
                <p className="text-em-text-secondary mb-6">{t('products.uploadModal.description')}</p>
                {error && <p role="alert" className="mb-4 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{error}</p>}

                {uploadProgress === 0 ? (
                  <div className="border-2 border-dashed border-em-border-strong rounded-lg p-12 text-center">
                    <Upload className="w-12 h-12 text-em-text-secondary mx-auto mb-4" />
                    <p className="text-em-text-secondary mb-4">{t('products.uploadModal.dragDrop')}</p>
                    <input
                      type="file"
                      onChange={handleFileUpload}
                      accept=".csv,.tsv,.txt"
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
                    onClick={cancelImport}
                    className="flex-1 px-6 py-3 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Imported drafts remain transient until a successful create. */}
          {showReviewModal && aiGeneratedProducts.length > 0 && (
            <div
              ref={reviewDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="products-review-title"
              className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4 overflow-y-auto"
              onKeyDown={(e) => { if (e.key === 'Escape' && !bulkApproving && approvingIds.length === 0) setShowReviewModal(false); }}
              onClick={(e) => { if (e.target === e.currentTarget && !bulkApproving && approvingIds.length === 0) setShowReviewModal(false); }}
            >
              <div className="bg-em-bg-surface rounded-xl p-4 md:p-8 max-w-4xl w-full my-4 md:my-8">
                <div className="flex items-center gap-3 mb-6">
                  <Bot className="w-8 h-8 text-em-violet-700" />
                  <div>
                    <h2 id="products-review-title" className="text-2xl font-bold text-em-text-primary">{t('products.reviewModal.title')}</h2>
                    <p className="text-em-text-secondary">{t('products.reviewModal.description')}</p>
                  </div>
                </div>
                {error && <p role="alert" className="mb-4 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{error}</p>}

                <div className="max-h-[65vh] space-y-4 overflow-y-auto">
                  {aiGeneratedProducts.map((product) => {
                    const draft = draftValues[product.id] ?? normalizeProduct(product);
                    const validationErrors = validateProductDraft(draft);
                    const isInvalid = Object.keys(validationErrors).length > 0;
                    return (
                    <div key={product.id} className="space-y-4 rounded-lg border border-em-violet-300 bg-em-violet-50 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-semibold text-em-text-primary">
                          <Bot className="h-4 w-4 text-em-violet-700" />
                          <span>{t('products.reviewModal.aiExtracted')}</span>
                        </div>
                        {product.parseCompleteness !== undefined && (
                          <span className="rounded bg-em-violet-100 px-2 py-1 text-xs text-em-violet-700">
                            {t('products.reviewModal.parseCompleteness', { percent: formatNumber(Math.round(product.parseCompleteness * 100)) })}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid={`draft-review-form-${product.id}`}>
                        <ProductFormFieldView
                          id={`draft-${product.id}-name`}
                          field="name"
                          label={t('products.form.productName')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                          required
                        >
                          {({ error: fieldError, describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-name`}
                              aria-label={t('products.form.productName')}
                              aria-invalid={Boolean(fieldError)}
                              aria-describedby={describedBy}
                              value={draft.name}
                              onChange={(event) => updateDraft(product, 'name', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        <ProductFormFieldView
                          id={`draft-${product.id}-price`}
                          field="price"
                          label={t('products.reviewModal.sellingPriceBdt')}
                          help={t('products.form.priceHelp')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                          required
                        >
                          {({ error: fieldError, describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-price`}
                              type="number"
                              min="0.01"
                              step="0.01"
                              aria-label={t('products.reviewModal.sellingPriceBdt')}
                              aria-invalid={Boolean(fieldError)}
                              aria-describedby={describedBy}
                              value={draft.price}
                              onChange={(event) => updateDraft(product, 'price', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        <ProductFormFieldView
                          id={`draft-${product.id}-sku`}
                          field="sku"
                          label={t('products.columns.sku')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                        >
                          {({ describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-sku`}
                              aria-label={t('products.columns.sku')}
                              aria-describedby={describedBy}
                              value={draft.sku}
                              onChange={(event) => updateDraft(product, 'sku', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        {product.category && !draft.category_id && (
                          <p role="status" className="rounded-lg border border-em-warning-700/30 bg-em-warning-100 px-3 py-2 text-xs text-em-text-primary">
                            {t('products.reviewModal.unmappedCategory', { category: product.category })}
                          </p>
                        )}
                        <div className="space-y-1.5">
                          <label htmlFor={`draft-${product.id}-category`} className="block text-sm font-medium text-em-text-primary">{t('products.columns.category')}</label>
                          <select
                            id={`draft-${product.id}-category`}
                            aria-label={t('products.columns.category')}
                            value={draft.category_id}
                            onChange={(event) => updateDraft(product, 'category_id', event.target.value)}
                            className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary"
                          >
                            <option value="">{t('products.form.noCategory')}</option>
                            {selectableCategories.map((category) => (
                              <option key={category.id} value={category.id}>{category.label}</option>
                            ))}
                          </select>
                        </div>
                        <ProductFormFieldView
                          id={`draft-${product.id}-quantity`}
                          field="quantity"
                          label={t('products.form.availableQuantity')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                        >
                          {({ error: fieldError, describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-quantity`}
                              type="number"
                              min="0"
                              step="1"
                              disabled={!draft.track_quantity}
                              aria-label={t('products.form.availableQuantity')}
                              aria-invalid={Boolean(fieldError)}
                              aria-describedby={describedBy}
                              value={draft.quantity}
                              onChange={(event) => updateDraft(product, 'quantity', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        <ProductFormFieldView
                          id={`draft-${product.id}-threshold`}
                          field="low_stock_threshold"
                          label={t('products.form.lowStockThreshold')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                        >
                          {({ error: fieldError, describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-threshold`}
                              type="number"
                              min="0"
                              step="1"
                              aria-label={t('products.form.lowStockThreshold')}
                              aria-invalid={Boolean(fieldError)}
                              aria-describedby={describedBy}
                              value={draft.low_stock_threshold}
                              onChange={(event) => updateDraft(product, 'low_stock_threshold', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        <ProductFormFieldView
                          id={`draft-${product.id}-weight`}
                          field="weight"
                          label={t('products.form.packageWeight')}
                          draft={draft}
                          touched
                          errors={validationErrors}
                        >
                          {({ error: fieldError, describedBy }) => (
                            <ProductTextInput
                              id={`draft-${product.id}-weight`}
                              type="number"
                              min="0.01"
                              step="any"
                              aria-label={t('products.form.packageWeight')}
                              aria-invalid={Boolean(fieldError)}
                              aria-describedby={describedBy}
                              value={draft.weight}
                              onChange={(event) => updateDraft(product, 'weight', event.target.value)}
                            />
                          )}
                        </ProductFormFieldView>
                        <label className="flex min-h-11 items-center gap-2 self-end text-sm text-em-text-primary">
                          <input
                            type="checkbox"
                            checked={draft.track_quantity}
                            onChange={(event) => updateDraft(product, 'track_quantity', event.target.checked)}
                          />
                          {t('products.form.trackQuantity')}
                        </label>
                      </div>
                      {Array.isArray(product.variants) && product.variants.length > 0 && (
                        <div className="text-sm">
                          <span className="font-medium text-em-text-secondary">{t('products.reviewModal.variantsLabel')}</span>
                          <ul className="mt-1 flex flex-wrap gap-2">
                            {product.variants.map((variant, index) => (
                              <li key={`${product.id}-variant-${index}`} className="rounded border border-em-violet-200 bg-em-bg-surface px-2 py-1 text-em-text-primary">
                                {variantLabel(variant)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2 border-t border-em-violet-200 pt-3">
                        <button
                          type="button"
                          onClick={() => handleApproveProduct(product)}
                          disabled={isInvalid || approvingIds.includes(product.id) || bulkApproving}
                          className="flex min-h-11 items-center gap-1 rounded-lg bg-em-success-700 px-3 py-2 text-sm text-white hover:bg-em-success-700/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <CheckCircle className="h-4 w-4" />
                          {approvingIds.includes(product.id) ? t('common.approving') : t('common.approve')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectProduct(product.id)}
                          disabled={approvingIds.includes(product.id) || bulkApproving}
                          className="flex min-h-11 items-center gap-1 rounded-lg bg-em-danger-700 px-3 py-2 text-sm text-white hover:bg-em-danger-700/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <AlertCircle className="h-4 w-4" />
                          {t('common.reject')}
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setShowReviewModal(false)}
                    disabled={bulkApproving || approvingIds.length > 0}
                    className="px-6 py-3 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                  >
                    {t('common.close')}
                  </button>
                  <button
                    onClick={handleApproveAll}
                    disabled={bulkApproving || approvingIds.length > 0}
                    className="px-6 py-3 bg-em-success-700 text-white rounded-lg hover:bg-em-success-700/90 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {bulkApproving ? t('common.approving') : t('products.reviewModal.approveAll')}
                  </button>
                </div>
              </div>
            </div>
          )}

          <ProductDeleteDialog
            open={showDeleteConfirm}
            productName={productToDelete?.name}
            isDeleting={isDeleting}
            error={deleteError}
            onOpenChange={(open) => { if (!open) cancelDelete(); }}
            onConfirm={() => void confirmDelete()}
          />

        </>
      )}
      </div>
    </div>
    </MotionConfig>
  );
}
