/**
 * Guardrails contracts for /inbox as an EXECUTION page (header-removal
 * contract C1 + C1 amendment): the permanent signal band is gone — only the
 * compact visible h1 ("Shared Inbox" ≠ AppBar "Inbox") plus
 * conversation/page-contextual pills remain; no header CTA, no dominant badge
 * (the evidence-rail WHY HERE paragraph is inbox-namespace contextual copy,
 * untouched by the dashboard whyHere removal); the merchant drives work from
 * rows/composer/queue; evidence rail carries PROVEN RESULT / WHERE NEXT;
 * resolve dialog semantics; composer proof hook. Additive suite — the legacy
 * UnifiedInbox contract is untouched.
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

describe('inbox execution-page header (header-removal C1/C6)', () => {
  it('keeps only the compact title + contextual pills: no signal band, subtitle or header CTA', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(
      list([conv('conv-1', 'Alice'), conv('conv-2', 'Bob', { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED' })]) as never,
    )
    renderInbox()
    // C1 amendment: "Shared Inbox" ≠ AppBar "Inbox" → compact visible h1; the
    // signal band is still gone (absence pins below).
    await screen.findByRole('heading', { name: 'Shared Inbox', level: 1 })
    await waitFor(() => expect(screen.getByTestId('inbox-ai-reply-mode')).toBeInTheDocument())
    // C6: the page-level signal testid must NOT exist any more.
    expect(screen.queryByTestId('inbox-signal')).toBeNull()
    expect(screen.queryByTestId('inbox-primary-action')).toBeNull()
    expect(screen.queryByText('Customers are waiting for a reply on this page.')).toBeNull()
    expect(screen.getByTestId('inbox-ai-reply-mode').textContent).toBe('AI reply mode: Manual replies only')
    expect(screen.queryByTestId('inbox-unread-total')).toBeNull()
    // The work surface, not a header persuasion block, owns the viewport.
    expect(document.querySelector('.mw-inbox-workbench')).toBeTruthy()
  })

  it('merchant opens a reply task from the row; URL syncs without extra fetches', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(
      list([conv('conv-1', 'Alice'), conv('conv-2', 'Bob', { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED' })]) as never,
    )
    renderInbox()
    const row = await screen.findByRole('button', { name: /Bob/ })
    const fetchesBefore = vi.mocked(apiClient.getConversations).mock.calls.length
    fireEvent.click(row)
    await waitFor(() => expect(routerState.navigate).toHaveBeenCalled())
    expect(routerState.navigate).toHaveBeenLastCalledWith({ search: '?conversation=conv-2' }, { replace: true })
    expect(vi.mocked(apiClient.getConversations).mock.calls.length).toBe(fetchesBefore)
  })

  it('caught-up state adds no CTA and never polls', async () => {
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    renderInbox()
    await waitFor(() => expect(screen.getByTestId('inbox-ai-reply-mode')).toBeInTheDocument())
    // The retired dominant badge must not come back as page chrome.
    expect(screen.queryByTestId('inbox-signal')).toBeNull()
    expect(screen.queryByTestId('inbox-primary-action')).toBeNull()
    await waitFor(() => expect(vi.mocked(apiClient.getConversations)).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(vi.mocked(apiClient.getConversations)).toHaveBeenCalledTimes(1)
  })

  it('error state keeps the compact header and exposes the list retry', async () => {
    vi.mocked(apiClient.getConversations).mockRejectedValue(new Error('boom'))
    renderInbox()
    // C6: honesty survives in content — the list retry (already asserted) is
    // the anchor now that the header badge is retired.
    const retry = await screen.findByRole('button', { name: /try again/i })
    expect(screen.queryByTestId('inbox-primary-action')).toBeNull()
    expect(screen.queryByTestId('inbox-signal')).toBeNull()
    fireEvent.click(retry)
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

  it('shows safe evidence labels on new replies and marks historical replies as unrecorded', async () => {
    routerState.location.search = '?conversation=conv-1'
    vi.mocked(apiClient.getConversations).mockResolvedValue(list([conv('conv-1', 'Alice')]) as never)
    vi.mocked(apiClient.getMessages).mockResolvedValue(messages([
      customerMsg,
      {
        id: 'msg-ai-new', conversation_id: 'conv-1', sender: 'ai', content: 'The item is in stock.',
        message_type: 'text', created_at: now, updated_at: now, delivery_state: 'SENT',
        provider_message_id: 'meta-1', is_transcript_message: true,
        metadata: { reply_evidence: { provenance: 'model', reasons: ['GROUNDED'] } },
      },
      {
        id: 'msg-ai-fallback', conversation_id: 'conv-1', sender: 'ai', content: 'Please contact the shop for confirmation.',
        message_type: 'text', created_at: now, updated_at: now, delivery_state: 'SENT',
        provider_message_id: 'meta-fallback', is_transcript_message: true,
        metadata: { reply_evidence: { provenance: 'safe_fallback', reasons: ['SAFE_COPY_DELIVERED', 'RAG_TIMEOUT'] } },
      },
      {
        id: 'msg-ai-old', conversation_id: 'conv-1', sender: 'ai', content: 'Older reply.',
        message_type: 'text', created_at: now, updated_at: now, delivery_state: 'SENT',
        provider_message_id: 'meta-2', is_transcript_message: true,
      },
    ]) as never)

    renderInbox()

    expect(await screen.findByText('The item is in stock.')).toBeInTheDocument()
    expect(await screen.findByText('Older reply.')).toBeInTheDocument()
    expect(await screen.findByText('Please contact the shop for confirmation.')).toBeInTheDocument()
    const labels = screen.getAllByTestId('ai-confidence-evidence').map((el) => el.textContent)
    expect(labels).toEqual([
      'Evidence found — not a fact check',
      'Knowledge base unavailable — check this reply',
      'Evidence not recorded',
    ])
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
