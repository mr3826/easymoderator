import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Orders from '@/app/components/Orders'
import type { Order } from '@/api/types/order'

const navigate = vi.hoisted(() => vi.fn())
const mockedAuth = vi.hoisted(() => ({ role: 'owner' }))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/api', () => ({
  apiClient: {
    getOrders: vi.fn().mockResolvedValue([]),
    getOrderCounts: vi.fn().mockResolvedValue({
      total: 0, to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0,
    }),
    getProducts: vi.fn().mockResolvedValue([]),
    getPaymentConfig: vi.fn().mockResolvedValue({ success: true, data: [{ gateway: 'cod', is_enabled: true }] }),
    getOrder: vi.fn(),
    getConversations: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 1 }),
    getMessages: vi.fn().mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } }),
    createOrder: vi.fn(),
    updateOrder: vi.fn(),
    confirmOrder: vi.fn(),
  },
}))

// The confidence panel is not under test here and needs the auth context;
// keep this suite hermetic (its own tests live elsewhere).
vi.mock('@/app/components/orders/OrderConfidencePanel', () => ({
  default: () => null,
}))
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: mockedAuth.role } }),
}))

const normalizedOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'ORD-1001',
  customerName: 'Rahim Uddin',
  customerPhone: '01712345678',
  deliveryAddress: 'Mirpur 10, Dhaka',
  items: [{ productId: 'p1', productName: 'Azal Lawn cap', quantity: 1, price: 1200 }],
  total: 1200,
  status: 'confirmed',
  channel: 'facebook',
  createdAt: '2026-10-20T08:00:00Z',
  updatedAt: '2026-10-20T08:00:00Z',
  ...over,
}) as unknown as Order

beforeEach(async () => {
  mockedAuth.role = 'owner'
  const { apiClient } = await import('@/api')
  vi.mocked(apiClient.getOrders).mockReset().mockResolvedValue([])
  vi.mocked(apiClient.getOrderCounts).mockReset().mockResolvedValue({
    total: 0, to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0,
  })
  vi.mocked(apiClient.getProducts).mockReset().mockResolvedValue([])
  vi.mocked(apiClient.getPaymentConfig).mockReset().mockResolvedValue({
    success: true,
    data: [{ id: 'cod-config', gateway: 'cod', is_enabled: true }],
  })
  vi.mocked(apiClient.getOrder).mockReset()
  vi.mocked(apiClient.getConversations).mockReset().mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    pageSize: 1,
    ai_reply_mode: 'MANUAL',
  })
  vi.mocked(apiClient.getMessages).mockReset().mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } })
  vi.mocked(apiClient.createOrder).mockReset()
  vi.mocked(apiClient.updateOrder).mockReset()
  vi.mocked(apiClient.confirmOrder).mockReset()
})

const openDetail = async (viewIndex = 0) => {
  const buttons = await screen.findAllByRole('button', { name: /view detail/i })
  fireEvent.click(buttons[viewIndex])
}

