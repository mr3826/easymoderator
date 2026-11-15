/**
 * Guardrails anatomy contracts for /inbox (additive suite; the legacy
 * UnifiedInbox.test.tsx contract is untouched). Header signal + single
 * primary, primary navigation without extra fetches, refresh-on-click only,
 * evidence rail presence, resolve dialog semantics, composer proof hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import UnifiedInbox from '@/app/components/UnifiedInbox'
import { apiClient } from '@/api'
import { useInboxSSE } from '@/app/lib/useInboxSSE'

const routerState = vi.hoisted(() => ({
  location: { pathname: '/inbox', search: '', hash: '', state: null },
  navigate: vi.fn(),
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useLocation: () => routerState.location,
    useNavigate: () => routerState.navigate,
    useParams: () => ({}),
  }
})

vi.mock('@/api', () => ({
  apiClient: {
    getShopAgents: vi.fn(),
    getConversations: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    createMessage: vi.fn(),
    approveAiDraft: vi.fn(),
    dismissAiDraft: vi.fn(),
    markConversationRead: vi.fn(),
    updateConversation: vi.fn(),
    transcribeVoice: vi.fn(),
    getResponseTemplates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    createAuditLog: vi.fn(),
    getSubscription: vi.fn(),
  },
}))

vi.mock('@/app/lib/useSubscriptionFeatures', () => ({
  useSubscriptionFeatures: () => ({
    features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false },
    planName: 'PRO',
    plan: null,
    loading: false,
  }),
}))

vi.mock('@/app/lib/useInboxSSE', () => ({ useInboxSSE: vi.fn() }))
vi.mock('@/api/domains/inbox', () => ({ getInboxActions: vi.fn(async () => ({ featureDisabled: true })) }))
vi.mock('@/api/domains/customer-intelligence', () => ({
  getPilotStatus: vi.fn(async () => ({ customer_intelligence: false, order_confidence_mode: 'off' })),
  getCustomer360: vi.fn(async () => { throw new Error('off') }),
}))
vi.mock('@/api/domains/order', () => ({ getOrders: vi.fn(async () => []) }))
vi.mock('@/api/domains/customer-crm', () => ({
  listCustomerNotes: vi.fn(async () => ({ data: [], total: 0 })),
  listCustomerTags: vi.fn(async () => ({ data: [] })),
  listTagVocabulary: vi.fn(async () => ({ data: [] })),
  createCustomerNote: vi.fn(),
  deleteCustomerNote: vi.fn(),
  setCustomerTags: vi.fn(),
  createTag: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

const now = new Date().toISOString()
const conv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  customer_id: `cust-${id}`,
  customer: { id: `cust-${id}`, name },
  channel: 'facebook',
  status: 'active',
  title: name,
  created_at: now,
  updated_at: now,
  unreadCount: 0,
  ...extra,
})

const list = (rows: unknown[]) => ({
  data: rows,
  ai_reply_mode: 'MANUAL',
  pagination: { page: 1, totalPages: 1, total: rows.length, pageSize: 50 },
})

const messages = (rows: unknown[]) => ({ messages: rows, pagination: { page: 1, totalPages: 1 } })

const customerMsg = {
  id: 'msg-c1',
  conversation_id: 'conv-1',
  sender: 'customer',
  content: 'Hello',
  message_type: 'text',
  created_at: now,
  updated_at: now,
  is_transcript_message: true,
}

const renderInbox = () => render(<MemoryRouter><UnifiedInbox /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  routerState.location = { pathname: '/inbox', search: '', hash: '', state: null }
  vi.mocked(useInboxSSE).mockImplementation(() => undefined as never)
  vi.mocked(apiClient.getMessages).mockResolvedValue(messages([customerMsg]) as never)
  vi.mocked(apiClient.getResponseTemplates).mockResolvedValue([] as never)
  vi.mocked(apiClient.markConversationRead).mockResolvedValue(conv('conv-1', 'Alice') as never)
})

describe('inbox guardrails anatomy', () => {
  it('renders the Shared Inbox title, one dominant signal and exactly one primary', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    renderInbox()
    await screen.findByRole('heading', { name: 'Shared Inbox', level: 1 })
    const signal = await screen.findByTestId('inbox-signal')
    expect(signal.textContent).toContain('All caught up')
    expect(screen.getAllByTestId('inbox-primary-action')).toHaveLength(1)
    expect(screen.getByTestId('inbox-ai-reply-mode').textContent).toBe('AI reply mode: Manual replies only')
    expect(screen.queryByTestId('inbox-unread-total')).toBeNull()
  })

  it('primary opens the first reply task and syncs the URL without extra fetches', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(
      list([conv('conv-1', 'Alice'), conv('conv-2', 'Bob', { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED' })]) as never,
    )
    renderInbox()
    const primary = await screen.findByTestId('inbox-primary-action')
    expect(primary.textContent).toContain('Open next reply')
    const fetchesBefore = vi.mocked(apiClient.getConversations).mock.calls.length
    fireEvent.click(primary)
    await waitFor(() => expect(routerState.navigate).toHaveBeenCalled())
    expect(routerState.navigate).toHaveBeenLastCalledWith({ search: '?conversation=conv-2' }, { replace: true })
    expect(vi.mocked(apiClient.getConversations).mock.calls.length).toBe(fetchesBefore)
  })

  it('caught-up primary refreshes on click only (no polling)', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    renderInbox()
    const primary = await screen.findByTestId('inbox-primary-action')
    expect(primary.textContent).toContain('Refresh inbox')
    await waitFor(() => expect(vi.mocked(apiClient.getConversations)).toHaveBeenCalledTimes(1))
    fireEvent.click(primary)
    await waitFor(() => expect(vi.mocked(apiClient.getConversations)).toHaveBeenCalledTimes(2))
  })

  it('list error offers retry as the primary', async () => {
    vi.mocked(apiClient.getConversations).mockRejectedValue(new Error('boom'))
    renderInbox()
    const primary = await screen.findByTestId('inbox-primary-action')
    expect(primary.textContent).toContain('Retry loading')
    expect(screen.getByTestId('inbox-signal').textContent).toContain('AI stopped')
    fireEvent.click(primary)
    await waitFor(() => expect(vi.mocked(apiClient.getConversations)).toHaveBeenCalledTimes(2))
  })

  it('shows the evidence rail with provider-confirmed wording and the composer proof hook', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    vi.mocked(apiClient.getMessages).mockResolvedValue(messages([
      customerMsg,
      { id: 'msg-a1', conversation_id: 'conv-1', sender: 'agent', content: 'Hi', message_type: 'text', created_at: now, updated_at: now, delivery_state: 'SEND_PENDING', is_transcript_message: true },
    ]) as never)
    renderInbox()
    const rail = await screen.findByTestId('inbox-evidence-rail')
    await waitFor(() => expect(rail.textContent).toContain('Provider confirmation pending'))
    expect(rail.textContent).not.toMatch(/seen by|delivered to customer/i)
    const input = screen.getByTestId('message-input')
    expect(input.getAttribute('placeholder')).toBe('Type your reply here...')
  })

  it('resolve dialog is a labelled modal and keeps the note as the last textarea', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    renderInbox()
    fireEvent.click(await screen.findByRole('button', { name: /^Resolve$/i }))
    const dialog = await screen.findByRole('dialog', { name: /resolve conversation/i })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const textareas = document.querySelectorAll('textarea')
    expect(textareas[textareas.length - 1].getAttribute('placeholder')).toBeTruthy()
    expect(dialog.contains(textareas[textareas.length - 1])).toBe(true)
  })
})
