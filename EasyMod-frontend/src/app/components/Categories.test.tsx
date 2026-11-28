import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Categories from "./Categories";

const { mockGetCategories, mockUpdateCategory, mockDeleteCategory } = vi.hoisted(() => ({
  mockGetCategories: vi.fn(),
  mockUpdateCategory: vi.fn(),
  mockDeleteCategory: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const value = params.formattedCount ?? params.name;
      return value === undefined ? key : `${key}:${String(value)}`;
    },
  }),
}));

vi.mock("@/api", () => ({
  apiClient: {
    getCategories: mockGetCategories,
    updateCategory: mockUpdateCategory,
    deleteCategory: mockDeleteCategory,
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const categoryTree = [
  {
    id: "root-1",
    name: "Clothing",
    is_active: false,
    product_count: 2,
    affected_product_count: 5,
    subcategory_count: 1,
    subcategories: [{
      id: "child-1",
      name: "Shirts",
      is_active: false,
      product_count: 3,
      affected_product_count: 4,
    }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCategories.mockResolvedValue(categoryTree);
  mockUpdateCategory.mockResolvedValue({ ...categoryTree[0], is_active: true });
  mockDeleteCategory.mockResolvedValue({ success: true });
});

afterEach(() => vi.restoreAllMocks());

function renderCategories() {
  return render(<MemoryRouter><Categories /></MemoryRouter>);
}

describe("Categories workspace", () => {
  it("opts into inactive hierarchy rows and shows active plus total delete impact", async () => {
    renderCategories();

    expect(await screen.findByText("Clothing")).toBeInTheDocument();
    expect(screen.getByText("Shirts")).toBeInTheDocument();
    expect(mockGetCategories).toHaveBeenCalledWith({ include: "product_count", include_inactive: true });

    fireEvent.click(screen.getByRole("button", { name: "categories.deleteAria:Clothing" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("categories.deleteModal.activeProductCount:5")).toBeInTheDocument();
    expect(screen.getByText("categories.deleteModal.totalAffectedProductCount:9")).toBeInTheDocument();
    expect(screen.getByText("categories.deleteModal.affectedChildren:1")).toBeInTheDocument();
  });

  it("reactivates an inactive category from the management hierarchy", async () => {
    renderCategories();
    await screen.findByText("Clothing");

    fireEvent.click(screen.getByRole("button", { name: "categories.reactivateAria:Clothing" }));

    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith("root-1", { is_active: true }));
  });

  it("deletes only after confirmation", async () => {
    renderCategories();
    await screen.findByText("Clothing");
    fireEvent.click(screen.getByRole("button", { name: "categories.deleteAria:Clothing" }));
    fireEvent.click(await screen.findByRole("button", { name: "common.delete" }));

    await waitFor(() => expect(mockDeleteCategory).toHaveBeenCalledWith("root-1"));
  });
});
