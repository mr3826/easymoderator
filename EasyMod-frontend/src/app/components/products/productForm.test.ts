import { describe, expect, it } from 'vitest';
import type { Product } from '@/api/types/product';
import { normalizeProduct, toCreatePayload, toPatch, validateProductDraft } from './productForm';

const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'product-1',
  name: 'Kurta',
  sku: 'K-1',
  price: 1200,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

describe('product form contract', () => {
  it('normalizes the primary image and legacy variant adjustment name', () => {
    const draft = normalizeProduct(product({
      image_url: 'https://cdn.example/primary.jpg',
      variants: [{ name: 'Size', options: ['M', 'L'], price_adjustment: 25, sku: 'SIZE' }],
    }));

    expect(draft.images).toEqual(['https://cdn.example/primary.jpg']);
    expect(normalizeProduct(product({
      images: ['https://cdn.example/secondary.jpg', 'https://cdn.example/primary.jpg'],
      image_url: 'https://cdn.example/primary.jpg',
    })).images).toEqual(['https://cdn.example/primary.jpg', 'https://cdn.example/secondary.jpg']);
    expect(draft.variants).toEqual([{ name: 'Size', options: ['M', 'L'], priceAdjustment: 25, sku: 'SIZE' }]);
    expect(normalizeProduct(product({ variants: ['legacy value'] })).variants).toEqual(['legacy value']);
  });

  it('serializes create values with explicit cleared scalars and arrays', () => {
    const draft = normalizeProduct(null);
    draft.name = ' New item ';
    draft.price = '100';

    expect(toCreatePayload(draft)).toEqual({
      name: 'New item',
      price: 100,
      description: null,
      category_id: null,
      sku: null,
      brand: null,
      tags: [],
      track_quantity: false,
      quantity: 0,
      low_stock_threshold: null,
      weight: null,
      weight_unit: null,
      is_active: true,
      images: [],
      image_url: null,
    });
  });

  it('patches only dirty fields and sends explicit clears without hidden controls', () => {
    const draft = normalizeProduct(product());
    draft.description = '';
    draft.category_id = '';
    draft.tags = [];
    draft.variants = [];
    draft.images = [];

    expect(toPatch(draft, ['description', 'category_id', 'tags', 'variants', 'images'])).toEqual({
      description: null,
      category_id: null,
      tags: [],
      variants: [],
      images: [],
      image_url: null,
    });
  });

  it('validates only required price and name plus entered numeric values', () => {
    const draft = normalizeProduct(null);
    draft.track_quantity = true;
    draft.quantity = '-1';
    draft.low_stock_threshold = '1.5';
    draft.weight = '0';

    expect(validateProductDraft(draft)).toEqual({
      name: 'products.form.errors.nameRequired',
      price: 'products.form.errors.priceInvalid',
      quantity: 'products.form.errors.quantityInvalid',
      low_stock_threshold: 'products.form.errors.thresholdInvalid',
      weight: 'products.form.errors.weightInvalid',
    });
  });

  it('validates variant group names when option groups are present', () => {
    const draft = normalizeProduct(null);
    draft.variants = [{ name: ' ', options: [], priceAdjustment: 0, sku: '' }];

    expect(validateProductDraft(draft).variants).toBe('products.form.errors.variantNameRequired');
    draft.variants = [{ name: 'Size', options: ['S'], priceAdjustment: 0, sku: '' }];
    expect(validateProductDraft(draft).variants).toBeUndefined();
  });
});
