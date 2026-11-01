import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StorefrontManager from "./StorefrontManager";

const mocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  getManage: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateSettings: vi.fn(),
  updateProducts: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
}));

vi.mock("@/api", () => ({ apiClient: { getProducts: mocks.getCatalog } }));
vi.mock("@/api/domains/storefront", () => ({
  getStorefrontManage: mocks.getManage,
  createStorefront: mocks.create,
  updateStorefront: mocks.update,
  updateStorefrontSettings: mocks.updateSettings,
  updateStorefrontProducts: mocks.updateProducts,
  publishStorefront: mocks.publish,
  unpublishStorefront: mocks.unpublish,
}));

const existingStore = {
  id: "store-1",
  slug: "market-one",
  title: "Market One",
  description: "Local goods",
  logo_url: null,
  settings: { delivery_fee: 55, delivery_note: "Call first" },
  selected_products: [],
  is_published: false,
};

describe("StorefrontManager", () => {
  beforeEach(() => {
    mocks.getCatalog.mockReset().mockResolvedValue([
      {
        id: "p-1", name: "Cotton shirt", price: 500, status: "active", is_active: true,
        product_variants: [{ id: "v-1", option_name: "Size", option_value: "M", price: 500 }],
      },
      { id: "p-2", name: "Inactive shirt", price: 200, status: "inactive", is_active: false },
    ]);
    mocks.getManage.mockReset().mockResolvedValue(existingStore);
    mocks.create.mockReset().mockResolvedValue(undefined);
    mocks.update.mockReset().mockResolvedValue(undefined);
    mocks.updateSettings.mockReset().mockResolvedValue(undefined);
    mocks.updateProducts.mockReset().mockResolvedValue(undefined);
    mocks.publish.mockReset().mockResolvedValue(undefined);
    mocks.unpublish.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("loads active catalog products and persists selected variant IDs", async () => {
    render(<StorefrontManager />);

    expect(await screen.findByText("Cotton shirt")).toBeInTheDocument();
    expect(screen.queryByText("Inactive shirt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Size: M"));
    fireEvent.click(screen.getByRole("button", { name: "Save selected products" }));

    await waitFor(() => {
      expect(mocks.updateProducts).toHaveBeenCalledWith({
        selected_products: [{ product_id: "p-1", variant_ids: ["v-1"] }],
      });
    });
    expect(mocks.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("shows the backend gate state and Add-ons link without loading catalog data", async () => {
    mocks.getManage.mockRejectedValueOnce({
      statusCode: 403,
      code: "STOREFRONT_ADDON_DISABLED",
      message: "This shop has not enabled the storefront add-on.",
      details: { enabled: false },
    });

    render(<StorefrontManager />);

    expect(await screen.findByRole("heading", { name: "Storefront management is blocked" })).toBeInTheDocument();
    expect(screen.getByText("STOREFRONT_ADDON_DISABLED")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review Add-ons" })).toHaveAttribute("href", "/addons");
    expect(mocks.getCatalog).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a new store with only supported non-empty optional fields", async () => {
    mocks.getManage.mockResolvedValue(null);
    render(<StorefrontManager />);

    const title = await screen.findByLabelText(/Store title/);
    fireEvent.change(title, { target: { value: "  Fresh Market  " } });
    fireEvent.change(screen.getByLabelText("Public URL slug"), { target: { value: "fresh-market" } });
    fireEvent.submit(title.closest("form")!);

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({ title: "Fresh Market", slug: "fresh-market" });
    });
  });
});
