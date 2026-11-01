import type { Product } from "@/api/types/product";
import type { StorefrontPublicProduct, StorefrontVariant } from "@/api/domains/storefront";

export interface SelectableCatalogVariant {
  id: string;
  label: string;
}

export interface DisplayStorefrontProduct extends StorefrontPublicProduct {
  id: string;
  name: string;
  variants: StorefrontVariant[];
  hasUnsupportedVariants: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getSelectableCatalogVariants(product: Product): {
  variants: SelectableCatalogVariant[];
  hasUnsupportedVariants: boolean;
} {
  const relationalVariants = (product as Product & { product_variants?: unknown[] }).product_variants;
  const source = Array.isArray(relationalVariants)
    ? relationalVariants
    : Array.isArray(product.variants) ? product.variants : [];
  const variants = source.flatMap((value) => {
    if (!isObject(value) || typeof value.id !== "string") return [];
    const optionName = typeof value.option_name === "string"
      ? value.option_name
      : typeof value.name === "string" ? value.name : "Option";
    const optionValue = typeof value.option_value === "string"
      ? value.option_value
      : typeof value.value === "string" ? value.value : "";
    return [{ id: value.id, label: [optionName, optionValue].filter(Boolean).join(": ") }];
  });

  return {
    variants,
    hasUnsupportedVariants: source.length > 0 && variants.length !== source.length,
  };
}

export function normalizePublicProductRows(rows: StorefrontPublicProduct[]): DisplayStorefrontProduct[] {
  const products = new Map<string, DisplayStorefrontProduct>();
  const variantRows: StorefrontPublicProduct[] = [];

  for (const row of rows) {
    if (row.product_id && row.option_name && row.option_value) {
      variantRows.push(row);
      continue;
    }

    const id = row.id;
    const rawVariants = Array.isArray(row.variants) ? row.variants as unknown[] : [];
    const variants = rawVariants.flatMap((value) => {
      if (!isObject(value) || typeof value.id !== "string") return [];
      return [{
        id: value.id,
        option_name: typeof value.option_name === "string" ? value.option_name : "Option",
        option_value: typeof value.option_value === "string" ? value.option_value : "",
        price: typeof value.price === "number" || typeof value.price === "string" ? value.price : row.price ?? 0,
      }];
    });
    const hasUnsupportedVariants = rawVariants.length > 0 && variants.length !== rawVariants.length;

    products.set(id, {
      ...row,
      id,
      name: row.name || row.name_en || row.name_bn || "",
      variants,
      hasUnsupportedVariants,
    });
  }

  for (const row of variantRows) {
    const productId = row.product_id!;
    const existing = products.get(productId);
    const variant: StorefrontVariant = {
      id: row.id,
      option_name: row.option_name!,
      option_value: row.option_value!,
      price: row.price ?? 0,
    };

    if (existing) {
      if (!existing.variants.some((candidate) => candidate.id === variant.id)) {
        existing.variants = [...existing.variants, variant];
      }
      continue;
    }

    products.set(productId, {
      ...row,
      id: productId,
      name: row.name || row.name_en || row.name_bn || "",
      price: row.product_price,
      variants: [variant],
      hasUnsupportedVariants: false,
    });
  }

  return [...products.values()].filter((product) => product.name.trim().length > 0);
}

export function localizedProductText(
  product: Pick<StorefrontPublicProduct, "name" | "name_en" | "name_bn" | "description" | "description_en" | "description_bn">,
  language: string,
): { name: string; description: string } {
  const isBangla = language.toLowerCase().startsWith("bn");
  const name = (isBangla ? product.name_bn : product.name_en) || product.name || product.name_en || product.name_bn || "";
  const description = (isBangla ? product.description_bn : product.description_en)
    || product.description
    || product.description_en
    || product.description_bn
    || "";
  return { name, description };
}

export function getStorefrontErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  const response = isObject(error.response) ? error.response : undefined;
  const data = response && isObject(response.data) ? response.data : undefined;
  const nested = data && isObject(data.error) ? data.error : undefined;
  return typeof nested?.code === "string" ? nested.code : undefined;
}

export function getStorefrontErrorStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  if (typeof error.statusCode === "number") return error.statusCode;
  const response = isObject(error.response) ? error.response : undefined;
  return typeof response?.status === "number" ? response.status : undefined;
}

export function getStorefrontErrorMessage(error: unknown, fallback: string): string {
  const status = getStorefrontErrorStatus(error);
  const code = getStorefrontErrorCode(error)?.toUpperCase() ?? "";
  const message = isObject(error) && typeof error.message === "string" ? error.message : fallback;

  if (status === 429 || code.includes("RATE_LIMIT")) {
    return "Too many requests were received. Wait a moment before trying again.";
  }
  if (code.includes("UNPUBLISHED") || code.includes("NOT_PUBLISHED")) {
    return "This storefront is unpublished or is no longer available.";
  }
  if (code.includes("STOCK") || code.includes("OUT_OF_STOCK")) {
    return "Stock changed while you were checking out. Review the cart and try again.";
  }
  if (code.includes("PRICE")) {
    return "A product price changed. Review the current storefront prices and try again.";
  }
  if (
    code.includes("INVALID_PRODUCT")
    || code.includes("PRODUCT_NOT_SELECTED")
    || code.includes("PRODUCT_NOT_FOUND")
    || (code.includes("PRODUCT") && code.includes("INVALID"))
  ) {
    return "A product in this cart is no longer available in this storefront. Refresh the page and review your cart.";
  }
  if (status === 404) return "This storefront is unpublished or is no longer available.";
  if (status === 409) {
    return "The cart could not be confirmed because product availability or price changed. Review the cart and try again.";
  }
  if (status === 400) {
    return message || "The request could not be accepted. Check the highlighted details and try again.";
  }
  return message;
}

export async function hashCheckoutPayload(payload: unknown): Promise<string> {
  const serialized = JSON.stringify(payload);
  const cryptoObject = globalThis.crypto;

  if (cryptoObject?.subtle && typeof TextEncoder !== "undefined") {
    try {
      const digest = await cryptoObject.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall back to the deterministic client-side fingerprint below.
    }
  }

  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}
