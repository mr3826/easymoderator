import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import AddProduct from "./AddProduct";

const { mockCreateProduct, mockUpdateProduct, mockGetProduct, mockGetCategories, mockUploadProductImage } = vi.hoisted(() => ({
  mockCreateProduct: vi.fn(),
  mockUpdateProduct: vi.fn(),
  mockGetProduct: vi.fn(),
  mockGetCategories: vi.fn(),
  mockUploadProductImage: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/api", () => ({
  apiClient: {
    createProduct: mockCreateProduct,
    updateProduct: mockUpdateProduct,
    getProduct: mockGetProduct,
    getCategories: mockGetCategories,
    uploadProductImage: mockUploadProductImage,
  },
}));

vi.mock("../lib/downscaleImage", () => ({ downscaleImage: vi.fn().mockResolvedValue("data:image/jpeg;base64,abc") }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const baseProduct = {
  id: "prod-1",
  name: "Test T-Shirt",
  price: 299,
  sku: "SKU-001",
  description: "A great shirt",
  category_id: "cat-1",
  quantity: 50,
  track_quantity: true,
  low_stock_threshold: 5,
  is_active: true,
  tags: ["cotton"],
  variants: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([
    { path: "/products/add", element: <AddProduct /> },
    { path: "/products/:productId/edit", element: <AddProduct /> },
    { path: "/products/:productId", element: <div>Product detail destination</div> },
    { path: "/products", element: <div>Products index destination</div> },
  ], { initialEntries: [path] });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, queryClient };
}

function fillRequiredFields(name = "New product", price = "500") {
  fireEvent.change(screen.getByLabelText(/products\.form\.productName/), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/products\.detail\.sellingPrice/), { target: { value: price } });
}

