import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Edit2, Trash2, Share2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import type { Product } from "@/api/types/product";
import { authService } from "../lib/auth";
import AddProduct from "./AddProduct";
import { getErrorMessage } from "@shared/lib/http/errors";
import ContextualEntityLink from "./merchant-workspace/ContextualEntityLink";

export default function ProductDetails() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { productId } = useParams<{ productId: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    const fetchProduct = async () => {
      try {
        setIsLoading(true);
        setError(null);
        if (!productId) {
          setError(t('products.detail.idNotFound'));
          return;
        }
        const shopId = authService.getCurrentShopId();
        if (!shopId) {
          setError(t('products.detail.noShopSelected'));
          return;
        }
        const fetchedProduct = await apiClient.getProduct(productId);
        setProduct(fetchedProduct);
      } catch (error: any) {
        setError(getErrorMessage(error, t('products.detail.loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };

    fetchProduct();
  }, [productId]);

  const handleDeleteProduct = async () => {
    if (!product) return;
    if (!window.confirm(t('products.detail.deleteConfirm'))) return;

    try {
      setIsDeleting(true);
      await apiClient.deleteProduct(product.id);
      toast.success(t('products.detail.deleteSuccess'));
      navigate('/products');
    } catch (error: any) {
      toast.error(getErrorMessage(error, t('products.detail.deleteFailed')));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('products.detail.copySuccess'));
    } catch {
      toast.error(t('products.detail.copyFailed'));
    }
  };

  const handleSaveEdit = (updatedProduct: Product) => {
    setProduct(updatedProduct);
    setShowEditModal(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-em-info-700" />
        <span className="ml-2 text-em-text-secondary">{t('products.detail.loading')}</span>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="p-8">
        <button
          onClick={() => navigate('/products')}
          className="text-em-info-700 hover:text-em-info-700 flex items-center gap-2 mb-4"
        >
          <ArrowLeft className="w-5 h-5" />
          {t('products.detail.backToProducts')}
        </button>
        <div className="bg-em-danger-100 border border-em-danger-700/20 text-em-danger-700 px-4 py-3 rounded-lg">
          {error || t('products.detail.notFound')}
        </div>
      </div>
    );
  }

  return (
    <div className="em-products min-h-full p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 md:mb-8">
        <button
          onClick={() => navigate('/products')}
          className="text-em-text-secondary hover:text-em-text-primary flex items-center gap-2 mb-4 text-sm"
        >
          <ArrowLeft className="w-5 h-5" />
          {t('products.detail.backToProducts')}
        </button>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1 className="text-2xl md:text-3xl font-bold text-em-text-primary">{product.name}</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setShowEditModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
          >
            <Edit2 className="w-4 h-4" />
            {t('common.edit')}
          </button>
          <button
            onClick={handleDeleteProduct}
            disabled={isDeleting}
            className="flex items-center gap-2 px-4 py-2 bg-em-danger-700 text-white rounded-lg hover:bg-em-danger-700/90 disabled:opacity-60"
          >
            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {isDeleting ? t('common.deleting') : t('common.delete')}
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-2 px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
          >
            <Share2 className="w-4 h-4" />
            {t('products.detail.share')}
          </button>
        </div>
        </div>
      </div>

      {/* Product Details */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Images */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('products.detail.images')}</h3>
            {product.images && product.images.length > 0 ? (
              <div className="grid grid-cols-3 gap-4">
                {product.images.map((image: string, index: number) => (
                  <img
                    key={index}
                    src={image}
                    alt={t('products.detail.imageAlt', { index: index + 1 })}
                    className="w-full h-40 object-cover rounded-lg"
                  />
                ))}
              </div>
            ) : (
              <div className="bg-em-bg-muted rounded-lg h-40 flex items-center justify-center">
                <span className="text-em-text-secondary">{t('products.detail.noImages')}</span>
              </div>
            )}
          </div>

          {/* Description */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('common.description')}</h3>
            <p className="text-em-text-primary">{product.description || t('products.detail.noDescription')}</p>
          </div>

          {(product.category || product.category_id) && (
            <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
              <h3 className="text-lg font-semibold text-em-text-primary mb-3">{t('nav.categories')}</h3>
              {product.category_id ? (
                <ContextualEntityLink to={`/categories/${encodeURIComponent(product.category_id)}`}>
                  {product.category || t('categories.title')}
                </ContextualEntityLink>
              ) : (
                <p className="text-em-text-primary">{product.category}</p>
              )}
            </div>
          )}

          {/* Specifications */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('products.detail.specifications')}</h3>
            <div className="space-y-3">
              {product.sku && (
                <div className="flex justify-between">
                  <span className="text-em-text-secondary">{t('products.detail.sku')}</span>
                  <span className="text-em-text-primary font-medium">{product.sku}</span>
                </div>
              )}
              {product.brand && (
                <div className="flex justify-between">
                  <span className="text-em-text-secondary">{t('products.detail.brand')}</span>
                  <span className="text-em-text-primary font-medium">{product.brand}</span>
                </div>
              )}
              {product.weight && (
                <div className="flex justify-between">
                  <span className="text-em-text-secondary">{t('products.detail.weight')}</span>
                  <span className="text-em-text-primary font-medium">{product.weight} {product.weight_unit}</span>
                </div>
              )}
              {product.tags && product.tags.length > 0 && (
                <div>
                  <span className="text-em-text-secondary block mb-2">{t('products.detail.tags')}</span>
                  <div className="flex flex-wrap gap-2">
                    {product.tags.map((tag: string, index: number) => (
                      <span key={index} className="px-3 py-1 bg-em-bg-muted text-em-text-primary text-sm rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Pricing */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('products.detail.pricing')}</h3>
            <div className="space-y-3">
              <div>
                <span className="text-sm text-em-text-secondary">{t('products.detail.sellingPrice')}</span>
                <div className="text-3xl font-bold text-em-text-primary">৳{product.price}</div>
              </div>
              {product.compare_at_price && (
                <div>
                  <span className="text-sm text-em-text-secondary">{t('products.detail.comparePrice')}</span>
                  <div className="text-xl text-em-text-secondary line-through">${product.compare_at_price}</div>
                </div>
              )}
              {product.cost_per_item && (
                <div className="pt-3 border-t border-em-border">
                  <span className="text-sm text-em-text-secondary">{t('products.detail.costPerItem')}</span>
                  <div className="text-lg text-em-text-primary">${product.cost_per_item}</div>
                </div>
              )}
            </div>
          </div>

          {/* Inventory */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('products.detail.inventory')}</h3>
            <div className="space-y-3">
              <div>
                <span className="text-sm text-em-text-secondary">{t('products.detail.quantity')}</span>
                <div className="text-2xl font-bold text-em-text-primary">{product.quantity || 0}</div>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${product.is_active ? 'bg-em-success-700' : 'bg-em-border-strong'}`}></div>
                <span className="text-sm text-em-text-primary">{product.is_active ? t('common.active') : t('common.inactive')}</span>
              </div>
              {product.low_stock_threshold && (
                <div className="text-sm text-em-text-secondary">
                  {t('products.detail.lowStock', { threshold: product.low_stock_threshold })}
                </div>
              )}
            </div>
          </div>

          {/* Status */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h3 className="text-lg font-semibold text-em-text-primary mb-4">{t('common.status')}</h3>
            <div className="space-y-2">
              <div>
                <span className="text-sm text-em-text-secondary">{t('products.detail.created')}</span>
                <div className="text-sm text-em-text-primary">{new Date(product.createdAt).toLocaleDateString()}</div>
              </div>
              <div>
                <span className="text-sm text-em-text-secondary">{t('products.detail.lastUpdated')}</span>
                <div className="text-sm text-em-text-primary">{new Date(product.updatedAt).toLocaleDateString()}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <AddProduct
          isModal={true}
          editMode={true}
          editProduct={product}
          onClose={() => setShowEditModal(false)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
}