describe('Orders', () => {
  it('warns when a COD courier collection needs reconciliation', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({
      payment_method: 'cod',
      metadata: { payment_reconciliation: { required: true, code: 'COD_COURIER_COLLECTION_REVIEW_REQUIRED' } },
    })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('COD collection needs reconciliation')
    expect(warning).toHaveTextContent(/how much cash the courier collected or what remains due/i)
    expect(warning).toHaveTextContent(/does not confirm that the order total was collected or that COD is settled/i)
    expect(warning).toHaveTextContent(/compare the courier booking\/remittance with the buyer's receipt/i)
  })

  it('distinguishes verified non-COD payment from courier collection state', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({
      payment_method: 'bkash',
      metadata: { payment_reconciliation: { required: true, code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM' } },
    })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('Verified payment needs courier reconciliation')
    expect(warning).toHaveTextContent(/gateway payment was verified/i)
    expect(warning).toHaveTextContent(/collection record has not been reconciled/i)
    expect(warning).toHaveTextContent(/amount collected by the courier is not established/i)
    expect(warning).not.toHaveTextContent(/courier amount was amended/i)
  })

  it.each([
    ['unknown code', { required: true, code: 'FUTURE_PAYMENT_RECONCILIATION' }],
    ['legacy code', { required: true, code: 'PAYMENT_VERIFIED_AFTER_TERMINAL_ORDER' }],
    ['missing legacy code', { required: true }],
  ])('shows neutral copy for an %s reconciliation flag', async (_label, reconciliation) => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({
      payment_method: 'legacy-method',
      payment_status: 'pending',
      metadata: { payment_reconciliation: reconciliation },
    })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('Payment and courier records need review')
    expect(warning).toHaveTextContent(/code does not provide enough information/i)
    expect(warning).toHaveTextContent(/compare the original payment and order records/i)
    expect(warning).not.toHaveTextContent(/payment was verified/i)
    expect(warning).not.toHaveTextContent(/courier amount was amended/i)
  })

  it('describes a verified-payment terminal-order code without claiming settlement', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({
      metadata: { payment_reconciliation: { required: true, code: 'PAYMENT_VERIFIED_AFTER_TERMINAL_ORDER_STATE' } },
    })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('Payment and order state need review')
    expect(warning).toHaveTextContent(/gateway payment verification was recorded after this order had already reached a terminal state/i)
    expect(warning).toHaveTextContent(/does not show whether courier collection changed or settlement is complete/i)
  })

  it('does not show a reconciliation warning when the flag is absent or false', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([
      normalizedOrder(),
      normalizedOrder({ id: 'o2', metadata: { payment_reconciliation: { required: false, code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM' } } }),
    ])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    const details = await screen.findAllByRole('button', { name: /view detail/i })
    fireEvent.click(details[1])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('hides the legacy payment-method correction control from staff', async () => {
    const { apiClient } = await import('@/api')
    mockedAuth.role = 'staff'
    vi.mocked(apiClient.getOrders).mockResolvedValue([
      normalizedOrder({ payment_method: undefined, payment_status: 'unpaid' }),
    ])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    expect(screen.getByText(/owner\/admin-only and audited/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Correct the missing payment method' })).not.toBeInTheDocument()
    expect(apiClient.updateOrder).not.toHaveBeenCalled()
  })

  it('renders orders page', async () => {
    render(<MemoryRouter><Orders /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('Orders')).toBeInTheDocument()
    })
  })

  it('explains Draft stock reservation and separates it from payment and delivery truth', async () => {
    render(<MemoryRouter><Orders /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /create order/i }))

    expect(await screen.findByText(/draft.*tracked stock.*cancel/i)).toBeInTheDocument()
    expect(screen.getByText(/payment and delivery are not confirmed/i)).toBeInTheDocument()
  })

  it('keeps lifecycle, payment, and fulfillment filters independent', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ status: 'delivered' })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Order status' }), { target: { value: 'completed' } })

    await waitFor(() => {
      expect(apiClient.getOrders).toHaveBeenLastCalledWith(expect.objectContaining({
        order_status: 'completed',
        payment_status: undefined,
        fulfillment_status: undefined,
      }))
    })

    fireEvent.change(screen.getByRole('combobox', { name: 'Payment status' }), { target: { value: 'paid' } })
    await waitFor(() => expect(apiClient.getOrders).toHaveBeenLastCalledWith(expect.objectContaining({
      order_status: 'completed',
      payment_status: 'paid',
      fulfillment_status: undefined,
    })))

    fireEvent.change(screen.getByRole('combobox', { name: 'Fulfillment status' }), { target: { value: 'fulfilled' } })
    await waitFor(() => expect(apiClient.getOrders).toHaveBeenLastCalledWith(expect.objectContaining({
      order_status: 'completed',
      payment_status: 'paid',
      fulfillment_status: 'fulfilled',
    })))
  })

  it('exposes a retry after a list error', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders)
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([normalizedOrder()])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('ORD-1001')).toBeInTheDocument()
  })

  it('sends explicit bounds for a supported date preset', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder()])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await screen.findByText('ORD-1001')
    fireEvent.change(screen.getByRole('combobox', { name: 'Created date' }), { target: { value: 'today' } })

    await waitFor(() => {
      const params = vi.mocked(apiClient.getOrders).mock.lastCall?.[0]
      expect(params?.start_date).toEqual(expect.any(String))
      expect(params?.end_date).toEqual(expect.any(String))
      const startDate = params?.start_date
      const endDate = params?.end_date
      if (typeof startDate !== 'string' || typeof endDate !== 'string') {
        throw new Error('Expected string start_date and end_date query bounds')
      }
      expect(Number.isNaN(Date.parse(startDate))).toBe(false)
      expect(Number.isNaN(Date.parse(endDate))).toBe(false)
    })
  })

  it('does not keep prior query results visible while a new result is loading', async () => {
    const { apiClient } = await import('@/api')
    let resolveNext: ((value: Order[]) => void) | undefined
    vi.mocked(apiClient.getOrders)
      .mockResolvedValueOnce([normalizedOrder({ orderNumber: 'ORD-OLD' })])
      .mockImplementationOnce(() => new Promise<Order[]>((resolve) => { resolveNext = resolve }))

    render(<MemoryRouter><Orders /></MemoryRouter>)
    expect(await screen.findByText('ORD-OLD')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Order status' }), { target: { value: 'cancelled' } })

    await waitFor(() => expect(apiClient.getOrders).toHaveBeenLastCalledWith(expect.objectContaining({ order_status: 'cancelled' })))
    expect(screen.getByRole('status')).toHaveTextContent('Loading orders')
    expect(screen.queryByText('ORD-OLD')).not.toBeInTheDocument()
    resolveNext?.([])
    expect(await screen.findByText('No orders match these filters.')).toBeInTheDocument()
  })

  it('keeps a failed deep link visible and retries the requested order', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrder)
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce(normalizedOrder())

    render(<MemoryRouter initialEntries={['/orders?orderId=o1']}><Orders /></MemoryRouter>)
    expect(await screen.findByText(/this order could not be loaded/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'Order Details' })).toBeInTheDocument()
    expect(apiClient.getOrder).toHaveBeenCalledTimes(2)
  })
})

