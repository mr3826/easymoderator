import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ImagePlus, Loader2, Plus, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import type { Category, Product } from "@/api/types/product";
import { VALIDATION } from "../constants/product";
import { getErrorMessage } from "@shared/lib/http/errors";
import { downscaleImage } from "../lib/downscaleImage";
import { useDialogFocus } from "./inbox/useDialogFocus";
import {
  ProductFormFieldView,
  ProductSelect,
  ProductTextArea,
  ProductTextInput,
} from "./ProductFormFields";
import {
  createIdempotencyKey,
  normalizeProduct,
  toCreatePayload,
  toPatch,
  validateProductDraft,
  validateProductField,
  type ProductDraft,
  type ProductFieldErrors,
  type ProductFormField,
} from "./products/productForm";

type ImageEntry = {
  id: string;
  url?: string;
  previewUrl?: string;
  file?: File;
  status: "uploaded" | "uploading" | "error";
  error?: string;
};

type CategoryNode = {
  id?: string;
  name: string;
  is_active?: boolean;
  parent_id?: string | null;
  parent_category_id?: string | null;
  subcategories?: CategoryNode[];
};

type CategoryOption = { id: string; label: string };
type VariantGroup = { name: string; options: string[]; priceAdjustment?: unknown; sku?: string };

const FORM_FIELDS: ProductFormField[] = [
  "name", "price", "description", "category_id", "sku", "brand", "tags", "variants",
  "track_quantity", "quantity", "low_stock_threshold", "weight", "weight_unit", "is_active", "images",
];

