import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Edit2, Loader2, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import type { Product } from "@/api/types/product";
import { authService } from "../lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import ContextualEntityLink from "./merchant-workspace/ContextualEntityLink";
import { ProductDeleteDialog } from "./products/ProductDeleteDialog";

type EffectiveProduct = Product & { effective_quantity: number | null; images: string[]; is_active: boolean };

function getEffectiveProduct(product: Product): EffectiveProduct {
  const activeVariantQuantities = (product.product_variants ?? [])
    .filter((variant) => variant.is_active === true)
    .map((variant) => Number(variant.quantity ?? 0))
    .filter(Number.isFinite);
  const parentQuantity = Number(product.quantity ?? 0);
  const effectiveQuantity = activeVariantQuantities.length > 0
    ? activeVariantQuantities.reduce((sum, quantity) => sum + quantity, 0)
    : Number.isFinite(parentQuantity) ? parentQuantity : null;
  const images = Array.isArray(product.images)
    ? product.images.filter((image): image is string => typeof image === "string" && image.length > 0)
    : [];

  return {
    ...product,
    images: images.length ? images : product.image_url ? [product.image_url] : [],
    is_active: product.is_active ?? product.status !== "inactive",
    effective_quantity: effectiveQuantity,
  };
}

export default function ProductDetails() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "en";
  const formatNumber = (value: number) => new Intl.NumberFormat(language.startsWith("bn") ? "bn-BD" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
  const formatBdt = (value: number) => `৳${formatNumber(value)}`;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { productId } = useParams<{ productId: string }>();
  const shopId = authService.getCurrentShopId();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const productQuery = useQuery<Product>({
    queryKey: ["product", productId],
    queryFn: () => apiClient.getProduct(productId!),
    enabled: Boolean(productId && shopId),
    retry: 1,
  });

  const handleDeleteProduct = async () => {
    if (!productQuery.data || !productId || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.deleteProduct(productQuery.data.id);
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["product", productId] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
      ]);
      setShowDeleteConfirm(false);
      toast.success(t("products.detail.deleteSuccess"));
      navigate("/products");
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("products.detail.deleteFailed"));
      setDeleteError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("products.detail.copySuccess"));
    } catch {
      toast.error(t("products.detail.copyFailed"));
    }
  };

  if (!productId || !shopId || productQuery.isLoading) {
    const label = !productId
      ? t("products.detail.idNotFound")
      : !shopId ? t("products.detail.noShopSelected") : t("products.detail.loading");
    if (productId && shopId && productQuery.isLoading) {
      return (
        <div className="flex items-center justify-center gap-2 py-12" role="status">
          <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none text-em-info-700" aria-hidden="true" />
          <span className="text-em-text-secondary">{label}</span>
        </div>
      );
    }
    return (
      <div className="p-4 md:p-8">
        <button
          type="button"
          onClick={() => navigate("/products")}
          className="mb-4 inline-flex min-h-11 items-center gap-2 text-em-info-700 hover:text-em-info-700"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          {t("products.detail.backToProducts")}
        </button>
        <div role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-em-danger-700">{label}</div>
      </div>
    );
  }

  if (productQuery.isError || !productQuery.data) {
    return (
      <div className="p-4 md:p-8">
        <button
          type="button"
          onClick={() => navigate("/products")}
          className="mb-4 inline-flex min-h-11 items-center gap-2 text-em-info-700 hover:text-em-info-700"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          {t("products.detail.backToProducts")}
        </button>
        <div role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-em-danger-700">
          <p>{getErrorMessage(productQuery.error, t("products.detail.loadFailed"))}</p>
          <button type="button" onClick={() => void productQuery.refetch()} className="mt-2 min-h-11 rounded-lg border border-em-danger-700/30 px-3 text-sm">
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  const product = getEffectiveProduct(productQuery.data);
  const quantityLabel = product.effective_quantity === null ? t("common.notProvided") : formatNumber(product.effective_quantity);

  return (
    <div className="em-products min-h-full p-4 md:p-8">
      <div className="mb-6 md:mb-8">
        <button
          type="button"
          onClick={() => navigate("/products")}
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm text-em-text-secondary hover:text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          {t("products.detail.backToProducts")}
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-em-text-primary md:text-3xl">{product.name}</h1>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigate(`/products/${encodeURIComponent(product.id)}/edit`)}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-em-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-em-violet-700 focus-visible:outline-2 focus-visible:outline-em-focus-light"
            >
              <Edit2 className="h-4 w-4" aria-hidden="true" />
              {t("common.edit")}
            </button>
            <button
              type="button"
              onClick={() => { setDeleteError(null); setShowDeleteConfirm(true); }}
              disabled={isDeleting}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-em-danger-700 px-4 py-2 text-sm font-medium text-white hover:bg-em-danger-700/90 disabled:opacity-60"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
              {isDeleting ? t("common.deleting") : t("common.delete")}
            </button>
            <button
              type="button"
              onClick={() => void handleShare()}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-em-border-strong px-4 py-2 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted"
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              {t("products.detail.share")}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="space-y-6 lg:col-span-2">
          <section aria-labelledby="product-detail-images" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-images" className="mb-4 text-lg font-semibold text-em-text-primary">{t("products.detail.images")}</h2>
            {product.images.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {product.images.map((image, index) => (
                  <img
                    key={`${image}-${index}`}
                    src={image}
                    alt={t("products.detail.imageAlt", { index: index + 1 })}
                    className="aspect-square w-full rounded-lg border border-em-border object-cover"
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center rounded-lg bg-em-bg-muted text-sm text-em-text-secondary">
                {t("products.detail.noImages")}
              </div>
            )}
          </section>

          <section aria-labelledby="product-detail-description" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-description" className="mb-3 text-lg font-semibold text-em-text-primary">{t("common.description")}</h2>
            <p className="whitespace-pre-wrap text-sm leading-6 text-em-text-primary">{product.description || t("products.detail.noDescription")}</p>
          </section>

          {(product.category || product.category_id) && (
            <section aria-labelledby="product-detail-category" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
              <h2 id="product-detail-category" className="mb-3 text-lg font-semibold text-em-text-primary">{t("nav.categories")}</h2>
              {product.category_id ? (
                <ContextualEntityLink to={`/categories/${encodeURIComponent(product.category_id)}`}>
                  {product.category || t("categories.title")}
                </ContextualEntityLink>
              ) : <p className="text-sm text-em-text-primary">{product.category}</p>}
            </section>
          )}

          <section aria-labelledby="product-detail-specifications" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-specifications" className="mb-4 text-lg font-semibold text-em-text-primary">{t("products.detail.specifications")}</h2>
            <dl className="space-y-3">
              {product.sku && <div className="flex justify-between gap-4"><dt className="text-sm text-em-text-secondary">{t("products.detail.sku")}</dt><dd className="text-right text-sm font-medium text-em-text-primary">{product.sku}</dd></div>}
              {product.brand && <div className="flex justify-between gap-4"><dt className="text-sm text-em-text-secondary">{t("products.detail.brand")}</dt><dd className="text-right text-sm font-medium text-em-text-primary">{product.brand}</dd></div>}
              {product.weight !== null && product.weight !== undefined && <div className="flex justify-between gap-4"><dt className="text-sm text-em-text-secondary">{t("products.detail.weight")}</dt><dd className="text-right text-sm font-medium text-em-text-primary">{product.weight} {product.weight_unit}</dd></div>}
              {product.tags && product.tags.length > 0 && (
                <div>
                  <dt className="mb-2 text-sm text-em-text-secondary">{t("products.detail.tags")}</dt>
                  <dd className="flex flex-wrap gap-2">
                    {product.tags.map((tag, index) => <span key={`${tag}-${index}`} className="rounded-full bg-em-bg-muted px-3 py-1 text-sm text-em-text-primary">{tag}</span>)}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="product-detail-pricing" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-pricing" className="mb-4 text-lg font-semibold text-em-text-primary">{t("products.detail.pricing")}</h2>
            <div>
              <span className="text-sm text-em-text-secondary">{t("products.detail.sellingPrice")}</span>
              <div className="text-3xl font-bold text-em-text-primary">{formatBdt(Number(product.price))} <span className="text-sm font-medium">BDT</span></div>
            </div>
            {product.compare_at_price !== undefined && product.compare_at_price !== null && (
              <div className="mt-4">
                <span className="text-sm text-em-text-secondary">{t("products.detail.comparePrice")}</span>
                <div className="text-lg text-em-text-secondary line-through">{formatBdt(Number(product.compare_at_price))}</div>
              </div>
            )}
            {product.cost_per_item !== undefined && product.cost_per_item !== null && (
              <div className="mt-4 border-t border-em-border pt-3">
                <span className="text-sm text-em-text-secondary">{t("products.detail.costPerItem")}</span>
                <div className="text-lg text-em-text-primary">{formatBdt(Number(product.cost_per_item))}</div>
              </div>
            )}
          </section>

          <section aria-labelledby="product-detail-inventory" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-inventory" className="mb-4 text-lg font-semibold text-em-text-primary">{t("products.detail.inventory")}</h2>
            <div className="space-y-3">
              <div>
                <span className="text-sm text-em-text-secondary">{t("products.detail.quantity")}</span>
                <div className="text-2xl font-bold text-em-text-primary">{product.track_quantity === false ? t("products.form.dontTrackInventory") : quantityLabel}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${product.is_active ? "bg-em-success-700" : "bg-em-border-strong"}`} aria-hidden="true" />
                <span className="text-sm text-em-text-primary">{product.is_active ? t("common.active") : t("common.inactive")}</span>
              </div>
              {product.low_stock_threshold !== null && product.low_stock_threshold !== undefined && (
                <div className="text-sm text-em-text-secondary">
                  {t("products.detail.lowStock", { threshold: product.low_stock_threshold })}
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="product-detail-status" className="rounded-xl border border-em-border bg-em-bg-surface p-5 md:p-6">
            <h2 id="product-detail-status" className="mb-4 text-lg font-semibold text-em-text-primary">{t("common.status")}</h2>
            <dl className="space-y-3">
              <div><dt className="text-sm text-em-text-secondary">{t("products.detail.created")}</dt><dd className="text-sm text-em-text-primary">{new Date(product.createdAt).toLocaleDateString()}</dd></div>
              <div><dt className="text-sm text-em-text-secondary">{t("products.detail.lastUpdated")}</dt><dd className="text-sm text-em-text-primary">{new Date(product.updatedAt).toLocaleDateString()}</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      <ProductDeleteDialog
        open={showDeleteConfirm}
        productName={product.name}
        isDeleting={isDeleting}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open) setDeleteError(null);
          setShowDeleteConfirm(open);
        }}
        onConfirm={() => void handleDeleteProduct()}
      />
    </div>
  );
}