describe('manual order idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigate.mockReset()
  })

  it('reuses the idempotency key when the same manual-order payload is retried', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([])
    vi.mocked(apiClient.getProducts).mockResolvedValue([{
      id: 'p1', name: 'Test Product', sku: 'SKU-1', price: 500, track_quantity: true,
      quantity: 8, low_stock_threshold: 2,
    } as any])
    vi.mocked(apiClient.createOrder)
      .mockRejectedValueOnce(new Error('Network response was lost'))
      .mockResolvedValueOnce(normalizedOrder({ id: 'order-1', status: 'draft' }))

    render(<MemoryRouter><Orders /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /create order/i }))
    const heading = await screen.findByRole('heading', { name: /create manual order/i })
    const modal = heading.parentElement?.parentElement
    if (!modal) throw new Error('Manual order modal was not rendered')
    const modalQueries = within(modal)

    fireEvent.change(modalQueries.getByPlaceholderText(/enter customer name/i), { target: { value: 'Rahim' } })
    fireEvent.change(modalQueries.getByLabelText(/phone\/mobile number/i), { target: { value: '01712345678' } })
    const selects = modalQueries.getAllByRole('combobox')
    fireEvent.change(selects[1], { target: { value: 'dhaka' } })
    fireEvent.change(selects[2], { target: { value: 'dhaka_city' } })
    fireEvent.change(selects[3], { target: { value: 'Mirpur' } })
    const courierArea = modalQueries.getByLabelText('Courier delivery area / thana')
    expect(courierArea).toHaveValue('Mirpur')
    fireEvent.change(courierArea, { target: { value: 'Mirpur 10' } })
    fireEvent.change(modalQueries.getByPlaceholderText(/house \/ road \/ area/i), { target: { value: 'Road 1' } })
    fireEvent.change(modalQueries.getByPlaceholderText(/search and add products/i), { target: { value: 'Test Product' } })
    fireEvent.click(await modalQueries.findByRole('button', { name: /Test Product/i }))

    expect(selects[4]).toHaveValue('')
    const createButton = modalQueries.getByRole('button', { name: /^Create Order$/i })
    expect(createButton).toBeDisabled()
    fireEvent.change(selects[4], { target: { value: 'cod' } })
    expect(createButton).toBeEnabled()
    fireEvent.click(createButton)
    await waitFor(() => expect(apiClient.createOrder).toHaveBeenCalledTimes(1))
    expect(apiClient.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      payment_method: 'cod',
      delivery_area: 'Mirpur 10',
      delivery_address: expect.objectContaining({ area: 'Mirpur 10', upazila: 'Mirpur' }),
    }), expect.any(String))
    const firstKey = (apiClient.createOrder as any).mock.calls[0][1]

    fireEvent.click(createButton)
    await waitFor(() => expect(apiClient.createOrder).toHaveBeenCalledTimes(2))
    const retryKey = (apiClient.createOrder as any).mock.calls[1][1]

    expect(retryKey).toBe(firstKey)
  })
})

