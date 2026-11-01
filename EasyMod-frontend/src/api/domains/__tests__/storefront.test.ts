import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, post, patch, put, skipShopIdConfig } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  skipShopIdConfig: vi.fn((config: Record<string, unknown> = {}) => ({ ...config, __skipShopId: true })),
}));

vi.mock("@/shared/lib/http/client", () => ({ httpClient: { get, post, patch, put, skipShopIdConfig } }));

describe("storefront API domain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the management paths and unwraps a missing storefront", async () => {
    const storefront = await import("../storefront");
    get.mockResolvedValueOnce({ data: { success: true, data: null } });

    await expect(storefront.getStorefrontManage()).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith("/api/storefront/manage");

    const createPayload = { title: "Market", slug: "market" };
    await storefront.createStorefront(createPayload);
    expect(post).toHaveBeenCalledWith("/api/storefront/manage", createPayload);

    const patchPayload = { title: "Market Updated" };
    await storefront.updateStorefront(patchPayload);
    expect(patch).toHaveBeenCalledWith("/api/storefront/manage", patchPayload);

    const settings = { delivery_fee: 60, delivery_note: "Call on arrival" };
    await storefront.updateStorefrontSettings(settings);
    expect(put).toHaveBeenCalledWith("/api/storefront/manage/settings", settings);

    const selection = { selected_products: [{ product_id: "p-1", variant_ids: ["v-1"] }] };
    await storefront.updateStorefrontProducts(selection);
    expect(put).toHaveBeenCalledWith("/api/storefront/manage/products", selection);

    await storefront.publishStorefront();
    expect(post).toHaveBeenCalledWith("/api/storefront/manage/publish");
    await storefront.unpublishStorefront();
    expect(post).toHaveBeenCalledWith("/api/storefront/manage/unpublish");
  });

  it("uses public storefront paths and sends only the checkout contract plus idempotency header", async () => {
    const storefront = await import("../storefront");
    const details = {
      slug: "blue-market",
      title: "Blue Market",
      description: null,
      logo_url: null,
      settings: { delivery_fee: 40, delivery_note: "" },
    };
    const rows = [{ id: "p-1", name: "Shirt", price: 500 }];
    get
      .mockResolvedValueOnce({ data: { success: true, data: details } })
      .mockResolvedValueOnce({ data: { success: true, data: rows } });
    await expect(storefront.getPublicStorefront("blue market")).resolves.toEqual(details);
    await expect(storefront.getPublicStorefrontProducts("blue market")).resolves.toEqual(rows);
    expect(get).toHaveBeenNthCalledWith(1, "/api/storefront/public/blue%20market", { __skipShopId: true });
    expect(get).toHaveBeenNthCalledWith(2, "/api/storefront/public/blue%20market/products", { __skipShopId: true });

    const payload = {
      customer_name: "A Buyer",
      customer_phone: "01700000000",
      delivery_address: { district: "Dhaka", street_address: "Road 1" },
      consent: true as const,
      items: [{ product_id: "p-1", quantity: 2 }],
    };
    const result = {
      order_id: "o-1",
      order_number: "SM-1001",
      total: 1040,
      payment_status: "unpaid" as const,
      order_status: "confirmed" as const,
    };
    post.mockResolvedValueOnce({ data: { success: true, data: result } });

    await expect(storefront.createStorefrontCheckout("blue-market", payload, "key-1")).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith(
      "/api/storefront/public/blue-market/checkout",
      payload,
      { headers: { "Idempotency-Key": "key-1" }, __skipShopId: true },
    );
  });
});
