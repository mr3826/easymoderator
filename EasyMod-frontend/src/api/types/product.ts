/**
 * Product and Category types
 */

/**
 * Ordering authority for stock since D-P2-02: when a product has ACTIVE
 * variants, Σ their quantities are the stock. Edge case (fixed in W3, matches
 * the A4/A5 implementation + unit tests): variants PRESENT but ALL INACTIVE
 * → fall back to the parent `quantity` — a product is never treated as
 * tracked-with-zero-stock merely because its variants were deactivated.
 * Carries just the D2 stock-exception fields the client predicate needs.
 */
export interface ProductVariantStock {
  id: string;
  quantity: number;
  is_active: boolean;
}

export interface Product {
  id: string;
  name: string;
  sku?: string | null;
  price: number;
  description?: string | null;
  category?: string;
  category_id?: string | null;
  status?: 'active' | 'inactive' | 'pending';
  variants?: unknown[];
  /**
   * Active-inclusive variant stock rows as serialised by the product reads
   * (D2). Optional and additive: W1 consumers ignore it; Products.tsx's
   * variant-aware `isLowStockProduct` (W2, A4) switches to this array,
   * matching the server `GET /api/product/stock-exceptions` predicate.
   */
  product_variants?: ProductVariantStock[];
  aliases?: string[];
  stock?: boolean;
  images?: string[];
  /**
   * Primary image. Distinct from `images[0]`: the backend's
   * product-link.service selects only this column when building the product
   * cards sent to customers, so it must be kept in sync with `images[0]`.
   */
  image_url?: string | null;
  brand?: string | null;
  weight?: number | null;
  weight_unit?: string | null;
  tags?: string[];
  compare_at_price?: number;
  cost_per_item?: number;
  quantity?: number | null;
  is_active?: boolean;
  low_stock_threshold?: number | null;
  track_quantity?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWritePayload {
  name: string;
  price: number;
  description?: string | null;
  sku?: string | null;
  brand?: string | null;
  category_id?: string | null;
  tags?: string[];
  variants?: unknown[];
  track_quantity?: boolean;
  quantity?: number;
  low_stock_threshold?: number | null;
  weight?: number | null;
  weight_unit?: string | null;
  is_active?: boolean;
  images?: string[];
  image_url?: string | null;
}

export type CreateProductPayload = ProductWritePayload;
export type UpdateProductPayload = Partial<ProductWritePayload>;

export interface ProductOverview {
  total: number;
  active: number;
  inactive: number;
  low_stock: number;
  out_of_stock: number;
  scanned: number;
  cap: number;
  coverage_complete: boolean;
}

/** Transient AI import row; provenance is never written to a product record. */
export type ExtractedProduct = Partial<ProductWritePayload> & {
  id?: string;
  status?: 'pending';
  confidence: number;
  ai_generated: true;
};

export interface CategoryDraft {
  id?: string;
  name: string;
  is_active?: boolean;
  description?: string;
  image?: string;
  cover_image?: string;
  product_count?: number;
  affected_product_count?: number;
  subcategory_count?: number;
}

export interface Category {
  id: string;
  shop_id?: string;
  name: string;
  description?: string;
  image?: string;
  cover_image?: string;
  parent_id?: string | null;
  parent_category_id?: string | null;
  is_active?: boolean;
  subcategories?: CategoryDraft[];
  subcategoryCount?: number;
  product_count?: number;
  affected_product_count?: number;
  subcategory_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ProductExtractResult {
  products: ExtractedProduct[];
  stats: {
    total: number;
    parsed: number;
    skipped: number;
  };
}

export interface ProductUploadPayload {
  filename?: string;
  content_type?: string;
  content?: string;
  file?: File;
  format?: 'csv' | 'tsv' | 'txt';
}
