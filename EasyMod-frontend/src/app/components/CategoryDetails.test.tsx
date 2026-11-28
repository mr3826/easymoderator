import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CategoryDetails from './CategoryDetails';

const { mockState, mockGetCategory, mockCreateCategory, mockUpdateCategory, mockNavigate } = vi.hoisted(() => ({
  mockState: { categoryId: undefined as string | undefined, parentId: undefined as string | undefined },
  mockGetCategory: vi.fn(),
  mockCreateCategory: vi.fn(),
  mockUpdateCategory: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ categoryId: mockState.categoryId }),
  useSearchParams: () => [new URLSearchParams(mockState.parentId ? `parent=${mockState.parentId}` : ''), vi.fn()],
}));
vi.mock('@/api', () => ({
  apiClient: {
    getCategory: mockGetCategory,
    createCategory: mockCreateCategory,
    updateCategory: mockUpdateCategory,
  },
}));

beforeEach(() => {
  mockState.categoryId = undefined;
  mockState.parentId = undefined;
  mockGetCategory.mockReset().mockResolvedValue({ id: 'root-1', name: 'Apparel', is_active: true });
  mockCreateCategory.mockReset().mockResolvedValue({ id: 'created' });
  mockUpdateCategory.mockReset().mockResolvedValue({ id: 'root-1' });
  mockNavigate.mockReset();
});

describe('CategoryDetails', () => {
  it('creates a root category with its active status and no temporary image URL', async () => {
    render(<CategoryDetails />);
    fireEvent.change(screen.getByLabelText(/categories\.detail\.categoryName/), { target: { value: 'Accessories' } });
    fireEvent.change(screen.getByLabelText('categories.detail.status'), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'categories.detail.createButton' }));

    await waitFor(() => expect(mockCreateCategory).toHaveBeenCalledWith({
      name: 'Accessories',
      description: '',
      is_active: false,
    }));
    expect(screen.queryByRole('textbox', { name: /image/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/categories');
  });

  it('creates a persisted child category with the canonical parent ID', async () => {
    mockState.parentId = 'root-1';
    render(<CategoryDetails />);
    await screen.findByText('categories.detail.parentCategory');
    fireEvent.change(screen.getByLabelText(/categories\.detail\.categoryName/), { target: { value: 'Summer Shirts' } });
    fireEvent.click(screen.getByRole('button', { name: 'categories.detail.createSubcategoryButton' }));

    await waitFor(() => expect(mockCreateCategory).toHaveBeenCalledWith({
      name: 'Summer Shirts',
      description: '',
      is_active: true,
      parent_category_id: 'root-1',
    }));
  });

  it('loads and updates the root status without exposing non-persisted child editing controls', async () => {
    mockState.categoryId = 'root-1';
    mockGetCategory.mockResolvedValue({
      id: 'root-1', name: 'Apparel', description: 'Clothing', is_active: true,
      subcategories: [{ id: 'child-1', name: 'Shirts' }],
    });
    render(<CategoryDetails />);

    expect(await screen.findByDisplayValue('Apparel')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('categories.detail.status'), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'categories.detail.updateButton' }));

    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith('root-1', {
      name: 'Apparel',
      description: 'Clothing',
      is_active: false,
    }));
    expect(screen.queryByText('Shirts')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
