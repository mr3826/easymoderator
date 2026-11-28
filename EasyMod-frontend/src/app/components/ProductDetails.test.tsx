import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import ProductDetails from "./ProductDetails";

const { mockGetProduct, mockDeleteProduct } = vi.hoisted(() => ({
  mockGetProduct: vi.fn(),
  mockDeleteProduct: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/api", () => ({
  apiClient: {
    getProduct: mockGetProduct,
    deleteProduct: mockDeleteProduct,
  },
}));
vi.mock("../lib/auth", () => ({ authService: { getCurrentShopId: () => "shop-1" } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const product = {
  id: "prod-1",
  name: "Canvas tote",
  price: 650,
  image_url: "https://cdn.example/primary.jpg",
  quantity: 90,
  track_quantity: true,
  status: "active" as const,
  product_variants: [
    { id: "v-active", quantity: 2, is_active: true },
    { id: "v-inactive", quantity: 50, is_active: false },
  ],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

function renderDetails() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/products/:productId", element: <ProductDetails /> },
    { path: "/products/:productId/edit", element: <div>Product editor route</div> },
    { path: "/products", element: <div>Products index</div> },
  ], { initialEntries: ["/products/prod-1"] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProduct.mockResolvedValue(product);
  mockDeleteProduct.mockResolvedValue(undefined);
});

describe("ProductDetails", () => {
  it("uses effective inventory values and falls back to image_url", async () => {
    renderDetails();

    expect(await screen.findByRole("heading", { name: "Canvas tote" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "products.detail.imageAlt" })).toHaveAttribute("src", product.image_url);
    expect(screen.getByText("2", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("common.active")).toBeInTheDocument();
  });

  it("formats BDT price values without rounding paisa", async () => {
    mockGetProduct.mockResolvedValue({
      ...product,
      price: 1250.5,
      compare_at_price: 1400.25,
      cost_per_item: 480.75,
    });
    renderDetails();

    await screen.findByRole("heading", { name: "Canvas tote" });
    expect(screen.getByText(/৳1,250\.5/)).toBeInTheDocument();
    expect(screen.getByText("৳1,400.25")).toBeInTheDocument();
    expect(screen.getByText("৳480.75")).toBeInTheDocument();
  });

  it("navigates to the route editor instead of opening an edit modal", async () => {
    renderDetails();
    await screen.findByRole("heading", { name: "Canvas tote" });
    fireEvent.click(screen.getByRole("button", { name: "common.edit" }));

    expect(await screen.findByText("Product editor route")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires explicit confirmation before deleting", async () => {
    renderDetails();
    await screen.findByRole("heading", { name: "Canvas tote" });
    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("products.deleteModal.title")).toBeInTheDocument();
    expect(mockDeleteProduct).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "common.delete" }));

    await waitFor(() => expect(mockDeleteProduct).toHaveBeenCalledWith("prod-1"));
    expect(await screen.findByText("Products index")).toBeInTheDocument();
  });
});
