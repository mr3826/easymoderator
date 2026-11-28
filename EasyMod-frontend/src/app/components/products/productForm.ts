import type { Product, CreateProductPayload, UpdateProductPayload } from '@/api/types/product';

export interface ProductDraft {
  name: string;
  price: string;
  description: string;
  category_id: string;
  sku: string;
  brand: string;
  tags: string[];
  variants: unknown[];
  track_quantity: boolean;
  quantity: string;
  low_stock_threshold: string;
  weight: string;
  weight_unit: string;
  is_active: boolean;
  images: string[];
}

export type ProductFormField = keyof ProductDraft;
export type ProductFieldError =
  | 'products.form.errors.nameRequired'
  | 'products.form.errors.priceInvalid'
  | 'products.form.errors.quantityInvalid'
  | 'products.form.errors.thresholdInvalid'
  | 'products.form.errors.weightInvalid'
  | 'products.form.errors.variantNameRequired';

export type ProductFieldErrors = Partial<Record<ProductFormField, ProductFieldError>>;

export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `product-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const PRODUCT_FIELDS: ProductFormField[] = [
  'name',
  'price',
  'description',
  'category_id',
  'sku',
  'brand',
  'tags',
  'variants',
  'track_quantity',
  'quantity',
  'low_stock_threshold',
  'weight',
  'weight_unit',
  'is_active',
  'images',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function normalizeVariants(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  const normalized: unknown[] = [];
  for (const variant of value) {
    if (typeof variant === 'string') {
      normalized.push(variant);
      continue;
    }
    if (!isRecord(variant)) continue;
    const { price_adjustment: legacyPriceAdjustment, ...group } = variant;
    const adjustment = Number(group.priceAdjustment ?? legacyPriceAdjustment ?? 0);
    normalized.push({
      ...group,
      name: typeof group.name === 'string' ? group.name : '',
      options: Array.isArray(group.options)
        ? group.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
        : [],
      priceAdjustment: Number.isFinite(adjustment) ? adjustment : 0,
      sku: typeof group.sku === 'string' ? group.sku : '',
    });
  }
  return normalized;
}

export function normalizeProduct(product?: Product | null): ProductDraft {
  const storedImages = Array.isArray(product?.images)
    ? product.images.filter((image): image is string => typeof image === 'string' && image.length > 0)
    : [];
  const images = product?.image_url
    ? [product.image_url, ...storedImages.filter((image) => image !== product.image_url)]
    : storedImages;

  return {
    name: product?.name ?? '',
    price: inputValue(product?.price),
    description: product?.description ?? '',
    category_id: product?.category_id ?? '',
    sku: product?.sku ?? '',
    brand: product?.brand ?? '',
    tags: Array.isArray(product?.tags) ? product.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    variants: normalizeVariants(product?.variants),
    track_quantity: product?.track_quantity === true,
    quantity: inputValue(product?.quantity),
    low_stock_threshold: inputValue(product?.low_stock_threshold),
    weight: inputValue(product?.weight),
    weight_unit: product?.weight_unit ?? '',
    is_active: product?.is_active ?? product?.status !== 'inactive',
    images: [...images],
  };
}

export function validateProductField(field: ProductFormField, draft: ProductDraft): ProductFieldError | undefined {
  switch (field) {
    case 'name':
      return draft.name.trim() ? undefined : 'products.form.errors.nameRequired';
    case 'price': {
      const price = Number(draft.price);
      return Number.isFinite(price) && price > 0 ? undefined : 'products.form.errors.priceInvalid';
    }
    case 'quantity': {
      if (!draft.track_quantity || !draft.quantity.trim()) return undefined;
      const quantity = Number(draft.quantity);
      return Number.isInteger(quantity) && quantity >= 0 ? undefined : 'products.form.errors.quantityInvalid';
    }
    case 'low_stock_threshold': {
      if (!draft.low_stock_threshold.trim()) return undefined;
      const threshold = Number(draft.low_stock_threshold);
      return Number.isInteger(threshold) && threshold >= 0 ? undefined : 'products.form.errors.thresholdInvalid';
    }
    case 'weight': {
      if (!draft.weight.trim()) return undefined;
      const weight = Number(draft.weight);
      return Number.isFinite(weight) && weight > 0 ? undefined : 'products.form.errors.weightInvalid';
    }
    case 'variants':
      return draft.variants.some((variant) => isRecord(variant)
        && (typeof variant.name !== 'string' || !variant.name.trim()))
        ? 'products.form.errors.variantNameRequired'
        : undefined;
    default:
      return undefined;
  }
}

export function validateProductDraft(draft: ProductDraft): ProductFieldErrors {
  const errors: ProductFieldErrors = {};
  for (const field of PRODUCT_FIELDS) {
    const error = validateProductField(field, draft);
    if (error) errors[field] = error;
  }
  return errors;
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableInteger(value: string): number | null {
  const parsed = nullableNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function normalizedTags(tags: string[]): string[] {
  return tags.map((tag) => tag.trim()).filter(Boolean);
}

function normalizedImages(images: string[]): string[] {
  return images.filter((image) => typeof image === 'string' && image.length > 0);
}

export function toCreatePayload(draft: ProductDraft): CreateProductPayload {
  const images = normalizedImages(draft.images);
  const payload: CreateProductPayload = {
    name: draft.name.trim(),
    price: nullableNumber(draft.price) ?? 0,
    description: draft.description.trim() || null,
    category_id: draft.category_id || null,
    sku: draft.sku.trim() || null,
    brand: draft.brand.trim() || null,
    tags: normalizedTags(draft.tags),
    track_quantity: draft.track_quantity,
    quantity: draft.track_quantity ? nullableInteger(draft.quantity) ?? 0 : 0,
    low_stock_threshold: nullableInteger(draft.low_stock_threshold),
    weight: nullableNumber(draft.weight),
    weight_unit: draft.weight.trim() ? draft.weight_unit || null : null,
    is_active: draft.is_active,
    images,
    image_url: images[0] ?? null,
  };

  const variants = normalizeVariants(draft.variants);
  if (variants.length > 0) payload.variants = variants;
  return payload;
}

export function toPatch(
  draft: ProductDraft,
  dirtyFields: ReadonlySet<ProductFormField> | readonly ProductFormField[],
): UpdateProductPayload {
  const dirty = dirtyFields instanceof Set ? dirtyFields : new Set(dirtyFields);
  const payload: UpdateProductPayload = {};

  if (dirty.has('name')) payload.name = draft.name.trim();
  if (dirty.has('price')) payload.price = nullableNumber(draft.price) ?? 0;
  if (dirty.has('description')) payload.description = draft.description.trim() || null;
  if (dirty.has('category_id')) payload.category_id = draft.category_id || null;
  if (dirty.has('sku')) payload.sku = draft.sku.trim() || null;
  if (dirty.has('brand')) payload.brand = draft.brand.trim() || null;
  if (dirty.has('tags')) payload.tags = normalizedTags(draft.tags);
  if (dirty.has('variants')) payload.variants = normalizeVariants(draft.variants);
  if (dirty.has('track_quantity')) payload.track_quantity = draft.track_quantity;
  if (dirty.has('quantity')) payload.quantity = nullableInteger(draft.quantity) ?? 0;
  if (dirty.has('low_stock_threshold')) payload.low_stock_threshold = nullableInteger(draft.low_stock_threshold);
  if (dirty.has('weight')) payload.weight = nullableNumber(draft.weight);
  if (dirty.has('weight_unit')) payload.weight_unit = draft.weight.trim() ? draft.weight_unit || null : null;
  if (dirty.has('is_active')) payload.is_active = draft.is_active;
  if (dirty.has('images')) {
    const images = normalizedImages(draft.images);
    payload.images = images;
    payload.image_url = images[0] ?? null;
  }

  return payload;
}
