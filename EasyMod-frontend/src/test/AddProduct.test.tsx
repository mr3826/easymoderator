import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import AddProduct from "../app/components/AddProduct";

const { createProduct, getCategories } = vi.hoisted(() => ({
  createProduct: vi.fn(),
  getCategories: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/api", () => ({
  apiClient: {
    createProduct,
    updateProduct: vi.fn(),
    getProduct: vi.fn(),
    getCategories,
    uploadProductImage: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("product editor route", () => {
  it("saves the create form through the single-page route", async () => {
    createProduct.mockResolvedValue({ id: "prod-123", name: "Demo Product" });
    getCategories.mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/products/add", element: <AddProduct /> },
      { path: "/products", element: <div>Products index</div> },
    ], { initialEntries: ["/products/add"] });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/products\.form\.productName/), { target: { value: "Demo Product" } });
    fireEvent.change(screen.getByLabelText(/products\.detail\.sellingPrice/), { target: { value: "99.99" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(createProduct).toHaveBeenCalledWith(expect.objectContaining({ name: "Demo Product", price: 99.99 }), expect.any(String));
    });
    expect(await screen.findByText("Products index")).toBeInTheDocument();
  });
});
