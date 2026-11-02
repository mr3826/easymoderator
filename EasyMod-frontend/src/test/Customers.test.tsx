import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Customers from '@/app/components/Customers'
import type { Customer } from '@/api/types/customer'
import type { PaginatedResponse } from '@/api/types/common'

const navigate = vi.hoisted(() => vi.fn())
const mockedAuth = vi.hoisted(() => ({ role: 'owner' }))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: mockedAuth.role } }),
}))

vi.mock('@/api/domains/customer-intelligence', () => ({
  getPilotStatus: vi.fn().mockResolvedValue({ customer_intelligence: false, order_confidence_mode: 'off' }),
  listCustomers360: vi.fn(),
  getCustomer360: vi.fn(),
  listOpportunities: vi.fn(),
  markOpportunityContacted: vi.fn(),
  dismissOpportunity: vi.fn(),
}))

vi.mock('@/api', () => ({
  apiClient: {
    getCustomers: vi.fn(),
    getCustomer: vi.fn(),
    createCustomer: vi.fn(),
    deleteCustomer: vi.fn(),
    getRtoNetworkSettings: vi.fn().mockResolvedValue({ contribute: true, enforce: true }),
    updateRtoNetworkSettings: vi.fn(),
  },
}))

// Rendered inside the page but exercised in its own suite.
vi.mock('@/app/components/RtoNetworkSettings', () => ({
  default: () => null,
}))

const listBody = (rows: Customer[], total: number): PaginatedResponse<Customer> => ({
  data: rows,
  total,
  page: 1,
  pageSize: 20,
})

const customerRow = (over: Record<string, unknown> = {}): Customer => ({
  id: 'cust-1',
  shop_id: 'shop-1',
  name: 'Rahim Uddin',
  email: 'rahim@example.com',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-05T10:00:00Z',
  ...over,
  phone: '01711111111',
  channel_type: 'messenger',
} as unknown as Customer)

// happy-dom ignores the media-query visibility classes, so both the mobile
// card list and the desktop table mount in every render. Scope row queries
// to the desktop table (the canonical worklist under test).
const desktopTable = async () => {
  const table = await screen.findByTestId('customer-table')
  return within(table)
}

const waitForList = async () => {
  await screen.findByTestId('customers-result-count')
}

const lastFilters = (getCustomers: { mock: { calls: unknown[][] } }) => {
  const calls = getCustomers.mock.calls
  return calls[calls.length - 1]?.[0]
}

beforeEach(async () => {
  mockedAuth.role = 'owner'
  navigate.mockClear()
  const { apiClient } = await import('@/api')
  vi.mocked(apiClient.getCustomers).mockReset().mockResolvedValue(listBody([customerRow()], 1))
  vi.mocked(apiClient.getCustomer).mockReset().mockResolvedValue(customerRow())
  vi.mocked(apiClient.createCustomer).mockReset()
  vi.mocked(apiClient.deleteCustomer).mockReset()
})

