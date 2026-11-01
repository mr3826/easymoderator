import { useEffect, useMemo, useState } from "react";
import { apiClient } from "@/api";
import type { Product } from "@/api/types/product";
import {
  createStorefront,
  getStorefrontManage,
  publishStorefront,
  unpublishStorefront,
  updateStorefront,
  updateStorefrontProducts,
  updateStorefrontSettings,
  type StorefrontManageRecord,
  type StorefrontSelectedProduct,
} from "@/api/domains/storefront";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  getSelectableCatalogVariants,
  getStorefrontErrorCode,
  getStorefrontErrorMessage,
  getStorefrontErrorStatus,
} from "./storefrontUtils";

type SaveState = "details" | "settings" | "products" | "publish" | "unpublish" | null;

const fieldClassName = "mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

function selectedProductMap(record: StorefrontManageRecord | null): Record<string, string[]> {
  return Object.fromEntries(
    (record?.selected_products ?? []).map((item) => [item.product_id, [...item.variant_ids]]),
  );
}

function publishedState(record: StorefrontManageRecord | null): boolean {
  return Boolean(record?.is_published ?? record?.published ?? record?.published_at ?? record?.status === "published");
}

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isManagementGateError(error: unknown): boolean {
  return getStorefrontErrorStatus(error) === 403
    || /STOREFRONT|ADD.?ON|GATE|DISABLED/i.test(getStorefrontErrorCode(error) ?? "");
}

