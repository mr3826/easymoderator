import { describe, expect, it } from "vitest";
import {
  getStorefrontErrorMessage,
  hashCheckoutPayload,
  localizedProductText,
  normalizePublicProductRows,
} from "./storefrontUtils";

describe("storefront buyer helpers", () => {
  it.each([
    [{ statusCode: 404, message: "Not found" }, "unpublished or is no longer available"],
    [{ statusCode: 409, code: "STOCK_CHANGED", message: "Conflict" }, "Stock changed"],
    [{ statusCode: 409, code: "PRICE_CHANGED", message: "Conflict" }, "price changed"],
    [{ statusCode: 400, code: "INVALID_PRODUCT", message: "Invalid" }, "no longer available"],
    [{ statusCode: 400, message: "Bad request" }, "Bad request"],
    [{ statusCode: 429, message: "Rate limited" }, "Too many requests"],
  ])("provides a useful message for structured failures", (error, expected) => {
    expect(getStorefrontErrorMessage(error, "Fallback")).toContain(expected);
  });

  it("normalizes product and variant rows and chooses the requested language", () => {
    const products = normalizePublicProductRows([
      {
        id: "p-1",
        name: "Cotton shirt",
        name_bn: "সুতি জামা",
        description: "Soft cotton",
        description_bn: "নরম সুতি কাপড়",
        price: 500,
      },
      {
        id: "v-1",
        product_id: "p-1",
        name: "Cotton shirt",
        option_name: "Size",
        option_value: "M",
        price: 550,
      },
    ]);

    expect(products).toHaveLength(1);
    expect(products[0].variants).toEqual([
      { id: "v-1", option_name: "Size", option_value: "M", price: 550 },
    ]);
    expect(localizedProductText(products[0], "en")).toEqual({ name: "Cotton shirt", description: "Soft cotton" });
    expect(localizedProductText(products[0], "bn")).toEqual({ name: "সুতি জামা", description: "নরম সুতি কাপড়" });
  });

  it("hashes identical checkout payloads consistently and changes the hash with buyer data", async () => {
    const original = { customer_name: "A", items: [{ product_id: "p-1", quantity: 1 }] };
    expect(await hashCheckoutPayload(original)).toBe(await hashCheckoutPayload(original));
    expect(await hashCheckoutPayload(original)).not.toBe(
      await hashCheckoutPayload({ ...original, customer_name: "B" }),
    );
  });
});
