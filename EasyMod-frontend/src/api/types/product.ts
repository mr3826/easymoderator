/**
 * Product and Category types
 */

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  description?: string;
  category?: string;
  category_id?: string;
  status?: 'active' | 'inactive' | 'pending';
  variants?: unknown[];
  aliases?: string[];
  aiGenerated?: boolean;
  ai_generated?: boolean;
  confidence?: number | null;
  stock?: boolean;
  images?: string[];
  /**
   * Primary image. Distinct from `images[0]`: the backend's
   * product-link.service selects only this column when building the product
   * cards sent to customers, so it must be kept in sync with `images[0]`.
   */
  image_url?: string;
  brand?: string;
  weight?: number;
  weight_unit?: string;
  tags?: string[];
  compare_at_price?: number;
  cost_per_item?: number;
  quantity?: number;
  is_active?: boolean;
  low_stock_threshold?: number;
  track_quantity?: boolean;
  allow_discounts?: boolean;
  charge_tax?: boolean;
  send_low_stock_alert?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryDraft {
  id?: string;
  name: string;
  description?: string;
  image?: string;
  cover_image?: string;
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
  created_at: string;
  updated_at: string;
}

export interface ProductExtractResult {
  products: Product[];
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
  format?: 'csv' | 'xlsx' | 'json';
}