// FE-08: the order detail's conversation snippet must be resolved through the
// shop-scoped customer id (verified backend association), NEVER a name search.
describe('FE-08 order → conversation association', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigate.mockReset()
  })

  it('links by customer_id and offers the canonical inbox deep link', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ customerId: 'cust-1' })])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [{ id: 'conv-9', customer_id: 'cust-1' }],
      total: 1, page: 1, pageSize: 1,
    })
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [{ content: 'hi there' }],
      pagination: { page: 1, totalPages: 1 },
    })

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    await waitFor(() => {
      expect(screen.getByText('hi there')).toBeInTheDocument()
    })

    // called with the verified id association, not a name search
    const params = (apiClient.getConversations as any).mock.calls[0][0]
    expect(params).toMatchObject({ customer_id: 'cust-1' })
    expect(params).not.toHaveProperty('search')
    expect(apiClient.getConversations).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: 'Rahim Uddin' }),
      expect.anything()
    )

    fireEvent.click(screen.getByRole('button', { name: /open conversation in inbox/i }))
    expect(navigate).toHaveBeenCalledWith('/inbox?conversation=conv-9')
  })

  it('shows an unavailable state and calls nothing for an unlinked (manual) order', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ customerId: undefined })])

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    await waitFor(() => {
      expect(screen.getByText('No chat snippet found.')).toBeInTheDocument()
    })
    expect(apiClient.getConversations).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /open conversation in inbox/i })).not.toBeInTheDocument()
  })

  it('refuses to show messages from a conversation belonging to a different customer id', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ customerId: 'cust-1' })])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [{ id: 'conv-X', customer_id: 'cust-OTHER' }],
      total: 1, page: 1, pageSize: 1,
    })

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    await waitFor(() => {
      expect(screen.getByText('No chat snippet found.')).toBeInTheDocument()
    })
    expect(apiClient.getMessages).not.toHaveBeenCalled()
  })

  it('shows the unavailable state when the customer has no conversations', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ customerId: 'cust-1' })])
    ;(apiClient.getConversations as any).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 1 })

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    await waitFor(() => {
      expect(screen.getByText('No chat snippet found.')).toBeInTheDocument()
    })
    expect(apiClient.getMessages).not.toHaveBeenCalled()
  })

  it('distinguishes a linked-but-empty conversation from having no link at all', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getOrders).mockResolvedValue([normalizedOrder({ customerId: 'cust-1' })])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [{ id: 'conv-9', customer_id: 'cust-1' }],
      total: 1, page: 1, pageSize: 1,
    })
    ;(apiClient.getMessages as any).mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } })

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail()

    await waitFor(() => {
      expect(screen.getByText('The linked conversation has no recent messages.')).toBeInTheDocument()
    })
    // honest, non-contradictory: NOT "no chat snippet found", but the verified link remains
    expect(screen.queryByText('No chat snippet found.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open conversation in inbox/i })).toBeInTheDocument()
  })

  it('discards a slower request for a previously opened order (stale response guard)', async () => {
    const { apiClient } = await import('@/api')
    const slow = normalizedOrder({ id: 'slow-1', orderNumber: 'ORD-SLOW', customerId: 'cust-slow' })
    const fast = normalizedOrder({ id: 'fast-1', orderNumber: 'ORD-FAST', customerId: 'cust-fast' })
    vi.mocked(apiClient.getOrders).mockResolvedValue([slow, fast])
    ;(apiClient.getConversations as any).mockImplementation(async (params: any) => {
      if (params.customer_id === 'cust-slow') {
        await new Promise((r) => setTimeout(r, 150))
        return { data: [{ id: 'conv-slow', customer_id: 'cust-slow' }], total: 1, page: 1, pageSize: 1 }
      }
      return { data: [{ id: 'conv-fast', customer_id: 'cust-fast' }], total: 1, page: 1, pageSize: 1 }
    })
    ;(apiClient.getMessages as any).mockImplementation(async (conversationId: string) => {
      if (conversationId === 'conv-slow') {
        await new Promise((r) => setTimeout(r, 150))
        return { messages: [{ content: 'SLOW ANSWER' }], pagination: { page: 1, totalPages: 1 } }
      }
      return { messages: [{ content: 'FAST ANSWER' }], pagination: { page: 1, totalPages: 1 } }
    })

    render(<MemoryRouter><Orders /></MemoryRouter>)
    await openDetail(0) // opens slow order
    await openDetail(1) // immediately switch to fast order

    await waitFor(() => {
      expect(screen.getByText('FAST ANSWER')).toBeInTheDocument()
    }, { timeout: 3000 })
    // let the in-flight slow chain land, then assert it never overwrote the state
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByText('SLOW ANSWER')).not.toBeInTheDocument()
  }, 10000)
})
