import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Products from '@/app/components/Products'

// Mock the API client
vi.mock('@/api', () => ({
  apiClient: {
    getProducts: vi.fn().mockResolvedValue([
      { id: '1', name: 'Test Product', price: 10, description: 'Test' }
    ]),
    getCategories: vi.fn().mockResolvedValue([]),
    getProductOverview: vi.fn().mockResolvedValue({
      total: 1,
      active: 1,
      inactive: 0,
      low_stock: 0,
      out_of_stock: 0,
      scanned: 1,
      cap: 1000,
      coverage_complete: true,
    }),
  }
}))

// Mock auth service
vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShopId: vi.fn().mockReturnValue('shop1')
  }
}))

const renderWithRouter = (component: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{component}</BrowserRouter>
    </QueryClientProvider>
  )
}

describe('Products', () => {
  it('renders products list', async () => {
    renderWithRouter(<Products />)

    await waitFor(() => {
      expect(screen.getByText('Test Product')).toBeInTheDocument()
    })
  })
})
