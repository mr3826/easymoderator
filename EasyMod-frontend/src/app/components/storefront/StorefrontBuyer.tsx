import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { v4 as uuidv4 } from "uuid";
import {
  createStorefrontCheckout,
  getPublicStorefront,
  getPublicStorefrontProducts,
  type StorefrontCheckoutPayload,
  type StorefrontCheckoutResult,
  type StorefrontDetails,
} from "@/api/domains/storefront";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  getStorefrontErrorMessage,
  hashCheckoutPayload,
  localizedProductText,
  normalizePublicProductRows,
  type DisplayStorefrontProduct,
} from "./storefrontUtils";

interface CartItem {
  productId: string;
  variantId?: string;
  quantity: number;
}

interface BuyerDetails {
  customerName: string;
  customerPhone: string;
  division: string;
  district: string;
  upazila: string;
  streetAddress: string;
  zone: string;
  consent: boolean;
}

const initialBuyer: BuyerDetails = {
  customerName: "",
  customerPhone: "",
  division: "",
  district: "",
  upazila: "",
  streetAddress: "",
  zone: "",
  consent: false,
};

const fieldClassName = "mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

function productPrice(product: DisplayStorefrontProduct, variantId?: string): number | null {
  const variant = variantId ? product.variants.find((item) => item.id === variantId) : undefined;
  const value = variant?.price ?? product.price;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function itemKey(item: Pick<CartItem, "productId" | "variantId">): string {
  return `${item.productId}:${item.variantId ?? ""}`;
}

function formatMoney(value: number, language: string): string {
  return new Intl.NumberFormat(language.toLowerCase().startsWith("bn") ? "bn-BD" : "en-BD", {
    style: "currency",
    currency: "BDT",
    maximumFractionDigits: 2,
  }).format(value);
}

export default function StorefrontBuyer() {
  const { slug } = useParams<{ slug: string }>();
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const isBangla = language.toLowerCase().startsWith("bn");
  const [store, setStore] = useState<StorefrontDetails | null>(null);
  const [products, setProducts] = useState<DisplayStorefrontProduct[]>([]);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [buyer, setBuyer] = useState<BuyerDetails>(initialBuyer);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState<StorefrontCheckoutResult | null>(null);
  const requestIdentity = useRef<{ payloadHash: string; key: string } | null>(null);

  useEffect(() => {
    let active = true;
    if (!slug) {
      setLoadError(isBangla ? "এই স্টোরফ্রন্টের ঠিকানা পাওয়া যায়নি।" : "This storefront URL is incomplete.");
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setLoadError(null);
    Promise.all([getPublicStorefront(slug), getPublicStorefrontProducts(slug)])
      .then(([storeData, productRows]) => {
        if (!active) return;
        setStore(storeData);
        setProducts(normalizePublicProductRows(productRows));
      })
      .catch((loadFailure) => {
        if (active) setLoadError(getStorefrontErrorMessage(
          loadFailure,
          isBangla ? "স্টোরফ্রন্ট লোড করা যায়নি। পরে আবার চেষ্টা করুন।" : "This storefront could not be loaded. Try again later.",
        ));
      })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [slug, isBangla]);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const updateBuyer = (key: keyof BuyerDetails, value: string | boolean) => {
    setBuyer((current) => ({ ...current, [key]: value }));
    setOrder(null);
    setCheckoutError(null);
  };

  const addToCart = (product: DisplayStorefrontProduct) => {
    const variantId = product.variants.length > 0 ? selectedVariants[product.id] : undefined;
    if (product.variants.length > 0 && !variantId) return;
    if (product.hasUnsupportedVariants || productPrice(product, variantId) === null) return;
    setCart((current) => {
      const key = itemKey({ productId: product.id, variantId });
      const existing = current.find((item) => itemKey(item) === key);
      if (!existing) return [...current, { productId: product.id, variantId, quantity: 1 }];
      return current.map((item) => itemKey(item) === key ? { ...item, quantity: item.quantity + 1 } : item);
    });
    setOrder(null);
    setCheckoutError(null);
  };

  const changeQuantity = (item: CartItem, quantity: number) => {
    if (!Number.isInteger(quantity) || quantity < 1) return;
    setCart((current) => current.map((entry) => itemKey(entry) === itemKey(item) ? { ...entry, quantity } : entry));
    setOrder(null);
    setCheckoutError(null);
  };

  const removeFromCart = (item: CartItem) => {
    setCart((current) => current.filter((entry) => itemKey(entry) !== itemKey(item)));
    setOrder(null);
    setCheckoutError(null);
  };

  const submitCheckout = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !slug
      || cart.length === 0
      || !buyer.customerName.trim()
      || !buyer.customerPhone.trim()
      || !buyer.district.trim()
      || !buyer.upazila.trim()
      || !buyer.streetAddress.trim()
      || !buyer.consent
    ) {
      setCheckoutError(isBangla
        ? "নাম, ফোন, জেলা, এলাকা/থানা, বিস্তারিত ঠিকানা এবং সম্মতি পূরণ করে কার্টে পণ্য যোগ করুন।"
        : "Enter your name, phone, district, delivery area/thana and street address, add a cart item, and give the required consent.");
      return;
    }
    if (!/^01[3-9]\d{8}$/.test(buyer.customerPhone.trim())) {
      setCheckoutError(isBangla
        ? "সঠিক ১১ সংখ্যার বাংলাদেশি মোবাইল নম্বর দিন (01 দিয়ে শুরু)।"
        : "Enter a valid 11-digit Bangladesh mobile number starting with 01.");
      return;
    }
    if (buyer.streetAddress.trim().length < 5) {
      setCheckoutError(isBangla
        ? "বিস্তারিত ঠিকানায় অন্তত ৫টি অক্ষর লিখুন।"
        : "Enter at least 5 characters for the street address.");
      return;
    }

    const payload: StorefrontCheckoutPayload = {
      customer_name: buyer.customerName.trim(),
      customer_phone: buyer.customerPhone.trim(),
      delivery_address: {
        ...(buyer.division.trim() ? { division: buyer.division.trim() } : {}),
        district: buyer.district.trim(),
        upazila: buyer.upazila.trim(),
        area: buyer.upazila.trim(),
        street_address: buyer.streetAddress.trim(),
        ...(buyer.zone.trim() ? { zone: buyer.zone.trim() } : {}),
      },
      consent: true,
      items: cart.map((item) => ({
        product_id: item.productId,
        ...(item.variantId ? { variant_id: item.variantId } : {}),
        quantity: item.quantity,
      })),
    };

    setSubmitting(true);
    setCheckoutError(null);
    try {
      const payloadHash = await hashCheckoutPayload({ slug, payload });
      const existing = requestIdentity.current;
      const key = existing?.payloadHash === payloadHash ? existing.key : uuidv4();
      requestIdentity.current = { payloadHash, key };
      setOrder(await createStorefrontCheckout(slug, payload, key));
    } catch (checkoutFailure) {
      setCheckoutError(getStorefrontErrorMessage(
        checkoutFailure,
        isBangla ? "অর্ডার পাঠানো যায়নি। একই তথ্য দিয়ে আবার চেষ্টা করুন।" : "Your order could not be submitted. Retry with the same details.",
      ));
    } finally {
      setSubmitting(false);
    }
  };

  const visibleOrder = order;
  const fee = Number(store?.settings?.delivery_fee ?? 0);
  const deliveryNote = store?.settings?.delivery_note?.trim();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 pb-16 md:p-8">
      {loading ? (
        <p role="status" aria-live="polite" className="py-16 text-center text-sm text-gray-600">{isBangla ? "স্টোরফ্রন্ট লোড হচ্ছে…" : "Loading storefront…"}</p>
      ) : loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-900">{loadError}</div>
      ) : store ? (
        <>
          <header className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
            <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center md:p-8">
              {store.logo_url && <img src={store.logo_url} alt={`${store.title} logo`} className="h-20 w-20 rounded-xl object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-700">{isBangla ? "ক্যাশ অন ডেলিভারি" : "Cash on delivery"}</p>
                <h1 className="mt-2 text-2xl font-bold text-gray-900 md:text-3xl">{store.title}</h1>
                {store.description && <p className="mt-2 max-w-3xl whitespace-pre-line text-sm leading-6 text-gray-600">{store.description}</p>}
              </div>
            </div>
            <div className="border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-700 md:px-8">
              <p>{isBangla ? "ডেলিভারি ফি" : "Delivery fee"}: {formatMoney(Number.isFinite(fee) ? fee : 0, language)}</p>
              {deliveryNote && <p className="mt-1">{deliveryNote}</p>}
              <p className="mt-1 font-medium">{isBangla ? "অনলাইন পেমেন্ট নেই। কুরিয়ার বুকিং স্বয়ংক্রিয় নয়।" : "No online payment. Courier booking is not automated."}</p>
            </div>
          </header>

          <section aria-labelledby="storefront-catalog-heading">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-500">{isBangla ? "পণ্য তালিকা" : "Catalog"}</p>
                <h2 id="storefront-catalog-heading" className="mt-1 text-xl font-bold text-gray-900">{isBangla ? "পণ্য বেছে নিন" : "Choose products"}</h2>
              </div>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">{isBangla ? "COD অর্ডার" : "COD order"}</span>
            </div>
            {products.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600">{isBangla ? "এই স্টোরে এখন কোনো পণ্য নেই।" : "There are no products in this storefront right now."}</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => {
                  const localized = localizedProductText(product, language);
                  const variantId = selectedVariants[product.id];
                  const currentPrice = productPrice(product, variantId);
                  const canAdd = !product.hasUnsupportedVariants
                    && (product.variants.length === 0 || Boolean(variantId))
                    && currentPrice !== null;
                  const image = product.image_url || product.images?.[0];
                  return (
                    <li key={product.id}>
                      <Card className="h-full overflow-hidden">
                        {image && <img src={image} alt="" className="aspect-[4/3] w-full bg-gray-100 object-cover" loading="lazy" />}
                        <CardHeader className="gap-2">
                          <CardTitle className="text-base font-semibold text-gray-900">{localized.name}</CardTitle>
                          {localized.description && <p className="text-sm leading-5 text-gray-600">{localized.description}</p>}
                          <p className="text-sm font-semibold text-gray-900">
                            {currentPrice === null
                              ? (isBangla ? "দাম পাওয়া যায়নি" : "Price unavailable")
                              : formatMoney(currentPrice, language)}
                          </p>
                        </CardHeader>
                        <CardContent className="space-y-3 pb-6">
                          {product.variants.length > 0 && (
                            <div>
                              <label htmlFor={`variant-${product.id}`} className="text-sm font-medium text-gray-800">{isBangla ? "ভ্যারিয়েন্ট" : "Variant"}</label>
                              <select
                                id={`variant-${product.id}`}
                                value={variantId ?? ""}
                                onChange={(event) => {
                                  setSelectedVariants((current) => ({ ...current, [product.id]: event.target.value }));
                                  setOrder(null);
                                  setCheckoutError(null);
                                }}
                                className={fieldClassName}
                              >
                                <option value="">{isBangla ? "একটি ভ্যারিয়েন্ট বেছে নিন" : "Choose a variant"}</option>
                                {product.variants.map((variant) => (
                                  <option key={variant.id} value={variant.id}>
                                    {variant.option_name}: {variant.option_value} · {Number.isFinite(Number(variant.price))
                                      ? formatMoney(Number(variant.price), language)
                                      : (isBangla ? "দাম পাওয়া যায়নি" : "Price unavailable")}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          {product.hasUnsupportedVariants && <p className="text-xs text-amber-800">{isBangla ? "এই পণ্যের ভ্যারিয়েন্ট বেছে নেওয়া যাচ্ছে না।" : "This product has variants that are not available for selection."}</p>}
                          <button type="button" onClick={() => addToCart(product)} disabled={!canAdd} className="min-h-11 w-full rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
                            {isBangla ? "কার্টে যোগ করুন" : "Add to cart"}
                          </button>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {cart.length > 0 && (
            <section aria-labelledby="storefront-cart-heading" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <Card>
                <CardHeader><CardTitle id="storefront-cart-heading" className="text-lg">{isBangla ? "আপনার কার্ট" : "Your cart"}</CardTitle></CardHeader>
                <CardContent className="space-y-4 pb-6">
                  <ul className="divide-y divide-gray-200">
                    {cart.map((item) => {
                      const product = productsById.get(item.productId);
                      if (!product) return null;
                      const localized = localizedProductText(product, language);
                      const variant = item.variantId ? product.variants.find((entry) => entry.id === item.variantId) : undefined;
                      return (
                        <li key={itemKey(item)} className="flex flex-wrap items-center gap-3 py-4 first:pt-0">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-gray-900">{localized.name}</p>
                            {variant && <p className="text-xs text-gray-600">{variant.option_name}: {variant.option_value}</p>}
                            <p className="mt-1 text-sm text-gray-700">{formatMoney(productPrice(product, item.variantId) ?? 0, language)} each</p>
                          </div>
                          <label className="text-xs font-medium text-gray-700">
                            {isBangla ? "পরিমাণ" : "Quantity"}
                            <input aria-label={`${isBangla ? "পরিমাণ" : "Quantity"}: ${localized.name}`} type="number" min="1" step="1" value={item.quantity} onChange={(event) => changeQuantity(item, Number(event.target.value))} className="mt-1 min-h-10 w-20 rounded-lg border border-gray-300 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600" />
                          </label>
                          <button type="button" onClick={() => removeFromCart(item)} className="min-h-10 rounded-lg px-2 text-sm font-semibold text-red-700 underline underline-offset-4">
                            {isBangla ? "সরান" : "Remove"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="rounded-lg bg-gray-50 p-3 text-sm leading-5 text-gray-700">
                    <p>{isBangla ? "পণ্যের তালিকাভুক্ত দাম দেখানো হচ্ছে। চূড়ান্ত মোট অর্ডার নিশ্চিত হলে সার্ভার জানাবে।" : "Listed product prices are shown. The server confirms the final amount after the order is accepted."}</p>
                    <p className="mt-1">{isBangla ? "ডেলিভারি ফি" : "Delivery fee"}: {formatMoney(Number.isFinite(fee) ? fee : 0, language)}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-lg">{isBangla ? "ডেলিভারির তথ্য" : "Delivery details"}</CardTitle></CardHeader>
                <CardContent className="pb-6">
                  <form onSubmit={(event) => void submitCheckout(event)} className="space-y-4">
                    <div>
                      <label htmlFor="buyer-name" className="text-sm font-medium text-gray-800">{isBangla ? "আপনার নাম" : "Your name"} <span aria-hidden="true">*</span></label>
                      <input id="buyer-name" required maxLength={100} autoComplete="name" value={buyer.customerName} onChange={(event) => updateBuyer("customerName", event.target.value)} className={fieldClassName} />
                    </div>
                    <div>
                      <label htmlFor="buyer-phone" className="text-sm font-medium text-gray-800">{isBangla ? "ফোন নম্বর" : "Phone number"} <span aria-hidden="true">*</span></label>
                      <input id="buyer-phone" required type="tel" minLength={11} maxLength={11} pattern="01[3-9][0-9]{8}" title="Enter an 11-digit Bangladesh mobile number starting with 01." autoComplete="tel" value={buyer.customerPhone} onChange={(event) => updateBuyer("customerPhone", event.target.value)} className={fieldClassName} />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="buyer-division" className="text-sm font-medium text-gray-800">{isBangla ? "বিভাগ (ঐচ্ছিক)" : "Division (optional)"}</label>
                        <input id="buyer-division" maxLength={100} autoComplete="address-level1" value={buyer.division} onChange={(event) => updateBuyer("division", event.target.value)} className={fieldClassName} />
                      </div>
                      <div>
                        <label htmlFor="buyer-district" className="text-sm font-medium text-gray-800">{isBangla ? "জেলা" : "District"} <span aria-hidden="true">*</span></label>
                        <input id="buyer-district" required maxLength={100} autoComplete="address-level2" value={buyer.district} onChange={(event) => updateBuyer("district", event.target.value)} className={fieldClassName} />
                      </div>
                      <div>
                        <label htmlFor="buyer-upazila" className="text-sm font-medium text-gray-800">{isBangla ? "এলাকা / থানা / উপজেলা" : "Delivery area / thana / upazila"} <span aria-hidden="true">*</span></label>
                        <input id="buyer-upazila" required maxLength={100} value={buyer.upazila} onChange={(event) => updateBuyer("upazila", event.target.value)} className={fieldClassName} />
                      </div>
                      <div>
                        <label htmlFor="buyer-zone" className="text-sm font-medium text-gray-800">{isBangla ? "এলাকা / জোন (ঐচ্ছিক)" : "Zone (optional)"}</label>
                        <input id="buyer-zone" maxLength={50} value={buyer.zone} onChange={(event) => updateBuyer("zone", event.target.value)} className={fieldClassName} />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="buyer-street-address" className="text-sm font-medium text-gray-800">{isBangla ? "বিস্তারিত ঠিকানা" : "Street address"} <span aria-hidden="true">*</span></label>
                      <textarea id="buyer-street-address" required minLength={5} maxLength={500} autoComplete="street-address" rows={3} value={buyer.streetAddress} onChange={(event) => updateBuyer("streetAddress", event.target.value)} className={fieldClassName} />
                    </div>
                    <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 text-sm leading-6 text-gray-800">
                      <input type="checkbox" required checked={buyer.consent} onChange={(event) => updateBuyer("consent", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-700 focus:ring-blue-600" />
                      <span>{isBangla
                        ? "আমি সম্মতি দিচ্ছি যে দোকানটি শুধুমাত্র এই ক্যাশ-অন-ডেলিভারি অর্ডার পূরণের জন্য আমার দেওয়া তথ্য পাবে। এটি মার্কেটিং সম্মতি নয়।"
                        : "I agree that this shop receives these details only to fulfil this cash-on-delivery order. This is not marketing consent."}</span>
                    </label>
                    {checkoutError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-5 text-red-900">{checkoutError}</p>}
                    {visibleOrder && (
                      <div role="status" aria-live="polite" aria-atomic="true" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
                        <h3 className="font-semibold">{isBangla ? "অর্ডার নিশ্চিত" : "Order confirmed"}</h3>
                        <p className="mt-2">{isBangla ? "অর্ডার নম্বর" : "Order number"}: <strong>{visibleOrder.order_number}</strong></p>
                        <p>{isBangla ? "অর্ডারের অবস্থা" : "Order status"}: {visibleOrder.order_status}</p>
                        <p>{isBangla ? "পেমেন্টের অবস্থা" : "Payment status"}: {visibleOrder.payment_status}</p>
                        <p>{isBangla ? "সার্ভার-নিশ্চিত মোট" : "Server-confirmed total"}: {formatMoney(visibleOrder.total, language)}</p>
                      </div>
                    )}
                    <button type="submit" disabled={submitting} className="min-h-12 w-full rounded-lg bg-emerald-700 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">
                      {submitting
                        ? (isBangla ? "অর্ডার পাঠানো হচ্ছে…" : "Submitting order…")
                        : (isBangla ? "ক্যাশ অন ডেলিভারি অর্ডার করুন" : "Place cash-on-delivery order")}
                    </button>
                    <p className="text-xs leading-5 text-gray-600">{isBangla ? "কোনো অনলাইন পেমেন্ট নেওয়া হবে না। কুরিয়ার বুকিং স্বয়ংক্রিয় নয়।" : "No online payment will be taken. Courier booking is not automated."}</p>
                  </form>
                </CardContent>
              </Card>
            </section>
          )}
        </>
      ) : null}
    </main>
  );
}
