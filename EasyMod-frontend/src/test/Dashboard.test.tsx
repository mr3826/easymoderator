import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { apiClient } from '@/api'
import Dashboard from '@/app/components/Dashboard'

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
    useParams: () => ({}),
  }
})

vi.mock('@/api', () => ({
  apiClient: {
    getSetupStatus: vi.fn().mockResolvedValue({
      isComplete: true,
      completedCount: 4,
      totalCount: 4,
      progressPercent: 100,
      tasks: [],
      counts: {
        connectedFacebookPages: 1,
        webhookVerifiedFacebookPages: 1,
        activeProducts: 3,
        activeFaqs: 1,
        knowledgeDocuments: 0,
      },
      generatedAt: '2026-07-04T00:00:00.000Z',
    }),
    getDashboardMetrics: vi.fn().mockResolvedValue({
      metrics: { ordersToday: 2 },
      analytics: { llm_calls: 42 },
    }),
    getDashboardQueue: vi.fn().mockResolvedValue({
      unread_count: 3,
      pending_payment_count: 0,
      ready_to_dispatch_count: 0,
      at_risk_orders: [],
    }),
    getOrders: vi.fn().mockImplementation((params: { order_status?: string }) => (
      params?.order_status === 'draft' ? [] : [
        { id: 'o1', total: 500, status: 'confirmed', items: [{ name: 'Item A', quantity: 1 }] },
        { id: 'o2', total: 300, status: 'processing', items: [{ name: 'Item B', quantity: 2 }] },
      ]
    )),
    getConversations: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 100, ai_reply_mode: 'MANUAL' }),
  }
}))

describe('Dashboard', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1')
  })

  it('renders dashboard with pulse data', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    // Wait for async data load — heading is always present after load.
    await waitFor(() => {
      expect(screen.getByText("Today's work")).toBeInTheDocument()
    })

    // Unread aggregates do not become unsupported reply tasks.
    expect(screen.getByText(/caught up/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs your reply/i)).not.toBeInTheDocument()
  })

  it('uses the authoritative order count and distinguishes order value from collected cash', async () => {
    ;(apiClient.getDashboardMetrics as any).mockResolvedValue({
      metrics: { ordersToday: 51 },
      analytics: { llm_calls: 0 },
      cashPosition: null,
    })
    ;(apiClient.getOrders as any).mockImplementation((params: { order_status?: string }) => (
      params?.order_status === 'draft'
        ? []
        : [{ id: 'latest-order', total: 1250, status: 'confirmed', items: [{ productName: 'Item A', quantity: 1 }] }]
    ))

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    const orderCard = await screen.findByText('Orders today')
    expect(orderCard.parentElement).toHaveTextContent('51')
    expect(screen.getByText(/order totals are not cash collected or settled/i)).toBeInTheDocument()
    expect(screen.queryByText("Today's Sales")).not.toBeInTheDocument()
  })

  it('does not claim the merchant is caught up when a reply-task page is incomplete', async () => {
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [], total: 101, page: 1, pageSize: 100, ai_reply_mode: 'MANUAL',
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    expect(await screen.findByText(/could not verify all work sources/i)).toBeInTheDocument()
    expect(screen.queryByText('No verified work items remain. You are caught up.')).not.toBeInTheDocument()
  })
})
