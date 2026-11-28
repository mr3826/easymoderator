'use strict';

const { getOverview } = require('../product-overview.service');

describe('product overview read model', () => {
    const shopId = 'shop-1';
    let Product;
    let getStockExceptions;

    beforeEach(() => {
        Product = { count: jest.fn() };
        Product.count
            .mockResolvedValueOnce('12')
            .mockResolvedValueOnce('9')
            .mockResolvedValueOnce('3');
        getStockExceptions = jest.fn().mockResolvedValue({
            lowStock: 2,
            outOfStock: 1,
            exceptions: 3,
            scanned: 12,
            cap: 1000,
            coverageComplete: true,
        });
    });

    it('counts tenant products and preserves stock-exception scan authority', async () => {
        const result = await getOverview({ shopId, Product, getStockExceptions });

        expect(Product.count.mock.calls.map(([options]) => options.where)).toEqual([
            { shop_id: shopId },
            { shop_id: shopId, is_active: true },
            { shop_id: shopId, is_active: false },
        ]);
        expect(getStockExceptions).toHaveBeenCalledWith({ shopId });
        expect(result).toEqual({
            total: 12,
            active: 9,
            inactive: 3,
            low_stock: 2,
            out_of_stock: 1,
            scanned: 12,
            cap: 1000,
            coverage_complete: true,
        });
    });

    it('rejects read failures instead of manufacturing a zero overview', async () => {
        getStockExceptions.mockRejectedValue(new Error('stock scan unavailable'));

        await expect(getOverview({ shopId, Product, getStockExceptions }))
            .rejects.toThrow('stock scan unavailable');
    });

    it('requires a tenant before issuing any database reads', async () => {
        await expect(getOverview({ Product, getStockExceptions })).rejects.toThrow(/tenant scope/);
        expect(Product.count).not.toHaveBeenCalled();
        expect(getStockExceptions).not.toHaveBeenCalled();
    });
});