function getManagementErrorMessage(error: unknown, fallback: string): string {
  if (getStorefrontErrorStatus(error) === 429) return getStorefrontErrorMessage(error, fallback);
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

async function fetchCatalogProducts(): Promise<Product[]> {
  return apiClient.getProducts();
}

export default function StorefrontManager() {
  const [record, setRecord] = useState<StorefrontManageRecord | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("0");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(false);
  const [managementError, setManagementError] = useState<unknown>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveState>(null);

  const activeProducts = useMemo(
    () => products.filter((product) => product.is_active ?? product.status === "active"),
    [products],
  );
  const hasStore = record !== null;
  const isPublished = publishedState(record);
  const managementDenied = managementError !== null && isManagementGateError(managementError);

  const showOperationError = (operationError: unknown, fallback: string) => {
    if (isManagementGateError(operationError)) {
      setManagementError(operationError);
      setError(null);
    } else {
      setError(getManagementErrorMessage(operationError, fallback));
    }
  };

  const applyRecord = (next: StorefrontManageRecord | null) => {
    setRecord(next);
    setTitle(next?.title ?? "");
    setSlug(next?.slug ?? "");
    setDescription(next?.description ?? "");
    setLogoUrl(next?.logo_url ?? "");
    setDeliveryFee(String(next?.settings?.delivery_fee ?? 0));
    setDeliveryNote(next?.settings?.delivery_note ?? "");
    setSelected(selectedProductMap(next));
  };

  const loadProducts = async () => {
    setProductsLoading(true);
    setProductsError(null);
    try {
      setProducts(await fetchCatalogProducts());
    } catch (loadError) {
      setProductsError(getStorefrontErrorMessage(loadError, "Could not load catalog products."));
    } finally {
      setProductsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const current = await getStorefrontManage();
        if (!active) return;
        applyRecord(current);
      } catch (loadError) {
        if (active) setManagementError(loadError);
        return;
      } finally {
        if (active) setLoading(false);
      }

      if (!active) return;
      setProductsLoading(true);
      setProductsError(null);
      try {
        const catalog = await fetchCatalogProducts();
        if (active) setProducts(catalog);
      } catch (loadError) {
        if (active) setProductsError(getStorefrontErrorMessage(loadError, "Could not load catalog products."));
      } finally {
        if (active) setProductsLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const refreshRecord = async (fallback: StorefrontManageRecord) => {
    try {
      const refreshed = await getStorefrontManage();
      applyRecord(refreshed ?? fallback);
    } catch (refreshError) {
      if (isManagementGateError(refreshError)) setManagementError(refreshError);
      applyRecord(fallback);
    }
  };

  const handleSaveDetails = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("Store title is required.");
      return;
    }
    const suppliedSlug = optionalValue(slug);
    const suppliedDescription = optionalValue(description);
    const suppliedLogoUrl = optionalValue(logoUrl);
    const storeFields = { title: title.trim(), ...(suppliedSlug ? { slug: suppliedSlug } : {}) };
    const payload = record
      ? { ...storeFields, description: description.trim(), logo_url: logoUrl.trim() }
      : {
        ...storeFields,
        ...(suppliedDescription ? { description: suppliedDescription } : {}),
        ...(suppliedLogoUrl ? { logo_url: suppliedLogoUrl } : {}),
      };
    setSaving("details");
    setError(null);
    setNotice(null);
    try {
      if (record) await updateStorefront(payload);
      else await createStorefront(payload);
      const fallback: StorefrontManageRecord = {
        ...record,
        title: payload.title,
        slug: payload.slug ?? record?.slug ?? "",
        description: payload.description ?? record?.description ?? null,
        logo_url: payload.logo_url ?? record?.logo_url ?? null,
        settings: record?.settings ?? { delivery_fee: 0, delivery_note: "" },
        selected_products: record?.selected_products ?? [],
      };
      await refreshRecord(fallback);
      setNotice("Store details saved.");
    } catch (saveError) {
      showOperationError(saveError, "Store details could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  const handleSaveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fee = Number(deliveryFee);
    if (!record) {
      setError("Save your store details before setting delivery options.");
      return;
    }
    if (!Number.isFinite(fee) || fee < 0 || fee > 50000) {
      setError("Enter a delivery fee between 0 and 50,000 BDT.");
      return;
    }
    setSaving("settings");
    setError(null);
    setNotice(null);
    try {
      await updateStorefrontSettings({ delivery_fee: fee, delivery_note: deliveryNote.trim() });
      setRecord((current) => current ? {
        ...current,
        settings: { delivery_fee: fee, delivery_note: deliveryNote.trim() },
      } : current);
      setNotice("Delivery settings saved.");
    } catch (saveError) {
      showOperationError(saveError, "Delivery settings could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  const selectedPayload = (): StorefrontSelectedProduct[] => activeProducts.flatMap((product) => {
    if (!Object.prototype.hasOwnProperty.call(selected, product.id)) return [];
    const { variants, hasUnsupportedVariants } = getSelectableCatalogVariants(product);
    if (hasUnsupportedVariants) return [];
    const selectedIds = selected[product.id] ?? [];
    return [{
      product_id: product.id,
      variant_ids: variants.length > 0 ? variants.map((variant) => variant.id).filter((id) => selectedIds.includes(id)) : [],
    }].filter((entry) => variants.length === 0 || entry.variant_ids.length > 0);
  });

  const handleSaveProducts = async () => {
    if (!record) {
      setError("Save your store details before choosing products.");
      return;
    }
    setSaving("products");
    setError(null);
    setNotice(null);
    const selected_products = selectedPayload();
    try {
      await updateStorefrontProducts({ selected_products });
      setRecord((current) => current ? { ...current, selected_products } : current);
      setNotice("Storefront products saved.");
    } catch (saveError) {
      showOperationError(saveError, "Storefront products could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  const toggleProduct = (product: Product, checked: boolean) => {
    const { variants } = getSelectableCatalogVariants(product);
    setSelected((current) => {
      const next = { ...current };
      if (!checked) delete next[product.id];
      else next[product.id] = variants.map((variant) => variant.id);
      return next;
    });
  };

  const toggleVariant = (productId: string, variantId: string, checked: boolean) => {
    setSelected((current) => {
      const nextIds = new Set(current[productId] ?? []);
      if (checked) nextIds.add(variantId);
      else nextIds.delete(variantId);
      const next = { ...current };
      if (nextIds.size) next[productId] = [...nextIds];
      else delete next[productId];
      return next;
    });
  };

  const handlePublishChange = async () => {
    if (!record) return;
    const nextAction = isPublished ? "unpublish" : "publish";
    setSaving(nextAction);
    setError(null);
    setNotice(null);
    try {
      if (isPublished) await unpublishStorefront();
      else await publishStorefront();
      setRecord((current) => current ? {
        ...current,
        is_published: !isPublished,
        published: !isPublished,
        status: isPublished ? "unpublished" : "published",
      } : current);
      setNotice(isPublished ? "Storefront unpublished." : "Storefront published.");
    } catch (publishError) {
      showOperationError(publishError, "Storefront publication could not be changed.");
    } finally {
      setSaving(null);
    }
  };

  const previewPath = slug.trim() ? `/store/${encodeURIComponent(slug.trim())}` : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-24 md:p-8">
      <header className="max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-700">Merchant storefront</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 md:text-3xl">Manage your storefront</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">Choose products from your existing active catalog and publish a simple cash-on-delivery storefront.</p>
      </header>

      <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        COD only. Online payment is not available, and courier booking or delivery automation is not included.
      </p>

      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" aria-live="polite" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</p>}

      {loading ? (
        <p role="status" aria-live="polite" className="py-12 text-center text-sm text-gray-600">Loading storefront management…</p>
      ) : managementError ? (
        managementDenied ? (
          <Card className="border-amber-300">
            <CardHeader><CardTitle className="text-lg">Storefront management is blocked</CardTitle></CardHeader>
            <CardContent className="space-y-3 pb-6 text-sm text-gray-700">
              <p>The backend denied this management request. No storefront access has been enabled here.</p>
              <p><span className="font-semibold">Backend state:</span> {getStorefrontErrorCode(managementError) ?? `HTTP ${getStorefrontErrorStatus(managementError) ?? "unknown"}`}</p>
              <p>{getStorefrontErrorMessage(managementError, "The backend did not provide an explanation.")}</p>
              {managementError && typeof managementError === "object" && "details" in managementError && managementError.details != null && (
                <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs">{JSON.stringify(managementError.details, null, 2)}</pre>
              )}
              <a href="/addons" className="inline-flex min-h-11 items-center font-semibold text-blue-700 underline underline-offset-4">Review Add-ons</a>
            </CardContent>
          </Card>
        ) : (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {getStorefrontErrorMessage(managementError, "Could not load storefront management.")}
          </p>
        )
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-lg">Store profile</CardTitle></CardHeader>
            <CardContent className="pb-6">
              <form onSubmit={(event) => void handleSaveDetails(event)} className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label htmlFor="storefront-title" className="text-sm font-medium text-gray-800">Store title <span aria-hidden="true">*</span></label>
                  <input id="storefront-title" required value={title} onChange={(event) => setTitle(event.target.value)} className={fieldClassName} />
                </div>
                <div>
                  <label htmlFor="storefront-slug" className="text-sm font-medium text-gray-800">Public URL slug</label>
                  <input id="storefront-slug" minLength={2} maxLength={80} pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" title="Use lowercase letters, numbers, and hyphens." value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} autoComplete="off" className={fieldClassName} />
                  {previewPath && <a className="mt-2 inline-block break-all text-sm text-blue-700 underline underline-offset-4" href={previewPath} target="_blank" rel="noreferrer">Preview {previewPath}</a>}
                </div>
                <div>
                  <label htmlFor="storefront-logo-url" className="text-sm font-medium text-gray-800">Logo URL</label>
                  <input id="storefront-logo-url" type="url" maxLength={2048} value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} className={fieldClassName} />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="storefront-description" className="text-sm font-medium text-gray-800">Store description</label>
                  <textarea id="storefront-description" rows={4} maxLength={3000} value={description} onChange={(event) => setDescription(event.target.value)} className={fieldClassName} />
                </div>
                <div className="md:col-span-2">
                  <button type="submit" disabled={saving !== null} className="min-h-11 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60">
                    {saving === "details" ? "Saving…" : hasStore ? "Save store profile" : "Create storefront"}
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-lg">Delivery information</CardTitle></CardHeader>
            <CardContent className="pb-6">
              <form onSubmit={(event) => void handleSaveSettings(event)} className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="storefront-delivery-fee" className="text-sm font-medium text-gray-800">Delivery fee (BDT)</label>
                  <input id="storefront-delivery-fee" type="number" min="0" max="50000" step="0.01" required value={deliveryFee} onChange={(event) => setDeliveryFee(event.target.value)} className={fieldClassName} />
                </div>
                <div>
                  <label htmlFor="storefront-delivery-note" className="text-sm font-medium text-gray-800">Delivery note</label>
                  <textarea id="storefront-delivery-note" rows={2} maxLength={250} value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} className={fieldClassName} />
                </div>
                <div className="md:col-span-2">
                  <button type="submit" disabled={!hasStore || saving !== null} className="min-h-11 rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60">
                    {saving === "settings" ? "Saving…" : "Save delivery settings"}
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Products and variants</CardTitle>
              <p className="text-sm leading-6 text-gray-600">Only active products from your existing catalog are available here. No catalog or stock records are created by this page.</p>
            </CardHeader>
            <CardContent className="space-y-4 pb-6">
              {productsLoading ? (
                <p role="status" aria-live="polite" className="text-sm text-gray-600">Loading catalog…</p>
              ) : productsError ? (
                <div className="space-y-3" role="alert">
                  <p className="text-sm text-red-800">{productsError}</p>
                  <button type="button" onClick={() => void loadProducts()} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold">Retry catalog load</button>
                </div>
              ) : activeProducts.length === 0 ? (
                <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">No active catalog products are available to add.</p>
              ) : (
                <ul className="space-y-3">
                  {activeProducts.map((product) => {
                    const { variants, hasUnsupportedVariants } = getSelectableCatalogVariants(product);
                    const selectedIds = selected[product.id] ?? [];
                    const allSelected = Object.prototype.hasOwnProperty.call(selected, product.id)
                      && (variants.length === 0 || selectedIds.length === variants.length);
                    return (
                      <li key={product.id} className="rounded-xl border border-gray-200 p-4">
                        <label className="flex min-h-11 items-start gap-3 font-semibold text-gray-900">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            disabled={hasUnsupportedVariants}
                            onChange={(event) => toggleProduct(product, event.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-700 focus:ring-blue-600"
                          />
                          <span className="min-w-0 flex-1">{product.name}<span className="ml-2 text-sm font-normal text-gray-600">৳{product.price}</span></span>
                        </label>
                        {variants.length > 0 && (
                          <fieldset className="ml-7 mt-2 space-y-1 border-l border-gray-200 pl-4">
                            <legend className="sr-only">Variants for {product.name}</legend>
                            {variants.map((variant) => (
                              <label key={variant.id} className="flex min-h-10 items-center gap-3 text-sm text-gray-700">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.includes(variant.id)}
                                  onChange={(event) => toggleVariant(product.id, variant.id, event.target.checked)}
                                  className="h-4 w-4 rounded border-gray-300 text-blue-700 focus:ring-blue-600"
                                />
                                {variant.label}
                              </label>
                            ))}
                          </fieldset>
                        )}
                        {hasUnsupportedVariants && <p className="ml-7 mt-1 text-xs text-amber-800">These catalog variants do not expose variant IDs, so they cannot be selected for this storefront.</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <button type="button" onClick={() => void handleSaveProducts()} disabled={!hasStore || saving !== null || productsLoading || productsError !== null} className="min-h-11 rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60">
                {saving === "products" ? "Saving…" : "Save selected products"}
              </button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-lg">Publication</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-gray-900">{isPublished ? "Published" : "Unpublished"}</p>
                <p className="mt-1 text-sm text-gray-600">The public page is available at <span className="break-all font-medium">{previewPath ?? "/store/:slug"}</span>.</p>
              </div>
              <button type="button" onClick={() => void handlePublishChange()} disabled={!hasStore || saving !== null} className={`min-h-11 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 ${isPublished ? "bg-gray-700 hover:bg-gray-800" : "bg-emerald-700 hover:bg-emerald-800"}`}>
                {saving === "publish" ? "Publishing…" : saving === "unpublish" ? "Unpublishing…" : isPublished ? "Unpublish storefront" : "Publish storefront"}
              </button>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
