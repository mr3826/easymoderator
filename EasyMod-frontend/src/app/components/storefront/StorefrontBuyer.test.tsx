import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StorefrontBuyer from "./StorefrontBuyer";

const mocks = vi.hoisted(() => ({
  useParams: vi.fn(() => ({ slug: "market-one" })),
  getStore: vi.fn(),
  getProducts: vi.fn(),
  checkout: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useParams: mocks.useParams }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: "bn", language: "bn" } }),
}));
vi.mock("uuid", () => ({ v4: mocks.uuid }));
vi.mock("@/api/domains/storefront", () => ({
  getPublicStorefront: mocks.getStore,
  getPublicStorefrontProducts: mocks.getProducts,
  createStorefrontCheckout: mocks.checkout,
}));

const store = {
  slug: "market-one",
  title: "Market One",
  description: "Everyday essentials",
  logo_url: null,
  settings: { delivery_fee: 50, delivery_note: "Delivery in 2-3 days" },
};

const productRows = [{
  id: "p-1",
  name: "Cotton shirt",
  name_bn: "সুতি জামা",
  description: "Soft cotton",
  description_bn: "নরম সুতি কাপড়",
  price: 700,
  variants: [
    { id: "v-red", option_name: "রং", option_value: "লাল", price: 700 },
    { id: "v-blue", option_name: "রং", option_value: "নীল", price: 720 },
  ],
}];

const successfulOrder = {
  order_id: "order-1",
  order_number: "SM-1001",
  total: 1450,
  payment_status: "unpaid" as const,
  order_status: "confirmed" as const,
};

describe("StorefrontBuyer", () => {
  beforeEach(() => {
    mocks.useParams.mockReturnValue({ slug: "market-one" });
    mocks.getStore.mockReset().mockResolvedValue(store);
    mocks.getProducts.mockReset().mockResolvedValue(productRows);
    mocks.checkout.mockReset()
      .mockRejectedValueOnce({ statusCode: 409, code: "STOCK_CHANGED", message: "The stock changed." })
      .mockResolvedValueOnce(successfulOrder)
      .mockResolvedValueOnce({ ...successfulOrder, order_number: "SM-1002", total: 1500 });
    mocks.uuid.mockReset().mockReturnValueOnce("checkout-key-1").mockReturnValueOnce("checkout-key-2");
  });

  afterEach(() => cleanup());

  it("renders Bangla catalog fields and submits COD with idempotent retries", async () => {
    render(<StorefrontBuyer />);

    expect(await screen.findByRole("heading", { name: "Market One" })).toBeInTheDocument();
    expect(screen.getByText("সুতি জামা")).toBeInTheDocument();
    expect(screen.getByText("নরম সুতি কাপড়")).toBeInTheDocument();
    expect(mocks.getStore).toHaveBeenCalledWith("market-one");
    expect(mocks.getProducts).toHaveBeenCalledWith("market-one");

    fireEvent.change(screen.getByLabelText("ভ্যারিয়েন্ট"), { target: { value: "v-red" } });
    fireEvent.click(screen.getByRole("button", { name: "কার্টে যোগ করুন" }));
    fireEvent.change(screen.getByLabelText(/আপনার নাম/), { target: { value: "রহিম" } });
    fireEvent.change(screen.getByLabelText(/ফোন নম্বর/), { target: { value: "01700000000" } });
    fireEvent.change(screen.getByLabelText(/^জেলা/), { target: { value: "ঢাকা" } });
    fireEvent.change(screen.getByLabelText(/বিস্তারিত ঠিকানা/), { target: { value: "রোড ১" } });
    fireEvent.click(screen.getByRole("checkbox"));

    const submitButton = screen.getByRole("button", { name: "ক্যাশ অন ডেলিভারি অর্ডার করুন" });
    fireEvent.submit(submitButton.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Stock changed while you were checking out");

    fireEvent.submit(submitButton.closest("form")!);
    expect(await screen.findByText("SM-1001")).toBeInTheDocument();
    expect(screen.getByText(/সার্ভার-নিশ্চিত মোট/)).toBeInTheDocument();

    const expectedPayload = {
      customer_name: "রহিম",
      customer_phone: "01700000000",
      delivery_address: { district: "ঢাকা", street_address: "রোড ১" },
      consent: true,
      items: [{ product_id: "p-1", variant_id: "v-red", quantity: 1 }],
    };
    expect(mocks.checkout).toHaveBeenNthCalledWith(1, "market-one", expectedPayload, "checkout-key-1");
    expect(mocks.checkout).toHaveBeenNthCalledWith(2, "market-one", expectedPayload, "checkout-key-1");
    expect(expectedPayload).not.toHaveProperty("shop_id");
    expect(expectedPayload.items[0]).not.toHaveProperty("price");

    fireEvent.change(screen.getByLabelText(/আপনার নাম/), { target: { value: "করিম" } });
    fireEvent.submit(submitButton.closest("form")!);
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledTimes(3));
    expect(mocks.checkout.mock.calls[2][2]).toBe("checkout-key-2");
  });
});