const VALIDATION_FOCUS_IDS: Partial<Record<ProductFormField, string>> = {
  name: "product-name",
  price: "product-price",
  quantity: "product-quantity",
  low_stock_threshold: "product-low-stock-threshold",
  weight: "product-weight",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asVariantGroup(value: unknown): VariantGroup {
  const group = isRecord(value) ? value : {};
  return {
    name: typeof group.name === "string" ? group.name : "",
    options: Array.isArray(group.options)
      ? group.options.filter((option): option is string => typeof option === "string")
      : [],
    priceAdjustment: group.priceAdjustment ?? 0,
    sku: typeof group.sku === "string" ? group.sku : "",
  };
}

function getCategoryParentId(category: CategoryNode): string | null {
  return category.parent_id ?? category.parent_category_id ?? null;
}

function flattenCategories(categories: Category[], inactiveLabel: string): CategoryOption[] {
  const rows: CategoryOption[] = [];
  const visited = new Set<string>();

  const visit = (category: CategoryNode, ancestors: string[]) => {
    if (!category.id || visited.has(category.id)) return;
    visited.add(category.id);
    const label = category.is_active === false ? `${category.name} (${inactiveLabel})` : category.name;
    const path = [...ancestors, label];
    rows.push({ id: category.id, label: path.join(" / ") });

    const nested = category.subcategories ?? [];
    const flatChildren = categories.filter((candidate) => getCategoryParentId(candidate) === category.id);
    [...nested, ...flatChildren].forEach((child) => visit(child, path));
  };

  const categoryIds = new Set(categories.map((category) => category.id));
  categories
    .filter((category) => {
      const parentId = getCategoryParentId(category);
      return !parentId || !categoryIds.has(parentId);
    })
    .forEach((category) => visit(category, []));
  categories.forEach((category) => visit(category, []));
  const labelCounts = new Map<string, number>();
  rows.forEach(({ label }) => labelCounts.set(label.toLowerCase(), (labelCounts.get(label.toLowerCase()) ?? 0) + 1));
  return rows.map((row) => labelCounts.get(row.label.toLowerCase())! > 1
    ? { ...row, label: `${row.label} · ${row.id.slice(0, 6)}` }
    : row);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function makeImageEntries(urls: string[]): ImageEntry[] {
  return urls.map((url, index) => ({ id: `saved-${index}-${url}`, url, status: "uploaded" }));
}

export default function AddProduct() {
  const { t } = useTranslation();
  const inactiveCategoryLabel = t("products.form.inactiveCategory");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { productId } = useParams<{ productId?: string }>();
  const isEditMode = Boolean(productId);

  const [draft, setDraft] = useState<ProductDraft>(() => normalizeProduct(null));
  const baselineRef = useRef<ProductDraft>(normalizeProduct(null));
  const [editorReady, setEditorReady] = useState(!isEditMode);
  const [touched, setTouched] = useState<Partial<Record<ProductFormField, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<ProductFieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const savedRef = useRef(false);
  const initializedProductIdRef = useRef<string | null>(null);
  const [showAdditionalSettings, setShowAdditionalSettings] = useState(false);
  const [newTag, setNewTag] = useState("");

  const [imageEntries, setImageEntries] = useState<ImageEntry[]>([]);
  const imageEntriesRef = useRef<ImageEntry[]>([]);
  const uploadCountRef = useRef(0);
  const uploadingIdsRef = useRef(new Set<string>());
  const previewUrlsRef = useRef(new Set<string>());
  const [uploadingCount, setUploadingCount] = useState(0);
  const [imageSequence, setImageSequence] = useState(0);

  const productQuery = useQuery<Product>({
    queryKey: ["product", productId],
    queryFn: () => apiClient.getProduct(productId!),
    enabled: isEditMode,
    refetchOnMount: "always",
    retry: 1,
  });
  const categoryQuery = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiClient.getCategories({ include_inactive: true }),
    retry: 1,
  });

  const categoryOptions = useMemo(
    () => flattenCategories(categoryQuery.data ?? [], inactiveCategoryLabel),
    [categoryQuery.data, inactiveCategoryLabel],
  );
  const relationalVariants = productQuery.data?.product_variants ?? [];
  const variantsAreRelational = relationalVariants.length > 0;
  const hasLegacyVariantStrings = draft.variants.some((variant) => typeof variant === "string");
  const variantsAreEditable = !variantsAreRelational && !hasLegacyVariantStrings;

  useEffect(() => {
    savedRef.current = false;
    initializedProductIdRef.current = null;
    setSaveError(null);
    setTouched({});
    setFieldErrors({});
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
    imageEntriesRef.current = [];
    setImageEntries([]);

    if (!productId) {
      const emptyDraft = normalizeProduct(null);
      baselineRef.current = emptyDraft;
      setDraft(emptyDraft);
      setEditorReady(true);
      return;
    }

    setEditorReady(false);
  }, [productId]);

  useEffect(() => {
    const product = productQuery.data;
    if (
      !productId
      || !product
      || product.id !== productId
      || !productQuery.isFetchedAfterMount
      || !productQuery.isSuccess
      || productQuery.isFetching
      || initializedProductIdRef.current === productId
    ) return;

    const normalized = normalizeProduct(product);
    baselineRef.current = normalized;
    setDraft(normalized);
    const entries = makeImageEntries(normalized.images);
    imageEntriesRef.current = entries;
    setImageEntries(entries);
    initializedProductIdRef.current = productId;
    setEditorReady(true);
    setTouched({});
    setFieldErrors({});
    setSaveError(null);
  }, [productId, productQuery.data, productQuery.isFetchedAfterMount, productQuery.isFetching, productQuery.isSuccess]);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);

  const dirtyFields = useMemo(() => {
    const dirty = FORM_FIELDS.filter((field) => !valuesEqual(draft[field], baselineRef.current[field]));
    const imageSnapshot = imageEntries.map((entry) =>
      entry.status === "uploaded" && entry.url ? entry.url : `pending:${entry.id}`,
    );
    if (!valuesEqual(imageSnapshot, baselineRef.current.images) && !dirty.includes("images")) dirty.push("images");
    return dirty;
  }, [draft, imageEntries]);
  const hasUnsavedChanges = editorReady && (dirtyFields.length > 0 || uploadingCount > 0);
  const blocker = useBlocker(() => hasUnsavedChanges && !savedRef.current);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(discardDialogRef, blocker.state === "blocked");

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (savedRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [hasUnsavedChanges]);

  const updateField = <Field extends ProductFormField>(field: Field, value: ProductDraft[Field]) => {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);
    if (touched[field]) {
      setFieldErrors((current) => ({ ...current, [field]: validateProductField(field, nextDraft) }));
    }
    setSaveError(null);
  };

  const touchField = (field: ProductFormField) => {
    setTouched((current) => ({ ...current, [field]: true }));
    setFieldErrors((current) => ({ ...current, [field]: validateProductField(field, draft) }));
  };

  const applyImageEntries = (nextEntries: ImageEntry[]) => {
    imageEntriesRef.current = nextEntries;
    setImageEntries(nextEntries);
    const images = nextEntries.flatMap((entry) =>
      entry.status === "uploaded" && entry.url ? [entry.url] : [],
    );
    setDraft((current) => ({ ...current, images }));
    setSaveError(null);
  };

  const startUpload = async (entry: ImageEntry) => {
    if (!entry.file || uploadingIdsRef.current.has(entry.id)) return;
    uploadingIdsRef.current.add(entry.id);
    uploadCountRef.current += 1;
    setUploadingCount(uploadCountRef.current);
    applyImageEntries(imageEntriesRef.current.map((current) =>
      current.id === entry.id ? { ...current, status: "uploading", error: undefined } : current,
    ));

    try {
      const dataUrl = await downscaleImage(entry.file);
      const url = await apiClient.uploadProductImage(dataUrl);
      applyImageEntries(imageEntriesRef.current.map((current) =>
        current.id === entry.id ? { ...current, url, status: "uploaded", error: undefined } : current,
      ));
      if (entry.previewUrl) {
        URL.revokeObjectURL(entry.previewUrl);
        previewUrlsRef.current.delete(entry.previewUrl);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("products.form.imageUploadFailed"));
      applyImageEntries(imageEntriesRef.current.map((current) =>
        current.id === entry.id ? { ...current, status: "error", error: message } : current,
      ));
      toast.error(message);
    } finally {
      uploadingIdsRef.current.delete(entry.id);
      uploadCountRef.current = Math.max(0, uploadCountRef.current - 1);
      setUploadingCount(uploadCountRef.current);
    }
  };

  const handleImageSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    const availableSlots = Math.max(0, VALIDATION.MAX_IMAGES - imageEntriesRef.current.length);
    const files = selectedFiles.slice(0, availableSlots);
    event.currentTarget.value = "";
    if (selectedFiles.length > availableSlots) toast.error(t("products.form.maxImagesReached"));
    if (!files.length) return;

    const entries = files.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.add(previewUrl);
      return {
        id: `new-${Date.now()}-${imageSequence + Math.random()}-${file.name}`,
        previewUrl,
        file,
        status: "uploading" as const,
      };
    });
    setImageSequence((current) => current + entries.length);
    applyImageEntries([...imageEntriesRef.current, ...entries]);
    entries.forEach((entry) => void startUpload(entry));
  };

  const removeImage = (id: string) => {
    const entry = imageEntriesRef.current.find((image) => image.id === id);
    if (entry?.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
      previewUrlsRef.current.delete(entry.previewUrl);
    }
    applyImageEntries(imageEntriesRef.current.filter((image) => image.id !== id));
  };

  const moveImage = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    const entries = [...imageEntriesRef.current];
    if (nextIndex < 0 || nextIndex >= entries.length) return;
    [entries[index], entries[nextIndex]] = [entries[nextIndex], entries[index]];
    applyImageEntries(entries);
  };

  const clearImages = () => {
    imageEntriesRef.current.forEach((entry) => {
      if (entry.previewUrl) {
        URL.revokeObjectURL(entry.previewUrl);
        previewUrlsRef.current.delete(entry.previewUrl);
      }
    });
    applyImageEntries([]);
  };

  const updateVariantGroup = (index: number, changes: Partial<VariantGroup>) => {
    updateField("variants", draft.variants.map((variant, currentIndex) => {
      if (currentIndex !== index) return variant;
      return { ...(isRecord(variant) ? variant : {}), ...asVariantGroup(variant), ...changes };
    }));
  };

  const addVariantGroup = () => {
    updateField("variants", [...draft.variants, { name: "", options: [], priceAdjustment: 0, sku: "" }]);
  };

  const removeVariantGroup = (index: number) => {
    updateField("variants", draft.variants.filter((_, currentIndex) => currentIndex !== index));
  };

  const updateVariantOption = (groupIndex: number, optionIndex: number, value: string) => {
    const group = asVariantGroup(draft.variants[groupIndex]);
    const options = [...group.options];
    options[optionIndex] = value;
    updateVariantGroup(groupIndex, { options });
  };

  const addVariantOption = (groupIndex: number) => {
    const group = asVariantGroup(draft.variants[groupIndex]);
    updateVariantGroup(groupIndex, { options: [...group.options, ""] });
  };

  const removeVariantOption = (groupIndex: number, optionIndex: number) => {
    const group = asVariantGroup(draft.variants[groupIndex]);
    updateVariantGroup(groupIndex, { options: group.options.filter((_, index) => index !== optionIndex) });
  };

  const addTag = () => {
    const tag = newTag.trim();
    if (!tag || draft.tags.includes(tag)) return;
    updateField("tags", [...draft.tags, tag]);
    setNewTag("");
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveInFlightRef.current) return;
    if (uploadCountRef.current > 0) {
      setSaveError(t("products.form.imagesStillUploading"));
      return;
    }
    if (imageEntriesRef.current.some((entry) => entry.status === "error")) {
      setSaveError(t("products.form.resolveImageUploads"));
      return;
    }

    const errors = validateProductDraft(draft);
    if (isEditMode && !dirtyFields.includes("variants")) delete errors.variants;
    setTouched(Object.fromEntries(FORM_FIELDS.map((field) => [field, true])));
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSaveError(null);
      if (errors.weight) setShowAdditionalSettings(true);
      const firstInvalidField = FORM_FIELDS.find((field) => errors[field]);
      const invalidVariantIndex = errors.variants
        ? draft.variants.findIndex((variant) => isRecord(variant) && (typeof variant.name !== "string" || !variant.name.trim()))
        : -1;
      const inputId = firstInvalidField === "variants" && invalidVariantIndex >= 0
        ? `variant-${invalidVariantIndex}-name`
        : firstInvalidField
          ? VALIDATION_FOCUS_IDS[firstInvalidField]
          : undefined;
      if (inputId) requestAnimationFrame(() => document.getElementById(inputId)?.focus());
      return;
    }

    if (isEditMode && dirtyFields.length === 0) {
      savedRef.current = true;
      navigate("/products");
      return;
    }

    saveInFlightRef.current = true;
    setIsSaving(true);
    setSaveError(null);
    try {
      let savedProduct: Product;
      if (isEditMode) {
        savedProduct = await apiClient.updateProduct(productId!, toPatch(draft, dirtyFields));
      } else {
        const payload = toCreatePayload(draft);
        const fingerprint = JSON.stringify(payload);
        if (createRequestRef.current?.fingerprint !== fingerprint) {
          createRequestRef.current = { fingerprint, key: createIdempotencyKey() };
        }
        savedProduct = await apiClient.createProduct(payload, createRequestRef.current.key);
      }

      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["product", savedProduct.id] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
      ]);
      const savedDraft = normalizeProduct(savedProduct);
      baselineRef.current = savedDraft;
      setDraft(savedDraft);
      const savedImages = makeImageEntries(savedDraft.images);
      imageEntriesRef.current = savedImages;
      setImageEntries(savedImages);
      savedRef.current = true;
      createRequestRef.current = null;
      navigate(isEditMode ? `/products/${encodeURIComponent(savedProduct.id)}` : "/products");
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("products.form.saveFailed"));
      setSaveError(message);
      toast.error(message);
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  };

  const isValidating = isEditMode && !editorReady && !productQuery.isError;
  const productLoadError = isEditMode && productQuery.isError
    ? getErrorMessage(productQuery.error, t("products.detail.loadFailed"))
    : null;
  const imagesFailed = imageEntries.some((entry) => entry.status === "error");
  const saveDisabled = isSaving || !editorReady || uploadingCount > 0 || imagesFailed;

  return (
    <div className="em-products min-h-full px-4 py-5 pb-24 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <button
          type="button"
          onClick={() => navigate("/products")}
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm text-em-text-secondary hover:text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
        >
          <span aria-hidden="true">←</span>
          {t("products.detail.backToProducts")}
        </button>

        <header className="mb-6 md:mb-8">
          <h1 className="text-2xl font-bold text-em-text-primary md:text-3xl">
            {isEditMode ? t("products.form.editTitle") : t("products.form.addTitle")}
          </h1>
          <p className="mt-1 text-sm text-em-text-secondary md:text-base">
            {isEditMode ? t("products.form.editSubtitle") : t("products.form.addSubtitle")}
          </p>
        </header>

        {productLoadError && (
          <div className="mb-6 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-em-danger-700" role="alert">
            <p>{productLoadError}</p>
            <button
              type="button"
              onClick={() => void productQuery.refetch()}
              className="mt-2 min-h-11 rounded-lg border border-em-danger-700/30 px-3 text-sm font-medium hover:bg-em-danger-100"
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {saveError && (
          <div className="mb-6 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-em-danger-700" role="alert">
            {saveError}
          </div>
        )}

        {isValidating ? (
          <div className="flex min-h-48 items-center justify-center gap-3 text-em-text-secondary" role="status">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t("products.detail.loading")}
          </div>
        ) : (
          <form noValidate onSubmit={(event) => void submitForm(event)} className="space-y-5">
            <section aria-labelledby="product-essentials-title" className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-6">
              <h2 id="product-essentials-title" className="mb-5 text-lg font-semibold text-em-text-primary">
                {t("products.form.essentials")}
              </h2>
              <div className="grid gap-5 md:grid-cols-2">
                <ProductFormFieldView
                  id="product-name"
                  field="name"
                  label={t("products.form.productName")}
                  draft={draft}
                  touched={Boolean(touched.name)}
                  errors={fieldErrors}
                  required
                >
                  {({ error, describedBy }) => (
                    <ProductTextInput
                      id="product-name"
                      autoComplete="off"
                      required
                      value={draft.name}
                      placeholder={t("products.form.productNamePlaceholder")}
                      onChange={(event) => updateField("name", event.target.value)}
                      onBlur={() => touchField("name")}
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      disabled={!editorReady || isSaving}
                    />
                  )}
                </ProductFormFieldView>

                <ProductFormFieldView
                  id="product-price"
                  field="price"
                  label={t("products.detail.sellingPrice")}
                  draft={draft}
                  touched={Boolean(touched.price)}
                  errors={fieldErrors}
                  required
                  help={t("products.form.priceHelp")}
                >
                  {({ error, describedBy }) => (
                    <div className="relative">
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-medium text-em-text-secondary" aria-hidden="true">৳</span>
                      <ProductTextInput
                        id="product-price"
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        step="0.01"
                        required
                        value={draft.price}
                        onChange={(event) => updateField("price", event.target.value)}
                        onBlur={() => touchField("price")}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        disabled={!editorReady || isSaving}
                        className="pl-8"
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-em-text-secondary">BDT</span>
                    </div>
                  )}
                </ProductFormFieldView>

                <ProductFormFieldView
                  id="product-category"
                  field="category_id"
                  label={t("products.columns.category")}
                  draft={draft}
                  touched={Boolean(touched.category_id)}
                  errors={fieldErrors}
                  help={t("products.form.categoryHelp")}
                >
                  {({ error, describedBy }) => (
                    <div className="flex gap-2">
                      <ProductSelect
                        id="product-category"
                        value={draft.category_id}
                        onChange={(event) => updateField("category_id", event.target.value)}
                        onBlur={() => touchField("category_id")}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        disabled={!editorReady || isSaving || categoryQuery.isLoading}
                      >
                        <option value="">{t("products.form.noCategory")}</option>
                        {categoryOptions.map((category) => (
                          <option key={category.id} value={category.id}>{category.label}</option>
                        ))}
                      </ProductSelect>
                      {draft.category_id && (
                        <button
                          type="button"
                          onClick={() => updateField("category_id", "")}
                          disabled={isSaving}
                          className="min-h-11 shrink-0 rounded-lg border border-em-border-strong px-3 text-sm text-em-text-secondary hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-em-focus-light"
                        >
                          {t("common.clear")}
                        </button>
                      )}
                    </div>
                  )}
                </ProductFormFieldView>

                <div className="md:col-span-2">
                  <ProductFormFieldView
                    id="product-description"
                    field="description"
                    label={t("common.description")}
                    draft={draft}
                    touched={Boolean(touched.description)}
                    errors={fieldErrors}
                    help={t("products.form.descriptionHelp")}
                  >
                    {({ error, describedBy }) => (
                      <ProductTextArea
                        id="product-description"
                        rows={5}
                        value={draft.description}
                        placeholder={t("products.form.descriptionPlaceholder")}
                        onChange={(event) => updateField("description", event.target.value)}
                        onBlur={() => touchField("description")}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        disabled={!editorReady || isSaving}
                      />
                    )}
                  </ProductFormFieldView>
                </div>

                <div className="md:col-span-2">
                  <ProductFormFieldView
                    id="product-image-picker"
                    field="images"
                    label={t("products.detail.images")}
                    draft={draft}
                    touched={Boolean(touched.images)}
                    errors={fieldErrors}
                    help={t("products.form.imagesHelp")}
                  >
                    {({ describedBy }) => (
                      <div aria-describedby={describedBy}>
                        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-em-border-strong bg-em-bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-3">
                            <ImagePlus className="mt-0.5 h-5 w-5 shrink-0 text-em-violet-600" aria-hidden="true" />
                            <div>
                              <p className="text-sm font-medium text-em-text-primary">{t("products.form.uploadImages")}</p>
                              <p className="text-xs text-em-text-secondary">
                                {t("products.form.imageCount", { count: imageEntries.length, max: VALIDATION.MAX_IMAGES })}
                              </p>
                            </div>
                          </div>
                          <label
                            htmlFor="product-image-picker"
                            className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium focus-within:outline-2 focus-within:outline-em-focus-light ${imageEntries.length >= VALIDATION.MAX_IMAGES || isSaving ? "cursor-not-allowed bg-em-border text-em-text-secondary" : "bg-em-violet-600 text-white hover:bg-em-violet-700"}`}
                          >
                            <Upload className="h-4 w-4" aria-hidden="true" />
                            {t("products.form.chooseFiles")}
                            <input
                              id="product-image-picker"
                              type="file"
                              accept="image/*"
                              multiple
                              className="sr-only"
                              onChange={handleImageSelection}
                              disabled={imageEntries.length >= VALIDATION.MAX_IMAGES || isSaving}
                            />
                          </label>
                        </div>

                        {imageEntries.length > 0 && (
                          <div className="mt-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <p className="text-sm font-medium text-em-text-primary">{t("products.detail.images")}</p>
                              <button
                                type="button"
                                onClick={clearImages}
                                disabled={isSaving || uploadingCount > 0}
                                className="min-h-11 rounded-lg px-3 text-sm text-em-danger-700 hover:bg-em-danger-100 disabled:opacity-60"
                              >
                                {t("products.form.clearImages")}
                              </button>
                            </div>
                            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                              {imageEntries.map((entry, index) => (
                                <li key={entry.id} aria-busy={entry.status === "uploading"} className="overflow-hidden rounded-lg border border-em-border bg-em-bg-surface">
                                  <div className="relative aspect-square bg-em-bg-muted">
                                    {(entry.url || entry.previewUrl) && (
                                      <img
                                        src={entry.status === "uploaded" ? entry.url : entry.previewUrl}
                                        alt={t("products.detail.imageAlt", { index: index + 1 })}
                                        className="h-full w-full object-cover"
                                      />
                                    )}
                                    {index === 0 && (
                                      <span className="absolute bottom-2 left-2 rounded bg-em-violet-600 px-2 py-1 text-xs font-medium text-white">
                                        {t("products.form.primaryImage")}
                                      </span>
                                    )}
                                    {entry.status === "uploading" && (
                                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-em-midnight-950/60 px-2 text-center text-xs text-white" role="status">
                            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                        <span>{t("products.form.imageUploading")}</span>
                                        <progress aria-label={t("products.form.imageUploading")} className="h-1 w-3/4 accent-em-violet-600" />
                                      </div>
                                    )}
                                  </div>
                                  {entry.error && <p className="px-2 pt-2 text-xs text-em-danger-700" role="alert">{entry.error}</p>}
                                  <div className="flex items-center justify-between gap-1 p-2">
                                    <div className="flex gap-1">
                                      <button
                                        type="button"
                                        onClick={() => moveImage(index, -1)}
                                        disabled={index === 0 || isSaving}
                                        aria-label={t("products.form.moveImageEarlier", { index: index + 1 })}
                                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-em-border text-em-text-secondary hover:bg-em-bg-muted disabled:opacity-40"
                                      >
                                        <span aria-hidden="true">←</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => moveImage(index, 1)}
                                        disabled={index === imageEntries.length - 1 || isSaving}
                                        aria-label={t("products.form.moveImageLater", { index: index + 1 })}
                                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-em-border text-em-text-secondary hover:bg-em-bg-muted disabled:opacity-40"
                                      >
                                        <span aria-hidden="true">→</span>
                                      </button>
                                    </div>
                                    <div className="flex gap-1">
                                      {entry.status === "error" && entry.file && (
                                        <button
                                          type="button"
                                          onClick={() => void startUpload(entry)}
                                          disabled={isSaving}
                                          className="min-h-11 rounded px-3 text-xs font-medium text-em-violet-700 hover:bg-em-info-100"
                                        >
                                          {t("common.retry")}
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => removeImage(entry.id)}
                                        disabled={isSaving || entry.status === "uploading"}
                                        aria-label={t("products.form.removeImage", { index: index + 1 })}
                                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-em-danger-700 hover:bg-em-danger-100 disabled:opacity-50"
                                      >
                                        <X className="h-4 w-4" aria-hidden="true" />
                                      </button>
                                    </div>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </ProductFormFieldView>
                </div>
              </div>
            </section>

            <section aria-labelledby="product-inventory-title" className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-6">
              <h2 id="product-inventory-title" className="mb-4 text-lg font-semibold text-em-text-primary">
                {t("products.form.inventoryStock")}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-em-text-primary">
                    <input
                      type="checkbox"
                      checked={draft.track_quantity}
                      onChange={(event) => updateField("track_quantity", event.target.checked)}
                      onBlur={() => touchField("track_quantity")}
                      className="h-4 w-4 rounded border-em-border-strong accent-em-violet-600"
                      disabled={!editorReady || isSaving}
                    />
                    {t("products.form.trackQuantity")}
                  </label>
                  <p className="text-xs text-em-text-secondary">
                    {draft.track_quantity ? t("products.form.trackedInventoryHelp") : t("products.form.untrackedInventoryHelp")}
                  </p>
                </div>

                {draft.track_quantity && (
                  <ProductFormFieldView
                    id="product-quantity"
                    field="quantity"
                    label={t("products.form.availableQuantity")}
                    draft={draft}
                    touched={Boolean(touched.quantity)}
                    errors={fieldErrors}
                  >
                    {({ error, describedBy }) => (
                      <ProductTextInput
                        id="product-quantity"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        value={draft.quantity}
                        onChange={(event) => updateField("quantity", event.target.value)}
                        onBlur={() => touchField("quantity")}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        disabled={!editorReady || isSaving}
                      />
                    )}
                  </ProductFormFieldView>
                )}

                <ProductFormFieldView
                  id="product-low-stock-threshold"
                  field="low_stock_threshold"
                  label={t("products.form.lowStockThreshold")}
                  draft={draft}
                  touched={Boolean(touched.low_stock_threshold)}
                  errors={fieldErrors}
                  help={t("products.form.lowStockThresholdHelp")}
                >
                  {({ error, describedBy }) => (
                    <ProductTextInput
                      id="product-low-stock-threshold"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={draft.low_stock_threshold}
                      onChange={(event) => updateField("low_stock_threshold", event.target.value)}
                      onBlur={() => touchField("low_stock_threshold")}
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      disabled={!editorReady || isSaving}
                    />
                  )}
                </ProductFormFieldView>
              </div>
            </section>

            <section aria-labelledby="product-variations-title" className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-6">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 id="product-variations-title" className="text-lg font-semibold text-em-text-primary">
                  {t("products.form.productVariants")}
                </h2>
                {variantsAreEditable && (
                  <button
                    type="button"
                    onClick={addVariantGroup}
                    disabled={!editorReady || isSaving}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-em-border-strong px-3 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("products.form.addVariantGroup")}
                  </button>
                )}
              </div>

              {variantsAreRelational ? (
                <div className="space-y-3">
                  <p className="rounded-lg border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-sm text-em-info-700">
                    {t("products.form.relationalVariantPrecedence")}
                  </p>
                  <ul className="divide-y divide-em-border rounded-lg border border-em-border">
                    {relationalVariants.map((variant) => {
                      const row = variant as typeof variant & Record<string, unknown>;
                      const label = [row.option_name, row.option_value].filter((value): value is string => typeof value === "string").join(": ");
                      return (
                        <li key={variant.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
                          <span className="font-medium text-em-text-primary">{label || variant.id}</span>
                          <span className="text-em-text-secondary">
                            {t("products.form.variantStock", { quantity: variant.quantity })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : hasLegacyVariantStrings ? (
                <div className="space-y-3">
                  <p className="rounded-lg border border-em-border bg-em-bg-muted px-3 py-2 text-sm text-em-text-secondary">
                    {t("products.form.legacyVariantsReadOnly")}
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {draft.variants.map((variant, index) => (
                      <li key={`${String(variant)}-${index}`} className="rounded-full bg-em-bg-muted px-3 py-1 text-sm text-em-text-primary">
                        {String(variant)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-em-text-secondary">{t("products.form.variantsHelp")}</p>
                  {draft.variants.length === 0 ? (
                    <p className="rounded-lg bg-em-bg-muted px-3 py-3 text-sm text-em-text-secondary">
                      {t("products.form.noOptionsYet")}
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {draft.variants.map((rawGroup, groupIndex) => {
                        const group = asVariantGroup(rawGroup);
                        return (
                          <fieldset key={`variant-group-${groupIndex}`} className="space-y-4 rounded-lg border border-em-border p-4">
                            <legend className="px-1 text-sm font-semibold text-em-text-primary">
                              {t("products.form.variantGroup", { index: groupIndex + 1 })}
                            </legend>
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => removeVariantGroup(groupIndex)}
                                disabled={isSaving}
                                aria-label={t("products.form.removeVariantGroup", { index: groupIndex + 1 })}
                                className="inline-flex min-h-11 items-center gap-1 rounded px-3 text-sm text-em-danger-700 hover:bg-em-danger-100"
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                {t("common.delete")}
                              </button>
                            </div>
                            <ProductFormFieldView
                              id={`variant-${groupIndex}-name`}
                              field="variants"
                              label={t("products.form.variantName")}
                              draft={draft}
                              touched={Boolean(touched.variants) && !group.name.trim()}
                              errors={fieldErrors}
                            >
                              {({ describedBy }) => (
                                <ProductTextInput
                                  id={`variant-${groupIndex}-name`}
                                  value={group.name}
                                  onChange={(event) => updateVariantGroup(groupIndex, { name: event.target.value })}
                                  onBlur={() => touchField("variants")}
                                  aria-describedby={describedBy}
                                  disabled={!editorReady || isSaving}
                                />
                              )}
                            </ProductFormFieldView>
                            <div className="space-y-2">
                              <span className="block text-sm font-medium text-em-text-primary">{t("products.form.variantOptions")}</span>
                              {group.options.map((option, optionIndex) => (
                                <div key={`variant-${groupIndex}-option-${optionIndex}`} className="flex gap-2">
                                  <ProductTextInput
                                    aria-label={t("products.form.variantOptionLabel", { group: groupIndex + 1, index: optionIndex + 1 })}
                                    value={option}
                                    onChange={(event) => updateVariantOption(groupIndex, optionIndex, event.target.value)}
                                    disabled={!editorReady || isSaving}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => removeVariantOption(groupIndex, optionIndex)}
                                    disabled={isSaving}
                                    aria-label={t("products.form.removeVariantOption", { group: groupIndex + 1, index: optionIndex + 1 })}
                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-em-border text-em-danger-700 hover:bg-em-danger-100"
                                  >
                                    <X className="h-4 w-4" aria-hidden="true" />
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => addVariantOption(groupIndex)}
                                disabled={isSaving}
                                className="min-h-11 rounded-lg px-3 text-sm font-medium text-em-violet-700 hover:bg-em-info-100"
                              >
                                {t("products.form.addOption")}
                              </button>
                            </div>
                            <details className="rounded-lg border border-em-border">
                              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light">
                                {t("products.form.catalogMetadata")}
                              </summary>
                              <div className="grid gap-4 border-t border-em-border p-3 sm:grid-cols-2">
                                <ProductFormFieldView
                                  id={`variant-${groupIndex}-price-adjustment`}
                                  field="variants"
                                  label={t("products.form.priceAdjustment")}
                                  draft={draft}
                                  touched={false}
                                  errors={fieldErrors}
                                >
                                  {() => (
                                    <ProductTextInput
                                      id={`variant-${groupIndex}-price-adjustment`}
                                      type="number"
                                      step="0.01"
                                      value={String(group.priceAdjustment ?? 0)}
                                      onChange={(event) => updateVariantGroup(groupIndex, { priceAdjustment: event.target.value })}
                                      disabled={!editorReady || isSaving}
                                    />
                                  )}
                                </ProductFormFieldView>
                                <ProductFormFieldView
                                  id={`variant-${groupIndex}-sku`}
                                  field="variants"
                                  label={t("products.form.variantSku")}
                                  draft={draft}
                                  touched={false}
                                  errors={fieldErrors}
                                >
                                  {() => (
                                    <ProductTextInput
                                      id={`variant-${groupIndex}-sku`}
                                      value={group.sku ?? ""}
                                      onChange={(event) => updateVariantGroup(groupIndex, { sku: event.target.value })}
                                      disabled={!editorReady || isSaving}
                                    />
                                  )}
                                </ProductFormFieldView>
                              </div>
                            </details>
                          </fieldset>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-xl border border-em-border bg-em-bg-surface">
              <button
                type="button"
                onClick={() => setShowAdditionalSettings((open) => !open)}
                aria-expanded={showAdditionalSettings}
                aria-controls="product-additional-settings"
                className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-em-focus-light md:px-6"
              >
                <span>
                  <span className="block text-lg font-semibold text-em-text-primary">{t("products.form.additionalDetails")}</span>
                  <span className="mt-0.5 block text-xs text-em-text-secondary">{t("products.form.additionalSettingsHelp")}</span>
                </span>
                {showAdditionalSettings ? <ChevronUp className="h-5 w-5 text-em-text-secondary" aria-hidden="true" /> : <ChevronDown className="h-5 w-5 text-em-text-secondary" aria-hidden="true" />}
              </button>

              {showAdditionalSettings && (
                <div id="product-additional-settings" className="space-y-5 border-t border-em-border px-4 py-5 md:px-6">
                  <div className="grid gap-5 md:grid-cols-2">
                    <ProductFormFieldView
                      id="product-sku"
                      field="sku"
                      label={t("products.detail.sku")}
                      draft={draft}
                      touched={Boolean(touched.sku)}
                      errors={fieldErrors}
                    >
                      {({ error, describedBy }) => (
                        <ProductTextInput
                          id="product-sku"
                          value={draft.sku}
                          onChange={(event) => updateField("sku", event.target.value)}
                          onBlur={() => touchField("sku")}
                          aria-invalid={Boolean(error)}
                          aria-describedby={describedBy}
                          disabled={!editorReady || isSaving}
                        />
                      )}
                    </ProductFormFieldView>
                    <ProductFormFieldView
                      id="product-brand"
                      field="brand"
                      label={t("products.form.brandManufacturer")}
                      draft={draft}
                      touched={Boolean(touched.brand)}
                      errors={fieldErrors}
                    >
                      {({ error, describedBy }) => (
                        <ProductTextInput
                          id="product-brand"
                          value={draft.brand}
                          placeholder={t("products.form.brandPlaceholder")}
                          onChange={(event) => updateField("brand", event.target.value)}
                          onBlur={() => touchField("brand")}
                          aria-invalid={Boolean(error)}
                          aria-describedby={describedBy}
                          disabled={!editorReady || isSaving}
                        />
                      )}
                    </ProductFormFieldView>
                  </div>

                  <ProductFormFieldView
                    id="product-tags"
                    field="tags"
                    label={t("products.detail.tags")}
                    draft={draft}
                    touched={Boolean(touched.tags)}
                    errors={fieldErrors}
                    help={t("products.form.tagsHelp")}
                  >
                    {({ describedBy }) => (
                      <div>
                        {draft.tags.length > 0 && (
                          <ul className="mb-3 flex flex-wrap gap-2">
                            {draft.tags.map((tag, index) => (
                              <li key={`${tag}-${index}`} className="inline-flex items-center gap-1 rounded-full bg-em-info-100 px-3 py-1 text-sm text-em-info-700">
                                {tag}
                                <button
                                  type="button"
                                  onClick={() => updateField("tags", draft.tags.filter((_, tagIndex) => tagIndex !== index))}
                                  disabled={isSaving}
                                  aria-label={t("products.form.removeTag", { tag })}
                                  className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full hover:bg-white/60"
                                >
                                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex gap-2">
                          <ProductTextInput
                            id="product-tags"
                            value={newTag}
                            placeholder={t("products.form.addTagPlaceholder")}
                            onChange={(event) => setNewTag(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                addTag();
                              }
                            }}
                            aria-describedby={describedBy}
                            disabled={!editorReady || isSaving}
                          />
                          <button
                            type="button"
                            onClick={addTag}
                            disabled={!newTag.trim() || isSaving}
                            className="min-h-11 shrink-0 rounded-lg border border-em-border-strong px-4 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
                          >
                            {t("products.form.addTag")}
                          </button>
                        </div>
                      </div>
                    )}
                  </ProductFormFieldView>

                  <div className="grid gap-5 sm:grid-cols-2">
                    <ProductFormFieldView
                      id="product-weight"
                      field="weight"
                      label={t("products.detail.weight")}
                      draft={draft}
                      touched={Boolean(touched.weight)}
                      errors={fieldErrors}
                    >
                      {({ error, describedBy }) => (
                        <ProductTextInput
                          id="product-weight"
                          type="number"
                          min="0.01"
                          step="any"
                          value={draft.weight}
                          onChange={(event) => updateField("weight", event.target.value)}
                          onBlur={() => touchField("weight")}
                          aria-invalid={Boolean(error)}
                          aria-describedby={describedBy}
                          disabled={!editorReady || isSaving}
                        />
                      )}
                    </ProductFormFieldView>
                    <ProductFormFieldView
                      id="product-weight-unit"
                      field="weight_unit"
                      label={t("products.form.weightUnit")}
                      draft={draft}
                      touched={Boolean(touched.weight_unit)}
                      errors={fieldErrors}
                    >
                      {({ error, describedBy }) => (
                        <ProductSelect
                          id="product-weight-unit"
                          value={draft.weight_unit}
                          onChange={(event) => updateField("weight_unit", event.target.value)}
                          onBlur={() => touchField("weight_unit")}
                          aria-invalid={Boolean(error)}
                          aria-describedby={describedBy}
                          disabled={!editorReady || isSaving}
                        >
                          <option value="">{t("common.optional")}</option>
                          <option value="kg">kg</option>
                          <option value="g">g</option>
                          <option value="lb">lb</option>
                          <option value="oz">oz</option>
                        </ProductSelect>
                      )}
                    </ProductFormFieldView>
                  </div>

                  <div className="border-t border-em-border pt-4">
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-em-text-primary">
                      <input
                        type="checkbox"
                        checked={draft.is_active}
                        onChange={(event) => updateField("is_active", event.target.checked)}
                        onBlur={() => touchField("is_active")}
                        className="h-4 w-4 rounded border-em-border-strong accent-em-violet-600"
                        disabled={!editorReady || isSaving}
                      />
                      {t("products.form.activeProduct")}
                    </label>
                    <p className="text-xs text-em-text-secondary">{t("products.form.activeProductHelp")}</p>
                  </div>
                </div>
              )}
            </section>

            {uploadingCount > 0 && (
              <p role="status" className="flex items-center gap-2 rounded-lg border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-sm text-em-info-700">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("products.form.imagesStillUploading")}
              </p>
            )}

            {imagesFailed && (
              <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-3 py-2 text-sm text-em-danger-700">
                {t("products.form.resolveImageUploads")}
              </p>
            )}

            {categoryQuery.isError && (
              <button
                type="button"
                onClick={() => void categoryQuery.refetch()}
                className="min-h-11 rounded-lg border border-em-border-strong px-3 text-sm text-em-text-primary hover:bg-em-bg-muted"
              >
                {t("products.form.retryCategories")}
              </button>
            )}

            <div className="sticky bottom-0 z-20 -mx-4 flex flex-col-reverse gap-3 border-t border-em-border bg-em-bg-surface/95 px-4 py-3 shadow-lg backdrop-blur sm:flex-row sm:justify-end md:static md:mx-0 md:z-auto md:border-t md:px-0 md:py-4 md:shadow-none md:backdrop-blur-0">
              <button
                type="button"
                onClick={() => navigate("/products")}
                disabled={isSaving}
                className="min-h-11 rounded-lg border border-em-border-strong px-5 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={saveDisabled}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-em-violet-600 px-6 text-sm font-semibold text-white hover:bg-em-violet-700 focus-visible:outline-2 focus-visible:outline-em-focus-light disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {isSaving ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        )}
      </div>

      {blocker.state === "blocked" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4" onClick={(event) => { if (event.target === event.currentTarget && !isSaving) blocker.reset?.(); }}>
          <div
            ref={discardDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="product-unsaved-title"
            aria-describedby="product-unsaved-description"
            tabIndex={-1}
            onKeyDown={(event) => { if (event.key === "Escape" && !isSaving) blocker.reset?.(); }}
            className="w-full max-w-md rounded-xl border border-em-border bg-em-bg-surface p-5 shadow-xl"
          >
            <h2 id="product-unsaved-title" className="text-lg font-semibold text-em-text-primary">
              {t("products.form.unsavedChangesTitle")}
            </h2>
            <p id="product-unsaved-description" className="mt-2 text-sm text-em-text-secondary">
              {t("products.form.unsavedChangesDescription")}
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => blocker.reset?.()}
                disabled={isSaving}
                className="min-h-11 rounded-lg border border-em-border-strong px-4 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
              >
                {t("products.form.stayOnEditor")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isSaving) return;
                  savedRef.current = true;
                  blocker.proceed?.();
                }}
                disabled={isSaving}
                className="min-h-11 rounded-lg bg-em-danger-700 px-4 text-sm font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-50"
              >
                {t("products.form.discardChanges")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
