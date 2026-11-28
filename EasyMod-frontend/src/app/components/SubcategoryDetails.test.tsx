import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SubcategoryDetails from './SubcategoryDetails';

const { mockGetCategory, mockGetSubcategoryDetails, mockUpdateCategory, mockNavigate } = vi.hoisted(() => ({
  mockGetCategory: vi.fn(),
  mockGetSubcategoryDetails: vi.fn(),
  mockUpdateCategory: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ categoryId: 'root-1', subcategoryId: 'child-1' }),
}));
vi.mock('@/api', () => ({
  apiClient: {
    getCategory: mockGetCategory,
    getSubcategoryDetails: mockGetSubcategoryDetails,
    updateCategory: mockUpdateCategory,
  },
}));

beforeEach(() => {
  mockGetCategory.mockReset().mockResolvedValue({ id: 'root-1', name: 'Apparel' });
  mockGetSubcategoryDetails.mockReset().mockResolvedValue({ id: 'child-1', name: 'Summer Shirts', description: 'Lightweight', is_active: true });
  mockUpdateCategory.mockReset().mockResolvedValue({ id: 'child-1' });
  mockNavigate.mockReset();
});

describe('SubcategoryDetails', () => {
  it('persists only the selected first-level child fields and removes unsupported nested/image editing', async () => {
    render(<SubcategoryDetails />);
    expect(await screen.findByDisplayValue('Summer Shirts')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('categories.detail.status'), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'categories.subcategoryDetail.updateButton' }));

    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith('child-1', {
      name: 'Summer Shirts',
      description: 'Lightweight',
      is_active: false,
    }));
    expect(screen.queryByText('categories.subcategoryDetail.nestedSection')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/categories');
  });
});