describe('Customers (legacy worklist)', () => {
  it('drops the passive summary cards and shows only the authoritative query total', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitForList()

    const table = await desktopTable()
    expect(table.getByText('Rahim Uddin')).toBeInTheDocument()
    expect(screen.queryByText('Total Customers')).not.toBeInTheDocument()
    expect(screen.queryByText('Channel Customers')).not.toBeInTheDocument()
    expect(screen.queryByText('Manual Customers')).not.toBeInTheDocument()
    expect(screen.getByTestId('customers-result-count')).toHaveTextContent('1 customers in this shop')
  })

  it('queries name and phone through the separate server-supported filters', async () => {
    const { apiClient } = await import('@/api')
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitForList()

    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'Rahim' } })
    await waitFor(() => {
      expect(apiClient.getCustomers).toHaveBeenCalledWith(expect.objectContaining({ search: 'Rahim' }))
    })

    fireEvent.change(screen.getByLabelText('Search by phone'), { target: { value: '01711111111' } })
    await waitFor(() => {
      expect(apiClient.getCustomers).toHaveBeenCalledWith(expect.objectContaining({ phone: '01711111111' }))
    })
    // The name query must not silently carry the phone into `search` — the
    // server's search field matches names only.
    expect(lastFilters(vi.mocked(apiClient.getCustomers))).toEqual(expect.objectContaining({ search: 'Rahim', phone: '01711111111' }))
  })

  it('shows a no-match state with clear-filters when a query returns nothing', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getCustomers).mockResolvedValue(listBody([customerRow()], 1))
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitForList()

    vi.mocked(apiClient.getCustomers).mockResolvedValue(listBody([], 0))
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'Nobody' } })
    await waitFor(() => expect(screen.getByText('No customers match')).toBeInTheDocument())
    expect(screen.queryByText('No customers yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('customers-clear-filters'))
    await waitFor(() => {
      const last = lastFilters(vi.mocked(apiClient.getCustomers))
      expect(last && !('search' in (last as object))).toBe(true)
    })
  })

  it('shows an honest empty shop only when no query is active', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getCustomers).mockResolvedValue(listBody([], 0))
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('No customers yet')).toBeInTheDocument())
    expect(screen.queryByText('No customers match')).not.toBeInTheDocument()
    // Empty state names a supported path, not marketing copy.
    expect(screen.getByText(/Add a customer manually/i)).toBeInTheDocument()
  })

  it('surfaces request failure as an alert with retry and never shows stale rows as current', async () => {
    const { apiClient } = await import('@/api')
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await desktopTable()

    vi.mocked(apiClient.getCustomers).mockRejectedValueOnce(new Error('network down'))
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'R' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network down'))
    expect(screen.queryByTestId('customer-table')).not.toBeInTheDocument()

    vi.mocked(apiClient.getCustomers).mockResolvedValue(listBody([customerRow()], 1))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await desktopTable()
  })

  it('offers delete only to owner/admin while the server enforces the same rule', async () => {
    mockedAuth.role = 'staff'
    const staffView = render(<MemoryRouter><Customers /></MemoryRouter>)
    const staffTable = await desktopTable()
    await waitFor(() => expect(staffTable.getByText('Rahim Uddin')).toBeInTheDocument())
    expect(staffTable.queryByRole('button', { name: 'Delete Customer' })).not.toBeInTheDocument()
    expect(within(screen.getByTestId('customer-list-mobile')).queryByRole('button', { name: 'Delete Customer' })).not.toBeInTheDocument()
    staffView.unmount()

    mockedAuth.role = 'owner'
    render(<MemoryRouter><Customers /></MemoryRouter>)
    const ownerTable = await desktopTable()
    await waitFor(() => expect(ownerTable.getAllByRole('button', { name: 'Delete Customer' }).length).toBeGreaterThan(0))
  })

  it('links the customer profile to the supported Orders worklist by phone', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    const table = await desktopTable()
    fireEvent.click(table.getByRole('button', { name: 'View' }))
    const ordersLink = await screen.findByTestId('customer-view-orders')
    fireEvent.click(ordersLink)
    expect(navigate).toHaveBeenCalledWith('/orders?search=01711111111')
  })

  it('normalizes phone and channel at the boundary so real values render', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    const mobileRow = await screen.findByTestId('customer-row-cust-1')
    expect(mobileRow).toHaveTextContent('01711111111')
    expect(mobileRow).toHaveTextContent('Messenger')
    const table = await desktopTable()
    expect(table.getByText('01711111111')).toBeInTheDocument()
    expect(table.queryByText('—')).not.toBeInTheDocument()
  })

  it('re-fetches the authoritative list after create instead of nudging a cached summary', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.createCustomer).mockResolvedValue(customerRow({ id: 'cust-2', name: 'New Customer' }))
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitForList()

    const callsBefore = vi.mocked(apiClient.getCustomers).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }))
    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'New Customer' } })
    fireEvent.change(screen.getByLabelText(/phone number/i), { target: { value: '01722222222' } })
    fireEvent.change(screen.getByLabelText(/^Channel/i), { target: { value: 'manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(vi.mocked(apiClient.getCustomers).mock.calls.length).toBeGreaterThan(callsBefore)
    })
    // The fresh fetch must carry page metadata, not an optimistic stat bump.
    expect(lastFilters(vi.mocked(apiClient.getCustomers))).toEqual(expect.objectContaining({ page: 1, pageSize: 20 }))
  })
})
