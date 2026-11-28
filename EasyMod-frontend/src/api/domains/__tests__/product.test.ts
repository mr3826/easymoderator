/**
 * Product Domain API Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as product from '../product';
import { httpClient } from '@/shared/lib/http/client';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('Product Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getProducts', () => {
    it('should return list of products', async () => {
      const mockResponse = {
        data: {
          data: [
            { id: '1', name: 'Product 1', price: 100 },
            { id: '2', name: 'Product 2', price: 200 },
          ],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await product.getProducts();

      expect(httpClient.get).toHaveBeenCalledWith('/api/product', { params: undefined });
      expect(result).toEqual(mockResponse.data.data);
    });

    it('should handle pagination params', async () => {
      const mockResponse = {
        data: {
          data: [{ id: '1', name: 'Product 1' }],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      await product.getProducts({ page: 1, limit: 10 });

      expect(httpClient.get).toHaveBeenCalledWith('/api/product', { params: { page: 1, limit: 10 } });
    });
  });

  describe('getProduct', () => {
    it('should return single product', async () => {
      const mockResponse = {
        data: {
          data: { id: '1', name: 'Product 1', price: 100, description: 'Test' },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await product.getProduct('1');

      expect(httpClient.get).toHaveBeenCalledWith('/api/product/1');
      expect(result).toEqual(mockResponse.data.data);
    });

    it('should throw error when product not found', async () => {
      (httpClient.get as any).mockRejectedValue(new Error('Product not found'));

      await expect(product.getProduct('999')).rejects.toThrow('Product not found');
    });
  });

  describe('createProduct', () => {
    const productData = {
      name: 'New Product',
      price: 150,
      description: 'A new product',
      category_id: 'cat1',
    };

    it('should create product successfully', async () => {
      const mockResponse = {
        data: { data: { id: '3', ...productData, createdAt: new Date().toISOString() } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await product.createProduct(productData as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/product', productData, { __noRetry: true });
      expect(result.id).toBe('3');
    });

    it('should throw error on validation failure', async () => {
      (httpClient.post as any).mockRejectedValue(new Error('Validation failed'));

      await expect(product.createProduct({} as any)).rejects.toThrow('Validation failed');
    });
  });

  describe('updateProduct', () => {
    const updateData = {
      name: 'Updated Product',
      price: 200,
    };

    it('should update product successfully', async () => {
      const mockResponse = {
        data: { data: { id: '1', ...updateData, updatedAt: new Date().toISOString() } },
      };
      (httpClient.patch as any).mockResolvedValue(mockResponse);

      const result = await product.updateProduct('1', updateData);

      expect(httpClient.patch).toHaveBeenCalledWith('/api/product/1', updateData, { __noRetry: true });
      expect(result.name).toBe(updateData.name);
    });
  });

  describe('uploadProductImage', () => {
    it('does not retry a product image upload', async () => {
      (httpClient.post as any).mockResolvedValue({ data: { data: { url: 'https://cdn.example/image.jpg' } } });

      await expect(product.uploadProductImage('data:image/jpeg;base64,abc')).resolves.toBe('https://cdn.example/image.jpg');
      expect(httpClient.post).toHaveBeenCalledWith(
        '/api/product/images',
        { image: 'data:image/jpeg;base64,abc' },
        { __noRetry: true },
      );
    });
  });

  describe('deleteProduct', () => {
    it('should delete product successfully', async () => {
      (httpClient.delete as any).mockResolvedValue({ data: {} });

      await product.deleteProduct('1');

      expect(httpClient.delete).toHaveBeenCalledWith('/api/product/1');
    });
  });

  describe('extractProductsFromUpload', () => {
    it('should extract products from file', async () => {
      const mockResponse = {
        data: {
          data: {
            products: [
              { name: 'Extracted 1', price: 100 },
              { name: 'Extracted 2', price: 200 },
            ],
          },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const payload = { file: new File(['test'], 'test.csv'), format: 'csv' as const };
      const result = await product.extractProductsFromUpload(payload);

      expect(httpClient.post).toHaveBeenCalledWith('/api/product/ai-extract', payload, { __noRetry: true });
      expect(result).toEqual(mockResponse.data.data);
    });

    it('forwards a stable idempotency key while disabling automatic retries', async () => {
      const payload = { name: 'Kurta', price: 900 } as any;
      (httpClient.post as any).mockResolvedValue({ data: { data: { id: 'p-1' } } });

      await product.createProduct(payload, 'row-operation-1');

      expect(httpClient.post).toHaveBeenCalledWith('/api/product', payload, {
        __noRetry: true,
        headers: { 'Idempotency-Key': 'row-operation-1' },
      });
    });
  });

  describe('getProductOverview', () => {
    it('returns server-owned counts and coverage', async () => {
      const overview = {
        total: 8,
        active: 6,
        inactive: 2,
        low_stock: 1,
        out_of_stock: 1,
        scanned: 6,
        cap: 1000,
        coverage_complete: false,
      };
      (httpClient.get as any).mockResolvedValue({ data: { data: overview } });

      await expect(product.getProductOverview()).resolves.toEqual(overview);
      expect(httpClient.get).toHaveBeenCalledWith('/api/product/overview', undefined);
    });
  });

  describe('getCategories', () => {
    it('should return list of categories', async () => {
      const mockResponse = {
        data: {
          data: [
            { id: '1', name: 'Electronics', subcategories: [] },
            { id: '2', name: 'Clothing', subcategories: [] },
          ],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await product.getCategories();

      expect(httpClient.get).toHaveBeenCalledWith('/api/category');
      expect(result).toEqual(mockResponse.data.data);
    });

    it('requests counts only for the category workspace', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { data: [] } });

      await product.getCategories({ include: 'product_count', include_inactive: true });

      expect(httpClient.get).toHaveBeenCalledWith('/api/category', { params: { include: 'product_count', include_inactive: true } });
    });
  });

  describe('getCategory', () => {
    it('should return single category', async () => {
      const mockResponse = {
        data: { data: { id: '1', name: 'Electronics', productCount: 15 } },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await product.getCategory('1');

      expect(httpClient.get).toHaveBeenCalledWith('/api/category/1');
      expect(result).toEqual(mockResponse.data.data);
    });
  });

  describe('createCategory', () => {
    it('should create category successfully', async () => {
      const categoryData = { name: 'New Category', description: 'A new category' };
      const mockResponse = {
        data: { data: { id: '3', ...categoryData } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await product.createCategory(categoryData as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/category', categoryData);
      expect(result.id).toBe('3');
    });
  });

  describe('updateCategory', () => {
    it('should update category successfully', async () => {
      const updateData = { name: 'Updated Category' };
      const mockResponse = { data: { data: { id: '1', ...updateData } } };
      (httpClient.patch as any).mockResolvedValue(mockResponse);

      const result = await product.updateCategory('1', updateData);

      expect(httpClient.patch).toHaveBeenCalledWith('/api/category/1', updateData);
      expect(result.name).toBe('Updated Category');
    });
  });

  describe('deleteCategory', () => {
    it('should delete category successfully', async () => {
      (httpClient.delete as any).mockResolvedValue({ data: {} });

      await product.deleteCategory('1');

      expect(httpClient.delete).toHaveBeenCalledWith('/api/category/1');
    });
  });
});
