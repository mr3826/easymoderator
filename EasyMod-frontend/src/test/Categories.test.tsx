import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Categories from '@/app/components/Categories';

const { mockCategories, mockGetCategories, mockDeleteCategory, mockUpdateCategory, mockNavigate } = vi.hoisted(() => ({
  mockCategories: [] as any[],
  mockGetCategories: vi.fn(),
  mockDeleteCategory: vi.fn(),
  mockUpdateCategory: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    if (key === 'categories.deleteAria' || key === 'categories.editAria') return `${key.includes('delete') ? 'Delete' : 'Edit'} ${options?.name}`;
    if (key === 'categories.deleteModal.message') return `Delete ${options?.name}?`;
    if (key === 'categories.deleteModal.activeProductCount') return `Active products linked: ${options?.formattedCount}`;
    if (key === 'categories.deleteModal.totalAffectedProductCount') return `All linked product associations affected: ${options?.formattedCount}`;
    if (key === 'categories.deleteModal.associationsCleared') return 'Associations for active and inactive products will be cleared';
    if (key === 'categories.deleteModal.affectedChildren') return `Subcategories affected: ${options?.formattedCount}`;
    if (key === 'categories.detail.addSubcategoryFor') return `Add a subcategory to ${options?.name}`;
    if (key === 'categories.reactivateAria') return `Reactivate ${options?.name}`;
    return key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

vi.mock('@/api', () => ({
  apiClient: {
    getCategories: mockGetCategories,
    deleteCategory: mockDeleteCategory,
    updateCategory: mockUpdateCategory,
  },
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/app/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div role="dialog" aria-modal="true">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogOverlay: () => null,
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { Plus: Icon, Search: Icon, Edit2: Icon, Trash2: Icon, Loader2: Icon };
});

const fixture = () => [{
  id: 'root-a',
  name: 'Apparel',
  description: 'Clothes for all seasons',
  is_active: true,
  product_count: 5,
  affected_product_count: 7,
  subcategory_count: 1,
  subcategories: [{ id: 'child-a', name: 'Summer Shirts', description: 'Lightweight tops', is_active: false, product_count: 3, affected_product_count: 5 }],
}, {
  id: 'root-b',
  name: 'Home',
  description: 'Household goods',
  is_active: false,
  product_count: 1,
  affected_product_count: 2,
  subcategory_count: 0,
  subcategories: [],
}];

beforeEach(() => {
  mockCategories.splice(0, mockCategories.length, ...fixture());
  mockGetCategories.mockReset().mockImplementation(async () => mockCategories);
  mockDeleteCategory.mockReset().mockResolvedValue(undefined);
  mockUpdateCategory.mockReset().mockResolvedValue({});
  mockNavigate.mockReset();
});

describe('Categories workspace', () => {
  it('requests the category count projection and renders hierarchical counts and statuses', async () => {
    render(<Categories />);

    expect(await screen.findByRole('heading', { name: 'Apparel' })).toBeInTheDocument();
    expect(mockGetCategories).toHaveBeenCalledWith({ include: 'product_count', include_inactive: true });
    expect(screen.getByText('categories.columns.activeProducts: 5')).toBeInTheDocument();
    expect(screen.getByText('categories.columns.activeProducts: 3')).toBeInTheDocument();
    expect(screen.getByText('categories.columns.totalSubcategory: 1')).toBeInTheDocument();
    expect(screen.getByText('categories.status.active')).toBeInTheDocument();
    expect(screen.getAllByText('categories.status.inactive')).toHaveLength(2);
  });

  it('searches names across roots and children while preserving the hierarchy', async () => {
    render(<Categories />);
    await screen.findByRole('heading', { name: 'Apparel' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'categories.searchPlaceholder' }), { target: { value: 'Summer' } });
    expect(screen.getByRole('heading', { name: 'Apparel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Summer Shirts' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('distinguishes active counts from all linked products before safe root deletion', async () => {
    render(<Categories />);
    await screen.findByRole('heading', { name: 'Apparel' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Apparel' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Active products linked: 8')).toBeInTheDocument();
    expect(within(dialog).getByText('All linked product associations affected: 12')).toBeInTheDocument();
    expect(within(dialog).getByText('Associations for active and inactive products will be cleared')).toBeInTheDocument();
    expect(within(dialog).getByText('Subcategories affected: 1')).toBeInTheDocument();
    expect(mockDeleteCategory).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(mockDeleteCategory).toHaveBeenCalledWith('root-a'));
    expect(screen.queryByRole('heading', { name: 'Apparel' })).not.toBeInTheDocument();
  });

  it('deletes a child by its canonical ID and navigates to persisted root and child editors', async () => {
    render(<Categories />);
    await screen.findByRole('heading', { name: 'Apparel' });

    fireEvent.click(screen.getByRole('button', { name: 'Add a subcategory to Apparel' }));
    expect(mockNavigate).toHaveBeenCalledWith('/categories/create?parent=root-a');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Apparel' }));
    expect(mockNavigate).toHaveBeenCalledWith('/categories/root-a/edit');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Summer Shirts' }));
    expect(mockNavigate).toHaveBeenCalledWith('/categories/root-a/child-a');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Summer Shirts' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Active products linked: 3')).toBeInTheDocument();
    expect(within(dialog).getByText('All linked product associations affected: 5')).toBeInTheDocument();
    expect(within(dialog).getByText('Subcategories affected: 0')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(mockDeleteCategory).toHaveBeenCalledWith('child-a'));
    expect(screen.queryByRole('button', { name: 'Summer Shirts' })).not.toBeInTheDocument();
  });

  it('lists inactive roots and children and provides direct reactivation actions', async () => {
    render(<Categories />);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate Summer Shirts' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate Home' }));
    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith('root-b', { is_active: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate Summer Shirts' }));
    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith('child-a', { is_active: true }));
    expect(mockUpdateCategory).toHaveBeenCalledTimes(2);
  });
});