function saveButton() {
  return screen.getByRole("button", { name: "common.save" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateProduct.mockResolvedValue({ ...baseProduct, id: "created-1" });
  mockUpdateProduct.mockResolvedValue(baseProduct);
  mockGetProduct.mockResolvedValue(baseProduct);
  mockGetCategories.mockResolvedValue([
    { id: "cat-1", name: "Clothing", parent_id: null, created_at: "", updated_at: "" },
    { id: "cat-2", name: "Shirts", parent_id: "cat-1", is_active: false, created_at: "", updated_at: "" },
  ]);
  mockUploadProductImage.mockResolvedValue("https://cdn.example/image.jpg");
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn() });
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AddProduct route editor", () => {
  it("renders one save action and only contract-supported controls", async () => {
    renderAt("/products/add");

    expect(await screen.findByRole("heading", { name: "products.form.essentials" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "common.save" })).toHaveLength(1);
    expect(screen.getByLabelText(/products\.form\.productName/)).toBeRequired();
    expect(screen.getByLabelText(/products\.detail\.sellingPrice/)).toBeRequired();
    expect(screen.queryByText(/products\.form\.(productCondition|warrantyInfo|expiryDate|packageDimensions|shippingClass|handlingTime|freeShipping|allowDiscounts|chargeTax|sendLowStockAlerts)/)).not.toBeInTheDocument();
  });

  it("creates a normalized payload without unsupported fields", async () => {
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });
    fillRequiredFields("  Handloom kurta ", "1200");
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockCreateProduct).toHaveBeenCalledTimes(1));
    const payload = mockCreateProduct.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      name: "Handloom kurta",
      price: 1200,
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
    }));
    expect(payload).not.toHaveProperty("variants");
    expect(mockCreateProduct.mock.calls[0][1]).toEqual(expect.any(String));
    for (const field of ["condition", "warranty", "expiry_date", "dimensions", "shipping_class", "handling_time", "free_shipping", "allow_discounts", "charge_tax", "send_low_stock_alert", "ai_generated", "confidence"]) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it("loads the authoritative edit product and submits only dirty fields including explicit clears", async () => {
    mockGetProduct.mockResolvedValue({
      ...baseProduct,
      images: ["https://cdn.example/one.jpg", "https://cdn.example/two.jpg"],
      variants: [{ name: "Size", options: ["S", "M"], price_adjustment: 0, sku: "SIZE" }],
    });
    renderAt("/products/prod-1/edit");

    expect(await screen.findByDisplayValue("Test T-Shirt")).toBeInTheDocument();
    expect(mockGetProduct).toHaveBeenCalledWith("prod-1");
    expect(screen.getByLabelText("products.form.priceAdjustment")).not.toBeVisible();
    fireEvent.click(screen.getByText("products.form.catalogMetadata"));
    expect(screen.getByLabelText("products.form.priceAdjustment")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("common.description"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("products.columns.category"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "products.form.clearImages" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockUpdateProduct).toHaveBeenCalledTimes(1));
    expect(mockUpdateProduct).toHaveBeenCalledWith("prod-1", {
      description: null,
      category_id: null,
      images: [],
      image_url: null,
    });
    expect(mockCreateProduct).not.toHaveBeenCalled();
  });

  it("keeps an inactive category association selectable with its hierarchy path", async () => {
    mockGetProduct.mockResolvedValue({ ...baseProduct, category_id: "cat-2" });
    renderAt("/products/prod-1/edit");

    const category = await screen.findByLabelText("products.columns.category") as HTMLSelectElement;
    expect(category.value).toBe("cat-2");
    expect(screen.getByRole("option", { name: "Clothing / Shirts (products.form.inactiveCategory)" })).toBeInTheDocument();
    expect(mockGetCategories).toHaveBeenCalledWith({ include_inactive: true });
  });

  it("shows field-level validation and keeps name and price as the only required values", async () => {
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });

    fireEvent.click(saveButton());

    expect(await screen.findByText("products.form.errors.nameRequired")).toBeInTheDocument();
    expect(screen.getByText("products.form.errors.priceInvalid")).toBeInTheDocument();
    expect(mockCreateProduct).not.toHaveBeenCalled();

    fillRequiredFields("Valid", "20");
    fireEvent.change(screen.getByLabelText(/products\.form\.lowStockThreshold/), { target: { value: "1.5" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("products.form.errors.thresholdInvalid")).toBeInTheDocument();
    expect(mockCreateProduct).not.toHaveBeenCalled();
  });

  it("focuses a blank variant group name before submitting option metadata", async () => {
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });
    fillRequiredFields("Variant product", "50");
    fireEvent.click(screen.getByRole("button", { name: "products.form.addVariantGroup" }));
    fireEvent.click(saveButton());

    expect(await screen.findByText("products.form.errors.variantNameRequired")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("products.form.variantName")));
    expect(mockCreateProduct).not.toHaveBeenCalled();
  });

  it("prevents synchronous duplicate create submissions", async () => {
    let release: ((product: typeof baseProduct) => void) | undefined;
    mockCreateProduct.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });
    fillRequiredFields("One request", "100");

    act(() => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });
    expect(mockCreateProduct).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.(baseProduct);
    });
  });

  it("keeps entered values after a failed save so the request can be retried", async () => {
    mockCreateProduct
      .mockRejectedValueOnce(new Error("Temporary save failure"))
      .mockResolvedValueOnce({ ...baseProduct, id: "created-after-retry" });
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });
    fillRequiredFields("Recoverable product", "77");
    fireEvent.click(saveButton());

    expect(await screen.findByText("Temporary save failure")).toBeInTheDocument();
    expect(screen.getByLabelText(/products\.form\.productName/)).toHaveValue("Recoverable product");
    expect(screen.getByLabelText(/products\.detail\.sellingPrice/)).toHaveValue(77);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockCreateProduct).toHaveBeenCalledTimes(2));
    expect(mockCreateProduct.mock.calls[0][1]).toBe(mockCreateProduct.mock.calls[1][1]);
  });

  it("blocks saving during image upload, shows progress, and retries a failed upload", async () => {
    let failFirstUpload: (() => void) | undefined;
    mockUploadProductImage
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        failFirstUpload = () => reject(new Error("Temporary upload error"));
      }))
      .mockResolvedValueOnce("https://cdn.example/retried.jpg");
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });

    const picker = screen.getByLabelText("products.form.chooseFiles") as HTMLInputElement;
    const image = new File(["image"], "shirt.jpg", { type: "image/jpeg" });
    fireEvent.change(picker, { target: { files: [image] } });
    expect(await screen.findByText("products.form.imagesStillUploading")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "products.form.imageUploading" })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(mockCreateProduct).not.toHaveBeenCalled();

    await waitFor(() => expect(mockUploadProductImage).toHaveBeenCalledTimes(1));
    await act(async () => { failFirstUpload?.(); });
    await waitFor(() => expect(screen.getByText("Temporary upload error")).toBeInTheDocument());
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(mockUploadProductImage).toHaveBeenCalledTimes(2));

    fillRequiredFields("Image item", "50");
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockCreateProduct).toHaveBeenCalledWith(expect.objectContaining({
      images: ["https://cdn.example/retried.jpg"],
      image_url: "https://cdn.example/retried.jpg",
    }), expect.any(String)));
  });

  it("keeps new uploads interleaved with existing images and updates the primary image", async () => {
    mockGetProduct.mockResolvedValue({
      ...baseProduct,
      images: ["https://cdn.example/first.jpg", "https://cdn.example/second.jpg"],
    });
    mockUploadProductImage.mockResolvedValue("https://cdn.example/new.jpg");
    renderAt("/products/prod-1/edit");
    await screen.findByDisplayValue("Test T-Shirt");

    const image = new File(["new image"], "new.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("products.form.chooseFiles"), { target: { files: [image] } });
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(3));
    expect(mockUploadProductImage).toHaveBeenCalledTimes(1);

    let earlierButtons = screen.getAllByRole("button", { name: "products.form.moveImageEarlier" });
    fireEvent.click(earlierButtons[2]);
    earlierButtons = screen.getAllByRole("button", { name: "products.form.moveImageEarlier" });
    fireEvent.click(earlierButtons[1]);
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "https://cdn.example/new.jpg");
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockUpdateProduct).toHaveBeenCalledWith("prod-1", {
      images: ["https://cdn.example/new.jpg", "https://cdn.example/first.jpg", "https://cdn.example/second.jpg"],
      image_url: "https://cdn.example/new.jpg",
    }));
  });

  it("blocks SPA navigation and beforeunload until changes are discarded", async () => {
    renderAt("/products/add");
    await screen.findByRole("heading", { name: "products.form.essentials" });
    fireEvent.change(screen.getByLabelText(/products\.form\.productName/), { target: { value: "Unsaved" } });

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(await screen.findByRole("alertdialog", { name: "products.form.unsavedChangesTitle" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "products.form.stayOnEditor" }));
    expect(screen.getByRole("heading", { name: "products.form.essentials" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "products.form.discardChanges" }));
    expect(await screen.findByText("Products index destination")).toBeInTheDocument();
  });

  it("keeps relational variants read-only and preserves their precedence", async () => {
    mockGetProduct.mockResolvedValue({
      ...baseProduct,
      product_variants: [{ id: "rel-1", quantity: 4, is_active: true, option_name: "Size", option_value: "M" }],
      variants: [{ name: "Color", options: ["Blue"] }],
    });
    renderAt("/products/prod-1/edit");

    expect(await screen.findByText("products.form.relationalVariantPrecedence")).toBeInTheDocument();
    expect(screen.getByText("Size: M")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "products.form.addVariantGroup" })).not.toBeInTheDocument();
  });

  it("preserves legacy string variants without rendering controls that rewrite them", async () => {
    mockGetProduct.mockResolvedValue({ ...baseProduct, variants: ["Small", "Large"] });
    renderAt("/products/prod-1/edit");

    expect(await screen.findByText("products.form.legacyVariantsReadOnly")).toBeInTheDocument();
    expect(screen.getByText("Small")).toBeInTheDocument();
    expect(screen.getByText("Large")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "products.form.addVariantGroup" })).not.toBeInTheDocument();
  });
});
