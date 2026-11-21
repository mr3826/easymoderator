import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, X, Plus, ChevronDown, ChevronUp, Package, Tag, FolderTree, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import type { Product } from "@/api/types/product";
import { VALIDATION, SKU_PREFIX, SKU_LENGTH } from "../constants/product";
import { getErrorMessage } from "@shared/lib/http/errors";
import { downscaleImage } from "../lib/downscaleImage";
import { useDialogFocus } from "./inbox/useDialogFocus";

interface AddProductProps {
  editMode?: boolean;
  editProduct?: Product | null;
  onClose?: () => void;
  onSave?: (product: Product) => void;
  isModal?: boolean;
}

export default function AddProduct({ editMode = false, editProduct = null, onClose, onSave, isModal = false }: AddProductProps) {
  const { t } = useTranslation();
    // Store object URLs for cleanup
    const [imageObjectUrls, setImageObjectUrls] = useState<string[]>([]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { productId } = useParams<{ productId?: string }>();
  
  // Determine if this is an edit page based on URL
  const isEditPage = !!productId && !isModal;
  
  // Form state - Product Info
  const [isSaving, setIsSaving] = useState(false);
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [discountable, setDiscountable] = useState(false);
  const [taxable, setTaxable] = useState(false);
  const [productImages, setProductImages] = useState<File[]>([]);
  // Uploaded URL per picked File. Keyed by the File object rather than by index
  // so removeImage/moveImage keep working untouched — reordering the array
  // reorders the URLs with it, and a removed File just stops being looked up.
  const [uploadedImageUrls, setUploadedImageUrls] = useState<Map<File, string>>(new Map());
  const [uploadingImages, setUploadingImages] = useState(0);
  // Images already saved on the product (edit mode). Kept separate from newly
  // picked Files so a re-save without touching the picker cannot wipe them.
  const [existingImageUrls, setExistingImageUrls] = useState<string[]>([]);

    // Clean up object URLs to prevent memory leaks
    useEffect(() => {
      // Revoke previous URLs
      imageObjectUrls.forEach(url => URL.revokeObjectURL(url));
      // Create new URLs for current images
      const urls = productImages.map(file => URL.createObjectURL(file));
      setImageObjectUrls(urls);
      // Cleanup on unmount
      return () => {
        urls.forEach(url => URL.revokeObjectURL(url));
      };
    }, [productImages]);
  
  // Categories
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  
  // Inventory & Stock
  const [sku, setSku] = useState("");
  const [brand, setBrand] = useState("");
  const [stockType, setStockType] = useState<"unlimited" | "limited">("limited");
  const [stockQuantity, setStockQuantity] = useState("");
  const [minStockThreshold, setMinStockThreshold] = useState("");
  const [lowStockAlert, setLowStockAlert] = useState(true);
  
  // Additional Details
  const [productCondition, setProductCondition] = useState<"new" | "used" | "refurbished">("new");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  
  // Business Rules
  const [warranty, setWarranty] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  
  // Variants
  const [variants, setVariants] = useState<Array<{name: string; options: string[]; priceAdjustment: string; sku: string}>>([]);
  
  // Shipping
  const [requiresShipping, setRequiresShipping] = useState(true);
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState<"kg" | "g" | "lb" | "oz">("kg");
  const [dimensions, setDimensions] = useState({ length: "", width: "", height: "" });
  const [dimensionUnit, setDimensionUnit] = useState<"cm" | "in">("cm");
  const [shippingClass, setShippingClass] = useState<"standard" | "express" | "fragile">("standard");
  const [handlingTime, setHandlingTime] = useState("1-3");
  const [freeShipping, setFreeShipping] = useState(false);
  
  // Collapsible states
  const [showCategories, setShowCategories] = useState(false);
  const [showAdditionalDetails, setShowAdditionalDetails] = useState(false);
  const [showBusinessRules, setShowBusinessRules] = useState(false);
  const [showVariants, setShowVariants] = useState(false);
  const [showShipping, setShowShipping] = useState(false);

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Fetch product data when editing via URL
  useEffect(() => {
    if (isEditPage && productId) {
      const fetchProduct = async () => {
        try {
          const product = await apiClient.getProduct(productId);
          setProductName(product.name || "");
          setDescription(product.description || "");
          setBasePrice(product.price?.toString() || "");
          setSku(product.sku || "");
          setBrand(product.brand || "");
          setDiscountable(product.allow_discounts !== false);
          setTaxable(product.charge_tax !== false);
          setStockQuantity(product.quantity?.toString() || "");
          setMinStockThreshold(product.low_stock_threshold?.toString() || "");
          setLowStockAlert(product.send_low_stock_alert === true);
          // Set stock tracking based on track_quantity
          setStockType(product.track_quantity === false ? "unlimited" : "limited");
          if (product.category_id) {
            setSelectedCategories([product.category_id]);
          }
          if (product.variants) setVariants(product.variants as any);
          if (product.tags) setTags(product.tags);
          setExistingImageUrls(product.images || (product.image_url ? [product.image_url] : []));
        } catch (err: any) {
          const message = getErrorMessage(err, 'Failed to load product');
          setError(message);
          toast.error(message);
        }
      };
      fetchProduct();
    }
  }, [isEditPage, productId]);

  // Load product data when in edit mode (modal)
  useEffect(() => {
    if (editMode && editProduct && isModal) {
      setProductName(editProduct.name || "");
      setDescription(editProduct.description || "");
      setBasePrice(editProduct.price?.toString() || "");
      setSku(editProduct.sku || "");
      setBrand(editProduct.brand || "");
      setDiscountable(editProduct.allow_discounts !== false);
      setTaxable(editProduct.charge_tax !== false);
      setStockQuantity(editProduct.quantity?.toString() || "");
      setMinStockThreshold(editProduct.low_stock_threshold?.toString() || "");
      setLowStockAlert(editProduct.send_low_stock_alert === true);
      // Set stock tracking based on track_quantity
      setStockType(editProduct.track_quantity === false ? "unlimited" : "limited");
      // Handle category - use category_id which is the foreign key
      if (editProduct.category_id) {
        setSelectedCategories([editProduct.category_id]);
      }
      if (editProduct.variants) setVariants(editProduct.variants as any);
      if (editProduct.tags) setTags(editProduct.tags);
      setExistingImageUrls(editProduct.images || (editProduct.image_url ? [editProduct.image_url] : []));
    }
  }, [editMode, editProduct, isModal]);

  // Fetch categories from server
  useEffect(() => {
    const fetchCategories = async () => {
      try {
        setCategoriesLoading(true);
        const fetchedCategories = await apiClient.getCategories();
        setCategories(fetchedCategories);
      } catch (error) {
        toast.error('Failed to load categories');
        setCategories([]);
      } finally {
        setCategoriesLoading(false);
      }
    };

    fetchCategories();
  }, []);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remainingSlots = VALIDATION.MAX_IMAGES - productImages.length - existingImageUrls.length;
    const filesToAdd = files.slice(0, Math.max(0, remainingSlots));
    if (filesToAdd.length === 0) return;

    setProductImages(prev => [...prev, ...filesToAdd]);

    // Upload as soon as the file is picked, not at submit. Five sequential
    // uploads at save time would be a 30s+ spinner on a mobile uplink with no
    // feedback; this way it overlaps with the merchant filling in the form.
    setUploadingImages(n => n + filesToAdd.length);
    filesToAdd.forEach(async (file) => {
      try {
        const dataUrl = await downscaleImage(file);
        const url = await apiClient.uploadProductImage(dataUrl);
        setUploadedImageUrls(prev => new Map(prev).set(file, url));
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, t('products.form.imageUploadFailed')));
        // Drop it from the picker so the merchant never saves a product
        // believing an image is attached when it is not.
        setProductImages(prev => prev.filter(f => f !== file));
      } finally {
        setUploadingImages(n => n - 1);
      }
    });

    // Let the same file be re-picked after a failure.
    e.target.value = '';
  };

  const removeExistingImage = (index: number) => {
    setExistingImageUrls(prev => prev.filter((_, i) => i !== index));
  };

  const totalImages = existingImageUrls.length + productImages.length;
  const imagesFull = totalImages >= VALIDATION.MAX_IMAGES;

  const removeImage = (index: number) => {
    setProductImages(productImages.filter((_, i) => i !== index));
  };

  const moveImage = (index: number, direction: "left" | "right") => {
    const newImages = [...productImages];
    const targetIndex = direction === "left" ? index - 1 : index + 1;
    if (targetIndex >= 0 && targetIndex < newImages.length) {
      [newImages[index], newImages[targetIndex]] = [newImages[targetIndex], newImages[index]];
      setProductImages(newImages);
    }
  };

  const generateSku = () => {
    const randomSku = `${SKU_PREFIX}${Math.random().toString(36).substring(2, 2 + SKU_LENGTH).toUpperCase()}`;
    setSku(randomSku);
  };

  const addTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag("");
    }
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const addVariant = () => {
    setVariants([...variants, { name: "", options: [], priceAdjustment: "0", sku: "" }]);
  };

  const removeVariant = (index: number) => {
    setVariants(variants.filter((_, i) => i !== index));
  };

  const updateVariant = (index: number, field: string, value: any) => {
    const updated = [...variants];
    updated[index] = { ...updated[index], [field]: value };
    setVariants(updated);
  };

  const handleSave = async (action: "draft" | "publish") => {
    // Guard against double submission — without this a second click while the
    // POST was in flight created a duplicate product.
    if (isSaving) return;

    // Saving mid-upload would persist the product with only the images that had
    // finished, silently dropping the rest.
    if (uploadingImages > 0) {
      toast.error(t('products.form.imagesStillUploading'));
      return;
    }

    try {
      setError(null);

      if (!productName.trim()) {
        setError('Product name is required');
        return;
      }

      const price = parseFloat(basePrice);
      if (isNaN(price) || price <= 0) {
        setError('Valid selling price is required');
        return;
      }

      const productData: any = {
        name: productName.trim(),
        price,
      };

      // Only send optional text fields when they have content. The API validates
      // them with Joi `.optional()`, which still rejects "" — sending an empty
      // description made every product without one fail with a 400.
      const trimmedDescription = description.trim();
      if (trimmedDescription) {
        productData.description = trimmedDescription;
      }

      if (selectedCategories.length > 0) {
        productData.category_id = selectedCategories[0];
      }

      // Trim before the emptiness check — a whitespace-only value would survive
      // a truthiness test and then be rejected by the API's `.trim()` rule.
      if (sku.trim()) {
        productData.sku = sku.trim();
      }

      if (brand.trim()) {
        productData.brand = brand.trim();
      }

      if (tags.length > 0) {
        productData.tags = tags;
      }

      if (variants.length > 0) {
        productData.variants = variants;
      }

      // Add inventory and tax settings
      productData.allow_discounts = discountable;
      productData.charge_tax = taxable;
      productData.send_low_stock_alert = lowStockAlert;
      
      // Set track_quantity based on stockType
      productData.track_quantity = stockType === "limited";
      
      // If not tracking quantity, don't send quantity value
      if (stockType === "limited" && stockQuantity) {
        productData.quantity = parseInt(stockQuantity);
      } else {
        productData.quantity = 0;
      }
      
      if (minStockThreshold) {
        productData.low_stock_threshold = parseInt(minStockThreshold);
      }

      // Images: already-saved ones first, then newly picked files in picker
      // order. Reading the URLs through productImages (rather than the Map's own
      // insertion order) is what makes moveImage's reordering stick — the first
      // entry becomes the primary image.
      const imageUrls = [
        ...existingImageUrls,
        ...productImages.map(file => uploadedImageUrls.get(file)).filter((u): u is string => Boolean(u)),
      ];
      if (imageUrls.length > 0) {
        productData.images = imageUrls;
        // Both fields are required, not redundant: product-link.service selects
        // only image_url when building the cards sent to customers, while
        // product-ai.service prefers the images array. Set one and the other
        // silently loses its thumbnail.
        productData.image_url = imageUrls[0];
      }

      // Add other fields as needed

      setIsSaving(true);

      if ((editMode && editProduct) || isEditPage) {
        // Update existing product
        const updateId = isEditPage ? productId : editProduct?.id;
        await apiClient.updateProduct(updateId!, productData);
        await queryClient.invalidateQueries({ queryKey: ["products"] });
        console.log("Updating product as:", action);
        if (onSave) {
          onSave({ ...editProduct, ...productData });
        }
        if (onClose) {
          onClose();
        } else {
          navigate("/products");
        }
      } else {
        // Create new product
        await apiClient.createProduct(productData);
        await queryClient.invalidateQueries({ queryKey: ["products"] });
        console.log("Creating product as:", action);
        navigate("/products");
      }
    } catch (error: any) {
      // httpClient normalises every axios failure via normalizeApiError, which
      // returns a flat { type, statusCode, message, details } object — there is
      // no `error.response`. Reading it yielded undefined and silently discarded
      // the field-level validation messages the API had actually returned.
      const details = error?.details;
      let errorMessage = 'An error occurred while saving the product';

      if (Array.isArray(details) && details.length > 0) {
        errorMessage = details
          .map((d: any) => (d?.field ? `${d.field}: ${d.message}` : d?.message))
          .filter(Boolean)
          .join('; ');
      } else if (error?.message) {
        errorMessage = error.message;
      }

      setError(errorMessage);
      toast.error(errorMessage);
      console.error("Error saving product:", error);
    } finally {
      setIsSaving(false);
    }
  };

  // Render modal version
  const modalDialogRef = useRef<HTMLDivElement>(null);
  const categoryDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(modalDialogRef, Boolean(isModal && onClose));
  useDialogFocus(categoryDialogRef, showCategoryModal);

  if (isModal && onClose) {
    return (
      <div
        ref={modalDialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-product-title"
        className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4 overflow-y-auto"
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-em-bg-surface rounded-xl max-w-4xl w-full my-4 md:my-8 max-h-[90vh] overflow-y-auto">
          <div className="p-4 md:p-8">
            {/* Modal Header */}
            <div className="flex justify-between items-start mb-6 md:mb-8">
              <div>
                <h1 id="add-product-title" className="text-2xl md:text-3xl font-bold text-em-text-primary">{editMode ? t('products.form.editTitle') : t('products.form.addTitle')}</h1>
                <p className="text-em-text-secondary mt-1 text-sm md:text-base">{editMode ? t('products.form.editSubtitle') : t('products.form.addSubtitle')}</p>
              </div>
              <button
                onClick={onClose}
                className="text-em-text-secondary hover:text-em-text-primary p-2"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Error Alert */}
            {error && (
              <div role="alert" className="mb-6 bg-em-danger-100 border border-em-danger-700/20 text-em-danger-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {/* Form Content Grid - Simplified for modal */}
            <div className="grid grid-cols-1 gap-6 max-w-full">
              {/* Product Info Section */}
              <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
                <h2 className="text-lg font-semibold text-em-text-primary mb-4">{t('products.form.productInfo')}</h2>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="modal-product-name" className="block text-sm font-medium text-em-text-primary mb-2">{t('products.form.productName')}</label>
                    <input
                      id="modal-product-name"
                      type="text"
                      value={productName}
                      onChange={(e) => setProductName(e.target.value)}
                      placeholder={t('products.form.productNamePlaceholder')}
                      className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                    />
                  </div>
                  <div>
                    <label htmlFor="modal-description" className="block text-sm font-medium text-em-text-primary mb-2">{t('common.description')}</label>
                    <textarea
                      id="modal-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t('products.form.descriptionPlaceholder')}
                      rows={4}
                      className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="modal-base-price" className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.detail.sellingPrice')} <span className="text-em-danger-700">*</span>
                      </label>
                      <input
                        id="modal-base-price"
                        type="number"
                        value={basePrice}
                        onChange={(e) => setBasePrice(e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      />
                    </div>
                    <div>
                      <label htmlFor="modal-sku" className="block text-sm font-medium text-em-text-primary mb-2">{t('products.detail.sku')}</label>
                      <input
                        id="modal-sku"
                        type="text"
                        value={sku}
                        onChange={(e) => setSku(e.target.value)}
                        placeholder="SKU-001"
                        className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex gap-3 mt-8 pt-8 border-t border-em-border">
              <button
                onClick={onClose}
                className="flex-1 px-6 py-3 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleSave("publish")}
                className="flex-1 px-6 py-3 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 font-medium"
              >
                {editMode ? t('products.form.updateProduct') : t('products.form.publish')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Full page view for standalone AddProduct route
  return (
    <div className="em-products min-h-full p-4 md:p-8 pb-24">
      {/* Page Header */}
      <div className="mb-6 md:mb-8">
        <button
          onClick={() => navigate("/products")}
          className="text-em-text-secondary hover:text-em-text-primary flex min-h-11 items-center gap-2 mb-4 text-sm"
        >
          ← {t('products.detail.backToProducts')}
        </button>
        <h1 className="text-2xl md:text-3xl font-bold text-em-text-primary">{isEditPage ? t('products.form.editTitle') : t('products.form.addTitle')}</h1>
        <p className="text-em-text-secondary mt-1 text-sm md:text-base">{isEditPage ? t('products.form.editSubtitle') : t('products.form.addSubtitle')}</p>
      </div>

      {/* Error Alert */}
      {error && (
        <div role="alert" className="mb-6 bg-em-danger-100 border border-em-danger-700/20 text-em-danger-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-7xl">
        
        {/* LEFT COLUMN */}
        <div className="space-y-6">
          
          {/* Product Info */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h2 className="text-lg font-semibold text-em-text-primary mb-4">
              {t('products.form.productInfo')} <span className="text-em-danger-700">*</span>
            </h2>
            
            <div className="space-y-4">
              <div>
                <label htmlFor="product-name" className="block text-sm font-medium text-em-text-primary mb-2">
                  {t('products.form.productName')} <span className="text-em-danger-700">*</span>
                </label>
                <input
                  id="product-name"
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder={t('products.form.productNamePlaceholder')}
                  className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-em-text-primary mb-2">
                  {t('common.description')} <span className="text-em-danger-700">*</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('products.form.descriptionFullPlaceholder')}
                  rows={6}
                  className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                />
              </div>

              {/* Pricing */}
              <div className="pt-4 border-t border-em-border">
                <h3 className="text-sm font-semibold text-em-text-primary mb-3">{t('products.detail.pricing')}</h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="selling-price" className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.detail.sellingPrice')} <span className="text-em-danger-700">*</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-em-text-secondary">$</span>
                        <input
                          id="selling-price"
                          type="number"
                          value={basePrice}
                          onChange={(e) => setBasePrice(e.target.value)}
                          placeholder="0.00"
                          step="0.01"
                          min="0"
                          className="min-h-11 w-full pl-8 pr-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pt-2">
                    <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={discountable}
                        onChange={(e) => setDiscountable(e.target.checked)}
                        className="w-4 h-4 text-em-info-700 rounded"
                      />
                      <span className="text-sm text-em-text-primary">{t('products.form.allowDiscounts')}</span>
                    </label>
                    <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={taxable}
                        onChange={(e) => setTaxable(e.target.checked)}
                        className="w-4 h-4 text-em-info-700 rounded"
                      />
                      <span className="text-sm text-em-text-primary">{t('products.form.chargeTax')}</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Media */}
              <div className="pt-4 border-t border-em-border">
                <h3 className="text-sm font-semibold text-em-text-primary mb-3">
                  {t('products.detail.images')} <span className="text-em-danger-700">*</span>
                </h3>
                
                <div className="space-y-3">
                  <div className="border-2 border-dashed border-em-border-strong rounded-lg p-6 text-center">
                    <Upload className="w-8 h-8 text-em-text-secondary mx-auto mb-2" />
                    <p className="text-sm font-medium text-em-text-primary mb-1">
                      {t('products.form.uploadImages')}
                    </p>
                    <p className="text-xs text-em-text-secondary mb-3">
                      {totalImages}/{VALIDATION.MAX_IMAGES} images • PNG, JPG up to 5MB each
                    </p>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="hidden"
                      id="product-images"
                      disabled={imagesFull}
                    />
                    <label
                      htmlFor="product-images"
                      className={`inline-block px-4 py-2 rounded-lg cursor-pointer text-sm ${
                        imagesFull
                          ? 'bg-em-border-strong text-em-text-secondary cursor-not-allowed'
                          : 'bg-em-violet-600 text-white hover:bg-em-violet-700'
                      }`}
                    >
                      {imagesFull ? t('products.form.maxImagesReached') : t('products.form.chooseFiles')}
                    </label>
                  </div>

                  {existingImageUrls.length > 0 && (
                    <div className="grid grid-cols-5 gap-2">
                      {existingImageUrls.map((url, index) => (
                        <div key={url} className="relative group">
                          <div className="aspect-square bg-em-bg-muted rounded-lg overflow-hidden border-2 border-em-border">
                            <img src={url} alt={`Product ${index + 1}`} className="w-full h-full object-cover" />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeExistingImage(index)}
                            className="absolute -top-2 -right-2 p-1 bg-em-danger-700 text-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {index === 0 && (
                            <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-em-violet-600 text-white text-xs rounded">
                              Main
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {productImages.length > 0 && (
                    <div className="grid grid-cols-5 gap-2">
                      {productImages.map((file, index) => (
                        <div key={index} className="relative group">
                          <div className="aspect-square bg-em-bg-muted rounded-lg overflow-hidden border-2 border-em-border hover:border-em-violet-400 transition-colors">
                            <img
                              src={imageObjectUrls[index]}
                              alt={`Product ${index + 1}`}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          {!uploadedImageUrls.has(file) && (
                            <div className="absolute inset-0 flex items-center justify-center bg-em-bg-surface/70 rounded-lg">
                              <Loader2 className="w-5 h-5 animate-spin text-em-info-700" />
                            </div>
                          )}
                          <button
                            onClick={() => removeImage(index)}
                            className="absolute -top-2 -right-2 p-1 bg-em-danger-700 text-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {index === 0 && existingImageUrls.length === 0 && (
                            <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-em-violet-600 text-white text-xs rounded">
                              Main
                            </div>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black bg-opacity-40 rounded-lg">
                            {index > 0 && (
                              <button
                                onClick={() => moveImage(index, "left")}
                                className="p-1.5 bg-em-bg-surface text-em-text-primary rounded-full mr-1 hover:bg-em-bg-muted"
                                title="Move left"
                              >
                                ←
                              </button>
                            )}
                            {index < productImages.length - 1 && (
                              <button
                                onClick={() => moveImage(index, "right")}
                                className="p-1.5 bg-em-bg-surface text-em-text-primary rounded-full hover:bg-em-bg-muted"
                                title="Move right"
                              >
                                →
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Inventory & Stock */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h2 className="text-lg font-semibold text-em-text-primary mb-4">
              {t('products.form.inventoryStock')} <span className="text-em-danger-700">*</span>
            </h2>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    {t('products.detail.sku')} <span className="text-em-danger-700">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                      placeholder={t('products.detail.sku')}
                      className="flex-1 px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                    />
                    <button
                      onClick={generateSku}
                      className="min-h-11 px-3 py-2 bg-em-bg-muted text-em-text-primary rounded-lg hover:bg-em-bg-muted whitespace-nowrap text-sm"
                    >
                      Auto
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-em-text-primary mb-2">
                  {t('products.form.stockTracking')} <span className="text-em-danger-700">*</span>
                </label>
                <div className="flex gap-4">
                  <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stockType"
                      value="unlimited"
                      checked={stockType === "unlimited"}
                      onChange={(e) => setStockType(e.target.value as "unlimited")}
                      className="w-4 h-4 text-em-info-700"
                    />
                    <span className="text-sm text-em-text-primary">{t('products.form.dontTrackInventory')}</span>
                  </label>
                  <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stockType"
                      value="limited"
                      checked={stockType === "limited"}
                      onChange={(e) => setStockType(e.target.value as "limited")}
                      className="w-4 h-4 text-em-info-700"
                    />
                    <span className="text-sm text-em-text-primary">{t('products.form.trackQuantity')}</span>
                  </label>
                </div>
              </div>

              {stockType === "limited" && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-em-text-primary mb-2">
                      {t('products.form.availableQuantity')} <span className="text-em-danger-700">*</span>
                    </label>
                    <input
                      type="number"
                      value={stockQuantity}
                      onChange={(e) => setStockQuantity(e.target.value)}
                      placeholder="0"
                      min="0"
                      className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-em-text-primary mb-2">
                      {t('products.form.lowStockThreshold')}
                    </label>
                    <input
                      type="number"
                      value={minStockThreshold}
                      onChange={(e) => setMinStockThreshold(e.target.value)}
                      placeholder="5"
                      min="0"
                      className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                    />
                    <p className="text-xs text-em-text-secondary mt-1">{t('products.form.lowStockNotify')}</p>
                  </div>

                  <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={lowStockAlert}
                      onChange={(e) => setLowStockAlert(e.target.checked)}
                      className="w-4 h-4 text-em-info-700 rounded"
                    />
                    <span className="text-sm text-em-text-primary">{t('products.form.sendLowStockAlerts')}</span>
                  </label>
                </>
              )}
            </div>
          </div>

          {/* Additional Product Details */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-hidden">
            <button
              onClick={() => setShowAdditionalDetails(!showAdditionalDetails)}
              aria-expanded={showAdditionalDetails}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-em-bg-muted transition-colors"
            >
              <h2 className="text-lg font-semibold text-em-text-primary">{t('products.form.additionalDetails')}</h2>
              {showAdditionalDetails ? (
                <ChevronUp className="w-5 h-5 text-em-text-secondary" />
              ) : (
                <ChevronDown className="w-5 h-5 text-em-text-secondary" />
              )}
            </button>
            
            {showAdditionalDetails && (
              <div className="px-6 pb-6 space-y-4 border-t border-em-border pt-4">
                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    {t('products.form.brandManufacturer')}
                  </label>
                  <input
                    type="text"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder={t('products.form.brandPlaceholder')}
                    className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    {t('products.form.productCondition')}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["new", "used", "refurbished"] as const).map((condition) => (
                      <button
                        key={condition}
                        onClick={() => setProductCondition(condition)}
                        className={`px-4 py-2 rounded-lg border-2 transition-all capitalize ${
                          productCondition === condition
                            ? "border-em-violet-600 bg-em-info-100 text-em-info-700"
                            : "border-em-border hover:border-em-border-strong"
                        }`}
                      >
                        {condition}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    <Tag className="w-4 h-4 inline mr-1" />
                    {t('products.detail.tags')}
                  </label>
                  <div className="space-y-2">
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {tags.map((tag, index) => (
                          <span
                            key={index}
                            className="inline-flex items-center gap-1 px-3 py-1 bg-em-info-100 text-em-info-700 rounded-full text-sm"
                          >
                            {tag}
                            <button
                              onClick={() => removeTag(tag)}
                              className="hover:text-em-violet-700"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                        placeholder={t('products.form.addTagPlaceholder')}
                        className="flex-1 px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      />
                      <button
                        onClick={addTag}
                        className="px-4 py-2 bg-em-bg-muted text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                      >
                        {t('products.form.addTag')}
                      </button>
                    </div>
                    <p className="text-xs text-em-text-secondary">{t('products.form.tagsHelp')}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN */}
        <div className="space-y-6">

          {/* Product Categories */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-hidden">
            <button
              onClick={() => setShowCategories(!showCategories)}
              aria-expanded={showCategories}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-em-bg-muted transition-colors"
            >
              <h2 className="text-lg font-semibold text-em-text-primary">{t('products.form.productCategories')}</h2>
              {showCategories ? (
                <ChevronUp className="w-5 h-5 text-em-text-secondary" />
              ) : (
                <ChevronDown className="w-5 h-5 text-em-text-secondary" />
              )}
            </button>
            
            {showCategories && (
              <div className="px-6 pb-6 space-y-4 border-t border-em-border pt-4">
                <p className="text-sm text-em-text-secondary">{t('products.form.categoriesHelp')}</p>
                
                {selectedCategories.length > 0 && (
                  <div className="flex flex-wrap gap-2 p-3 bg-em-bg-muted rounded-lg">
                    {selectedCategories.map((catId) => {
                      const category = categories.find(c => c.id === catId);
                      return category ? (
                        <span
                          key={catId}
                          className="inline-flex items-center gap-2 px-3 py-1.5 bg-em-violet-600 text-white rounded-lg text-sm"
                        >
                          <FolderTree className="w-3 h-3" />
                          {category.name}
                          <button
                            onClick={() => setSelectedCategories(selectedCategories.filter(id => id !== catId))}
                            className="hover:text-em-violet-100"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ) : null;
                    })}
                  </div>
                )}

                <button
                  onClick={() => setShowCategoryModal(true)}
                  className="w-full px-4 py-3 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 transition-colors flex items-center justify-center gap-2"
                >
                  <FolderTree className="w-5 h-5" />
                  {t('products.form.assignCategories')}
                </button>
              </div>
            )}
          </div>

          {/* Product Variants */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-hidden">
            <button
              onClick={() => setShowVariants(!showVariants)}
              aria-expanded={showVariants}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-em-bg-muted transition-colors"
            >
              <h2 className="text-lg font-semibold text-em-text-primary">{t('products.form.productVariants')}</h2>
              {showVariants ? (
                <ChevronUp className="w-5 h-5 text-em-text-secondary" />
              ) : (
                <ChevronDown className="w-5 h-5 text-em-text-secondary" />
              )}
            </button>
            
            {showVariants && (
              <div className="px-6 pb-6 space-y-4 border-t border-em-border pt-4">
                <p className="text-sm text-em-text-secondary">{t('products.form.variantsHelp')}</p>
                {variants.map((variant, index) => (
                  <div key={index} className="p-4 border border-em-border rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-em-text-primary">{t('products.form.variantGroup', { index: index + 1 })}</span>
                      <button
                        onClick={() => removeVariant(index)}
                        className="text-em-danger-700 hover:text-em-danger-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.form.variantName')}
                      </label>
                      <input
                        type="text"
                        value={variant.name}
                        onChange={(e) => updateVariant(index, "name", e.target.value)}
                        placeholder="e.g., Size, Color, Material"
                        className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.form.variantOptions')}
                      </label>
                      <div className="space-y-2 mb-3">
                        {Array.isArray(variant.options) && variant.options.length > 0 ? (
                          variant.options.map((option, optionIndex) => (
                            <div key={optionIndex} className="flex gap-2">
                              <input
                                type="text"
                                value={option}
                                onChange={(e) => {
                                  const newOptions = [...variant.options];
                                  newOptions[optionIndex] = e.target.value;
                                  const updated = variants.map((v, i) => 
                                    i === index 
                                      ? { ...v, options: newOptions }
                                      : v
                                  );
                                  setVariants(updated);
                                }}
                                placeholder="e.g., Small"
                                className="flex-1 px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                              />
                              <button
                                onClick={() => {
                                  const newOptions = variant.options.filter((_, i) => i !== optionIndex);
                                  const updated = variants.map((v, i) => 
                                    i === index 
                                      ? { ...v, options: newOptions }
                                      : v
                                  );
                                  setVariants(updated);
                                }}
                                className="px-3 py-2 text-em-danger-700 hover:bg-em-danger-100 rounded-lg border border-em-danger-700/30"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-em-text-secondary italic">{t('products.form.noOptionsYet')}</p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          const updated = variants.map((v, i) => 
                            i === index 
                              ? { ...v, options: [...(Array.isArray(v.options) ? v.options : []), ""] }
                              : v
                          );
                          setVariants(updated);
                        }}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-em-info-100 text-em-info-700 rounded-lg hover:bg-em-info-100 border border-em-info-700/20"
                      >
                        <Plus className="w-4 h-4" />
                        {t('products.form.addOption')}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-em-text-primary mb-2">
                          {t('products.form.priceAdjustment')}
                        </label>
                        <div className="relative">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-em-text-secondary">$</span>
                          <input
                            type="number"
                            value={variant.priceAdjustment}
                            onChange={(e) => updateVariant(index, "priceAdjustment", e.target.value)}
                            placeholder="0.00"
                            step="0.01"
                            className="min-h-11 w-full pl-8 pr-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-em-text-primary mb-2">
                          {t('products.form.variantSku')}
                        </label>
                        <input
                          type="text"
                          value={variant.sku}
                          onChange={(e) => updateVariant(index, "sku", e.target.value)}
                          placeholder="Optional"
                          className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <button
                  onClick={addVariant}
                  className="w-full px-4 py-2 border-2 border-dashed border-em-border-strong rounded-lg text-em-text-secondary hover:border-em-border-strong hover:text-em-text-primary transition-colors flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  {t('products.form.addVariantGroup')}
                </button>
              </div>
            )}
          </div>

          {/* Business Rules */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-hidden">
            <button
              onClick={() => setShowBusinessRules(!showBusinessRules)}
              aria-expanded={showBusinessRules}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-em-bg-muted transition-colors"
            >
              <h2 className="text-lg font-semibold text-em-text-primary">{t('products.form.businessRules')}</h2>
              {showBusinessRules ? (
                <ChevronUp className="w-5 h-5 text-em-text-secondary" />
              ) : (
                <ChevronDown className="w-5 h-5 text-em-text-secondary" />
              )}
            </button>
            
            {showBusinessRules && (
              <div className="px-6 pb-6 space-y-4 border-t border-em-border pt-4">
                {/*
                  Phase 1 P03/D1: the min/max order-quantity and return-policy
                  controls that used to live here were removed, not renamed.
                  The save payload (handleSubmit above) never carried them and
                  the product API has no columns for them, so a merchant who
                  picked "Non-returnable" and clicked Publish saw a success
                  toast while the selection was silently discarded. Do not
                  re-add a control here unless the value is actually persisted
                  end-to-end (payload, validator, column, read path).
                */}
                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    {t('products.form.warrantyInfo')}
                  </label>
                  <input
                    type="text"
                    value={warranty}
                    onChange={(e) => setWarranty(e.target.value)}
                    placeholder={t('products.form.warrantyPlaceholder')}
                    className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-em-text-primary mb-2">
                    {t('products.form.expiryDate')}
                  </label>
                  <input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                  />
                  <p className="text-xs text-em-text-secondary mt-1">{t('products.form.expiryHelp')}</p>
                </div>
              </div>
            )}
          </div>

          {/* Shipping & Delivery */}
          <div className="bg-em-bg-surface rounded-xl border border-em-border overflow-hidden">
            <button
              onClick={() => setShowShipping(!showShipping)}
              aria-expanded={showShipping}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-em-bg-muted transition-colors"
            >
              <h2 className="text-lg font-semibold text-em-text-primary">{t('products.form.shippingDelivery')}</h2>
              {showShipping ? (
                <ChevronUp className="w-5 h-5 text-em-text-secondary" />
              ) : (
                <ChevronDown className="w-5 h-5 text-em-text-secondary" />
              )}
            </button>
            
            {showShipping && (
              <div className="px-6 pb-6 space-y-4 border-t border-em-border pt-4">
                <div className="flex items-center justify-between p-4 bg-em-bg-muted rounded-lg">
                  <div>
                    <div className="font-medium text-em-text-primary">{t('products.form.physicalProduct')}</div>
                    <div className="text-sm text-em-text-secondary">{t('products.form.requiresShipping')}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={requiresShipping}
                    aria-label={t('products.form.physicalProduct')}
                    onClick={() => setRequiresShipping(!requiresShipping)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      requiresShipping ? "bg-em-violet-600" : "bg-em-border-strong"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-em-bg-surface transition-transform ${
                        requiresShipping ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                {requiresShipping && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-3">
                        {t('products.form.packageWeight')}
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          type="number"
                          value={weight}
                          onChange={(e) => setWeight(e.target.value)}
                          placeholder="0"
                          step="0.01"
                          min="0"
                          className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                        <select
                          value={weightUnit}
                          onChange={(e) => setWeightUnit(e.target.value as any)}
                          className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        >
                          <option value="kg">Kilograms (kg)</option>
                          <option value="g">Grams (g)</option>
                          <option value="lb">Pounds (lb)</option>
                          <option value="oz">Ounces (oz)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-3">
                        {t('products.form.packageDimensions')}
                      </label>
                      <div className="grid grid-cols-4 gap-2">
                        <input
                          type="number"
                          value={dimensions.length}
                          onChange={(e) => setDimensions({ ...dimensions, length: e.target.value })}
                          placeholder="L"
                          step="0.1"
                          min="0"
                          className="px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                        <input
                          type="number"
                          value={dimensions.width}
                          onChange={(e) => setDimensions({ ...dimensions, width: e.target.value })}
                          placeholder="W"
                          step="0.1"
                          min="0"
                          className="px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                        <input
                          type="number"
                          value={dimensions.height}
                          onChange={(e) => setDimensions({ ...dimensions, height: e.target.value })}
                          placeholder="H"
                          step="0.1"
                          min="0"
                          className="px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        />
                        <select
                          value={dimensionUnit}
                          onChange={(e) => setDimensionUnit(e.target.value as any)}
                          className="px-3 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                        >
                          <option value="cm">cm</option>
                          <option value="in">in</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.form.shippingClass')}
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {(["standard", "express", "fragile"] as const).map((cls) => (
                          <button
                            key={cls}
                            onClick={() => setShippingClass(cls)}
                            className={`px-3 py-2 rounded-lg border-2 transition-all capitalize text-sm ${
                              shippingClass === cls
                                ? "border-em-violet-600 bg-em-info-100 text-em-info-700"
                                : "border-em-border hover:border-em-border-strong"
                            }`}
                          >
                            {cls}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-em-text-primary mb-2">
                        {t('products.form.handlingTime')}
                      </label>
                      <input
                        type="text"
                        value={handlingTime}
                        onChange={(e) => setHandlingTime(e.target.value)}
                        placeholder={t('products.form.handlingTimePlaceholder')}
                        className="min-h-11 w-full px-4 py-2 border border-em-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                      />
                      <p className="text-xs text-em-text-secondary mt-1">{t('products.form.handlingTimeHelp')}</p>
                    </div>

                    <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={freeShipping}
                        onChange={(e) => setFreeShipping(e.target.checked)}
                        className="w-4 h-4 text-em-info-700 rounded"
                      />
                      <span className="text-sm text-em-text-primary">{t('products.form.freeShipping')}</span>
                    </label>
                  </>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* FOOTER ACTIONS - Sticky */}
      {/* The sidebar offset only exists from `md` up (DashboardLayout uses
          md:ml-64), so anchoring at left-64 on every width squeezed these
          actions into ~100px on a 360px phone and pushed them off-screen. */}
      <div className="fixed bottom-16 md:bottom-0 left-0 md:left-[var(--shell-sidebar-w,16rem)] right-0 bg-em-bg-surface border-t border-em-border px-4 md:px-8 py-4 flex justify-end gap-3 z-10">
        <button
          onClick={() => navigate('/products')}
          disabled={isSaving}
          className="px-6 py-3 min-h-11 border border-em-border-strong bg-em-bg-surface text-em-text-primary rounded-lg hover:bg-em-bg-muted transition-colors disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => handleSave("publish")}
          disabled={isSaving}
          className="px-6 py-3 min-h-11 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSaving
            ? <Loader2 className="w-5 h-5 animate-spin" />
            : <Package className="w-5 h-5" />}
          {isSaving
            ? t('common.saving', 'Saving...')
            : (isEditPage ? t('products.form.updateProduct') : t('products.form.publish'))}
        </button>
      </div>

      {/* Category Selection Modal */}
      {showCategoryModal && (
        <div
          ref={categoryDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="category-modal-title"
          className="fixed inset-0 bg-em-midnight-950/60 z-50 flex items-center justify-center p-4"
          onKeyDown={(e) => { if (e.key === 'Escape') setShowCategoryModal(false); }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowCategoryModal(false); }}
        >
          <div className="bg-em-bg-surface rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-em-border flex items-center justify-between">
              <h3 id="category-modal-title" className="text-lg font-bold text-em-text-primary">{t('products.form.selectCategories')}</h3>
              <button
                onClick={() => setShowCategoryModal(false)}
                aria-label={t('common.close')}
                className="p-2 hover:bg-em-bg-muted rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <p className="text-sm text-em-text-secondary mb-4">
                {t('products.form.selectCategoriesHelp')}
              </p>

              {categoriesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-em-info-700" />
                  <span className="ml-2 text-em-text-secondary">{t('products.form.loadingCategories')}</span>
                </div>
              ) : categories.length === 0 ? (
                <div className="text-center py-8 text-em-text-secondary">
                  {t('products.form.noCategoriesAvailable')}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {categories.map((category) => {
                    const isSelected = selectedCategories.includes(category.id);
                    return (
                      <button
                        key={category.id}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedCategories(selectedCategories.filter(id => id !== category.id));
                          } else {
                            setSelectedCategories([...selectedCategories, category.id]);
                          }
                        }}
                        className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all text-left ${ 
                          isSelected
                            ? "border-em-violet-600 bg-em-info-100"
                            : "border-em-border hover:border-em-border-strong bg-em-bg-surface"
                        }`}
                      >
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          isSelected ? "bg-em-violet-600 text-white" : "bg-em-bg-muted text-em-text-secondary"
                        }`}>
                          <FolderTree className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`font-medium truncate ${
                            isSelected ? "text-em-violet-700" : "text-em-text-primary"
                          }`}>
                            {category.name}
                          </div>
                        </div>
                      {isSelected && (
                        <div className="flex-shrink-0">
                          <div className="w-5 h-5 bg-em-violet-600 rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          </div>
                        </div>
                      )}
                    </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-6 p-4 bg-em-bg-muted rounded-lg border border-em-border">
                <p className="text-sm text-em-text-primary mb-3 flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  {t('products.form.needNewCategory')}
                </p>
                <button
                  onClick={() => {
                    setShowCategoryModal(false);
                    navigate("/categories/create");
                  }}
                  className="w-full px-4 py-2 bg-em-bg-surface border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted transition-colors"
                >
                  {t('products.form.createNewCategory')}
                </button>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-em-border flex items-center justify-between">
              <div className="text-sm text-em-text-secondary">
                {t('products.form.categoriesSelected', { count: selectedCategories.length })}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowCategoryModal(false)}
                  className="px-4 py-2 border border-em-border-strong text-em-text-primary rounded-lg hover:bg-em-bg-muted"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => setShowCategoryModal(false)}
                  className="px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700"
                >
                  {t('products.form.applySelection')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
