import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import UnifiedInbox from '@/app/components/UnifiedInbox'
import { apiClient } from '@/api'
import { useInboxSSE } from '@/app/lib/useInboxSSE'
import { getOrders } from '@/api/domains/order'
import { toast } from 'sonner'

const routerState = vi.hoisted(() => ({
  location: { pathname: '/', search: '', hash: '', state: null },
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
    // Auth methods
    getShopAgents: vi.fn(),
    // Conversation methods
    getConversations: vi.fn(),
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
    // Other methods needed
    getSubscription: vi.fn(),
  }
}))

vi.mock('@/app/lib/useSubscriptionFeatures', () => ({
  useSubscriptionFeatures: () => ({
    features: {
      image_understanding: true,
      advanced_ai: true,
      priority_support: true,
      custom_branding: false,
    },
    planName: 'PRO',
    plan: null,
    loading: false,
  })
}))

vi.mock('@/app/lib/useInboxSSE', () => ({
  useInboxSSE: vi.fn()
}))

// P+03 action queue: platform flag off by default — keep the strip inert and hermetic.
vi.mock('@/api/domains/inbox', () => ({
  getInboxActions: vi.fn().mockResolvedValue({ featureDisabled: true }),
}))

// MW-V1 customer-context panel domains: inert by default; mounted explicitly.
vi.mock('@/api/domains/customer-intelligence', () => ({
  getPilotStatus: vi.fn(async () => ({ customer_intelligence: false, order_confidence_mode: 'off' })),
  getCustomer360: vi.fn(async () => { throw new Error('not mounted in this test'); }),
}))
vi.mock('@/api/domains/order', () => ({
  getOrders: vi.fn(async () => []),
}))
vi.mock('@/api/domains/customer-crm', () => ({
  listCustomerNotes: vi.fn(async () => ({ data: [], total: 0 })),
  listCustomerTags: vi.fn(async () => ({ data: [] })),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const baseConversation = {
  id: 'conv-1',
  customer_id: 'cust-1',
  customer: { id: 'cust-1', name: 'Alice' },
  channel: 'facebook' as const,
  status: 'active' as const,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

type InboxSSECallbacks = Parameters<typeof useInboxSSE>[0]

const setInboxData = (mode: string, messages: any[] = [], conversation: any = baseConversation) => {
  ;(apiClient.getConversations as any).mockResolvedValue({
    data: [conversation],
    ai_reply_mode: mode,
    pagination: { page: 1, totalPages: 1 },
  })
  ;(apiClient.getMessages as any).mockResolvedValue({
    messages,
    pagination: { page: 1, totalPages: 1 },
  })
}

const latestSSECallbacks = (): InboxSSECallbacks => {
  const calls = vi.mocked(useInboxSSE).mock.calls
  return calls[calls.length - 1]?.[0] as InboxSSECallbacks
}

describe('UnifiedInbox 24h window behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [],
      pagination: { page: 1, totalPages: 1 }
    })
    ;(apiClient.getShopAgents as any).mockResolvedValue([])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [],
      pagination: { page: 1, totalPages: 1 }
    })
    ;(apiClient.markConversationRead as any).mockResolvedValue({ ...baseConversation, unreadCount: 0, lastReadMessageId: 'msg-read' })
    ;(apiClient.createMessage as any).mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-1',
      content: 'hello',
      sender: 'agent',
      message_type: 'text',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    ;(apiClient.approveAiDraft as any).mockResolvedValue({
      id: 'msg-ai-draft',
      conversation_id: 'conv-1',
      content: 'Here is a draft reply.',
      sender: 'ai',
      message_type: 'text',
      delivery_state: 'SENT',
      metadata: { delivered: true, delivery_status: 'sent', delivery_state: 'SENT', provider_message_id: 'mid-1' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    ;(apiClient.dismissAiDraft as any).mockImplementation(async (_conversationId: string, messageId: string) => ({
      id: messageId,
      conversation_id: 'conv-1',
      content: 'Here is a draft reply.',
      sender: 'ai',
      message_type: 'text',
      delivery_state: 'DISMISSED',
      metadata: { delivered: false, delivery_status: 'dismissed', delivery_state: 'DISMISSED', suggestion_visibility: 'HIDDEN_DISMISSED' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    ;(apiClient.updateConversation as any).mockResolvedValue({
      id: 'conv-1',
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    ;(apiClient.transcribeVoice as any).mockResolvedValue({
      messageId: 'msg-1',
      transcript: 'Hello world',
      language: 'english',
    })
    ;(apiClient.createTemplate as any).mockResolvedValue({
      id: 'tpl-new',
      name: 'Saved',
      content: 'Saved reply',
      category: 'Quick Reply',
      is_active: true,
    })
    ;(apiClient.updateTemplate as any).mockResolvedValue({
      id: 'tpl-1',
      name: 'Greeting',
      content: 'Updated reply',
      category: 'Quick Reply',
      is_active: true,
    })
    ;(apiClient.deleteTemplate as any).mockResolvedValue(undefined)
    ;(apiClient.getSubscription as any).mockResolvedValue({
      plan: 'PRO',
      status: 'active',
      features: {
        image_understanding: true,
        advanced_ai: true,
        priority_support: true,
        custom_branding: false,
      },
    })
  })

  it('shows 24h warning banner for Facebook conversation around 23h', async () => {
    const warningConversation = {
      ...baseConversation,
      updated_at: new Date(Date.now() - 23.5 * 60 * 60 * 1000).toISOString(),
      channel: 'facebook' as const,
    }

    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [warningConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByText(/Time to reply directly to this customer is almost up/i)).toBeInTheDocument()
    })
  })

  it('disables send for expired Facebook window because legacy tags are unavailable', async () => {
    const expiredConversation = {
      ...baseConversation,
      updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      channel: 'facebook' as const,
    }

    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [expiredConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByText(/messaged over 24h ago/i)).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText(/Wait for the customer to message again/i)
    expect(input).toBeDisabled()

    const sendButton = screen.getByRole('button', { name: /^Send$/i })
    expect(sendButton).toBeDisabled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('does not send manual message with deprecated tag after expired Meta window', async () => {
    const expiredConversation = {
      ...baseConversation,
      updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      channel: 'facebook' as const,
    }

    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [expiredConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByText(/messaged over 24h ago/i)).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText(/Wait for the customer to message again/i)
    expect(input).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    expect(apiClient.createMessage).not.toHaveBeenCalled()
  })

  it('blocks AI suggestion send when expired window has no approved template path', async () => {
    const expiredConversation = {
      ...baseConversation,
      updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      channel: 'facebook' as const,
    }

    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [expiredConversation],
      pagination: { page: 1, totalPages: 1 }
    })
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [
        {
          id: 'msg-customer-1',
          conversation_id: 'conv-1',
          content: 'Please help',
          sender: 'customer',
          message_type: 'text',
           created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
           updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        },
        {
          id: 'msg-ai-1',
          conversation_id: 'conv-1',
          content: 'AI draft reply',
          ai_suggestion: 'AI draft reply',
          ai_confidence: 0.9,
          sender: 'ai',
          message_type: 'text',
          metadata: { delivered: false, held_reason: 'draft_mode' },
          created_at: new Date(Date.now() - 30 * 1000).toISOString(),
          updated_at: new Date(Date.now() - 30 * 1000).toISOString(),
        },
      ],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByText(/Draft ready for review/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Send this/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('This Messenger conversation is outside the 24-hour reply window.')
    })
    expect(apiClient.createMessage).not.toHaveBeenCalled()
  })

  it('keeps mic and assign controls hidden in Shared Inbox', async () => {
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /voice|recording|microphone/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('inserts quick reply templates into the composer instead of sending immediately', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([
      { id: 'tpl-1', name: 'Greeting', content: 'Hi {{customer_name}}', category: 'Quick Reply', is_active: true },
    ])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /quick replies/i }))
    fireEvent.click(await screen.findByText('Greeting'))

    expect(screen.getByDisplayValue('Hi Alice')).toBeInTheDocument()
    expect(apiClient.createMessage).not.toHaveBeenCalled()
  })

  it('creates, edits, deletes, and searches quick replies inside the inbox manager', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([
      { id: 'tpl-1', name: 'Greeting', content: 'Hello there', category: 'Quick Reply', is_active: true },
    ])
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      pagination: { page: 1, totalPages: 1 }
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /quick replies/i }))
    fireEvent.click(await screen.findByText('Manage quick replies'))

    fireEvent.change(screen.getByPlaceholderText('Quick reply name'), { target: { value: 'Payment' } })
    fireEvent.change(screen.getByPlaceholderText('Quick reply message'), { target: { value: 'Please pay now' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/i }))

    await waitFor(() => {
      expect(apiClient.createTemplate).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Payment',
        content: 'Please pay now',
        is_active: true,
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: /Edit Greeting/i }))
    fireEvent.change(screen.getByPlaceholderText('Quick reply message'), { target: { value: 'Updated reply' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => {
      expect(apiClient.updateTemplate).toHaveBeenCalledWith('tpl-1', expect.objectContaining({
        content: 'Updated reply',
      }))
    })

    fireEvent.change(screen.getAllByPlaceholderText('Search quick replies')[1], { target: { value: 'missing' } })
    expect(screen.getByText('No saved quick replies yet. Add answers you send often to save time in customer conversations.')).toBeInTheDocument()

    fireEvent.change(screen.getAllByPlaceholderText('Search quick replies')[1], { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Delete Greeting/i }))

    await waitFor(() => {
      expect(apiClient.deleteTemplate).toHaveBeenCalledWith('tpl-1')
    })
  })

  it('sends selected image attachment as upload metadata for backend delivery', async () => {
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      pagination: { page: 1, totalPages: 1 }
    })
    ;(apiClient.createMessage as any).mockResolvedValue({
      id: 'msg-image',
      conversation_id: 'conv-1',
      content: 'Photo caption',
      sender: 'agent',
      message_type: 'image',
      metadata: {
        message_type: 'image',
        image_url: 'https://cdn.example.com/photo.png',
        file_url: 'https://cdn.example.com/photo.png',
        delivery_status: 'pending',
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })

    const file = new File(['image-bytes'], 'photo.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    })
    fireEvent.change(screen.getByPlaceholderText(/Type your reply here/i), { target: { value: 'Photo caption' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => {
      expect(apiClient.createMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          content: 'Photo caption',
          sender: 'agent',
          message_type: 'image',
          metadata: expect.objectContaining({
            file_name: 'photo.png',
            mime_type: 'image/png',
            delivery_status: 'pending',
            file_data_url: expect.stringMatching(/^data:image\/png;base64,/),
          }),
         }),
         expect.objectContaining({ idempotencyKey: expect.any(String) }),
      )
    })
  })

  it('shows the AUTO mode and automatic activity claim while AI is processing', async () => {
    setInboxData('AUTO', [{
      id: 'msg-customer-processing', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
      created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
    }])

    render(<UnifiedInbox />)

    expect(await screen.findByTestId('inbox-ai-reply-mode')).toHaveTextContent('AI reply mode: Automatic replies')
    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    expect(screen.getByTestId('inbox-reply-status')).toHaveTextContent('AI is preparing a reply')
  })

  it('keeps the AUTO sent terminal state without showing the active claim', async () => {
    const customerMessage = {
      id: 'msg-customer-sent',
      conversation_id: 'conv-1',
      content: 'Thanks',
      sender: 'customer' as const,
      message_type: 'text' as const,
      created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    const sentMessage = {
      id: 'msg-ai-sent',
      conversation_id: 'conv-1',
      content: 'You are welcome.',
      sender: 'ai' as const,
      message_type: 'text' as const,
       provider_message_id: 'mid.ai-sent',
       metadata: { delivered: true, provider_message_id: 'mid.ai-sent', provider_send_confirmed: true },
      created_at: new Date(Date.now() - 30 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 30 * 1000).toISOString(),
    }
    setInboxData('AUTO', [customerMessage, sentMessage])

    render(<UnifiedInbox />)

    expect(await screen.findByTestId('inbox-reply-status')).toHaveTextContent('AI reply sent')
    expect(screen.queryByText('AI is replying')).not.toBeInTheDocument()
  })

  const draftMessages = () => {
    const customerMessage = {
      id: 'msg-customer-draft',
      conversation_id: 'conv-1',
      content: 'Can you help?',
      sender: 'customer' as const,
      message_type: 'text' as const,
      created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    const heldMessage = {
      id: 'msg-ai-draft',
      conversation_id: 'conv-1',
      content: 'Here is a draft reply.',
      ai_suggestion: 'Here is a draft reply.',
      sender: 'ai' as const,
      message_type: 'text' as const,
      metadata: { delivered: false, held_reason: 'draft_mode' },
      created_at: new Date(Date.now() - 30 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 30 * 1000).toISOString(),
    }
    return { customerMessage, heldMessage }
  }

  it('shows DRAFT readiness when an undelivered held AI message exists', async () => {
    const { customerMessage, heldMessage } = draftMessages()
    setInboxData('DRAFT', [customerMessage, heldMessage])
    render(<UnifiedInbox />)

    expect(await screen.findByText('Draft ready for review')).toBeInTheDocument()
    expect(screen.queryByText('AI is replying')).not.toBeInTheDocument()
  })

  it('does not show DRAFT readiness when no undelivered held AI message exists', async () => {
    setInboxData('DRAFT')
    render(<UnifiedInbox />)

    expect(await screen.findByTestId('inbox-ai-reply-mode')).toHaveTextContent('Drafts for review')
    expect(screen.queryByText('Draft ready for review')).not.toBeInTheDocument()
  })

  it('marks the latest visible inbound read through the server and clears the global unread badge', async () => {
    const conversation = { ...baseConversation, unreadCount: 1 }
    const inbound = {
      id: 'msg-read-latest', conversation_id: 'conv-1', content: 'Please help', sender: 'customer' as const, message_type: 'text' as const,
      created_at: new Date(Date.now() - 30000).toISOString(), updated_at: new Date(Date.now() - 30000).toISOString(),
    }
    setInboxData('MANUAL', [inbound], conversation)
    render(<UnifiedInbox />)

    await waitFor(() => expect(apiClient.markConversationRead).toHaveBeenCalledWith('conv-1', 'msg-read-latest'))
    await waitFor(() => expect(screen.queryByTestId('inbox-unread-total')).not.toBeInTheDocument())
  })

  it('clears DRAFT readiness after a newer human reply', async () => {
    const { customerMessage, heldMessage } = draftMessages()
    const agentMessage = {
      id: 'msg-agent-draft',
      conversation_id: 'conv-1',
      content: 'A human reply.',
      sender: 'agent' as const,
      message_type: 'text' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    setInboxData('DRAFT', [customerMessage, heldMessage, agentMessage])
    render(<UnifiedInbox />)

    expect(await screen.findByTestId('inbox-ai-reply-mode')).toHaveTextContent('Drafts for review')
    expect(screen.queryByText('Draft ready for review')).not.toBeInTheDocument()
  })

  it('keeps the manual composer and HITL control without an automatic-reply claim', async () => {
    setInboxData('MANUAL')

    render(<UnifiedInbox />)

    expect(await screen.findByTestId('inbox-ai-reply-mode')).toHaveTextContent('AI reply mode: Manual replies only')
    expect(await screen.findByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Take over/i })).toBeInTheDocument()
    expect(screen.queryByText('AI is replying')).not.toBeInTheDocument()
    expect(screen.queryByText('AI is preparing a reply')).not.toBeInTheDocument()
  })

  it('uses the backend Needs your reply projection independently from HITL and unread state', async () => {
    const needsReplyConversation = {
      ...baseConversation,
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED',
      unreadCount: 0,
    }
    const answeredHumanOwned = {
      ...baseConversation,
      id: 'conv-2',
      customer_id: 'cust-2',
      customer: { id: 'cust-2', name: 'Bob' },
      hitl: true,
      needs_merchant_reply: false,
      unreadCount: 0,
    }
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [needsReplyConversation, answeredHumanOwned],
      ai_reply_mode: 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getMessages as any).mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } })

    render(<UnifiedInbox />)

    const needsTab = await screen.findByRole('button', { name: /Needs your reply/i })
    expect(needsTab).toHaveTextContent('1')
    fireEvent.click(needsTab)
    // The tab switch re-filters asynchronously; assert after the flush so the
    // suite is deterministic under full-parallel CPU load (was a sync read).
    await waitFor(() => expect(screen.getAllByText('Alice').length).toBeGreaterThan(0))
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })

  it('keeps Needs your reply after dismissing an unanswered draft', async () => {
    const { customerMessage, heldMessage } = draftMessages()
    setInboxData('DRAFT', [customerMessage, heldMessage], {
      ...baseConversation,
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'DRAFT_REVIEW_REQUIRED',
    })
    ;(apiClient.getMessages as any)
      .mockResolvedValueOnce({ messages: [customerMessage, heldMessage], pagination: { page: 1, totalPages: 1 } })
      .mockResolvedValue({ messages: [customerMessage], pagination: { page: 1, totalPages: 1 } })
    render(<UnifiedInbox />)

    expect(await screen.findByText('Draft ready for review')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Needs your reply/i })).toHaveTextContent('1')
    })
  })

  it('uses Resume AI as a state-only hand-back action', async () => {
    const humanOwned = { ...baseConversation, hitl: true, needs_merchant_reply: false }
    setInboxData('AUTO', [], humanOwned)
    render(<UnifiedInbox />)

    const resume = await screen.findByRole('button', { name: /Resume AI/i })
    fireEvent.click(resume)
    await waitFor(() => expect(apiClient.updateConversation).toHaveBeenCalledWith('conv-1', { hitl: false }))
    expect(apiClient.createMessage).not.toHaveBeenCalled()
  })

  it('keeps Needs your reply after a delivered system HITL escalation', async () => {
    const hitlConversation = {
      ...baseConversation,
      hitl: true,
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'HITL_REQUIRED',
    }
    setInboxData('AUTO', [{
      id: 'msg-customer-handoff',
      conversation_id: 'conv-1',
      content: 'Can someone help?',
      sender: 'customer',
      created_at: new Date(Date.now() - 1000).toISOString(),
    }], hitlConversation)
    render(<UnifiedInbox />)

    await screen.findByText('Can someone help?')
    act(() => {
      latestSSECallbacks().onMessageDeliveryUpdated?.({
        conversation_id: 'conv-1',
        message_id: 'handoff-message',
        content: 'A human will help shortly.',
        delivery_state: 'SENT',
        delivery_source: 'HITL_ESCALATION',
        provider_message_id: 'mid-handoff',
        metadata: {
          delivery_state: 'SENT',
          delivery_source: 'HITL_ESCALATION',
          provider_message_id: 'mid-handoff',
          delivered: true,
        },
      })
    })

    await waitFor(() => expect(screen.getByRole('button', { name: /Needs your reply/i })).toHaveTextContent('1'))
  })

  it('clears the active claim after a mode change', async () => {
    setInboxData('AUTO', [{
      id: 'msg-customer-mode', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
      created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
    }])
    render(<UnifiedInbox />)

    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    act(() => {
      latestSSECallbacks().onAiReplyModeChanged?.({ mode: 'MANUAL' })
    })
    await waitFor(() => expect(screen.queryByText('AI is replying')).not.toBeInTheDocument())
    expect(screen.getByTestId('inbox-ai-reply-mode')).toHaveTextContent('Manual replies only')
  })

  it('clears the active claim after a successful manual send', async () => {
    setInboxData('AUTO', [{
      id: 'msg-customer-manual', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
      created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
    }])
    render(<UnifiedInbox />)
    const input = await screen.findByPlaceholderText(/Type your reply here/i)
    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    fireEvent.change(input, { target: { value: 'A manual reply' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('AI is replying')).not.toBeInTheDocument())
  })

  it('clears AI is replying when the backend pauses automation', async () => {
    setInboxData('AUTO', [{
      id: 'msg-customer-paused', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
      created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
    }])
    render(<UnifiedInbox />)

    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    act(() => {
      latestSSECallbacks().onAiPaused?.({ conversation_id: 'conv-1', reason: 'usage_exhausted' })
    })

    await waitFor(() => expect(screen.queryByText('AI is replying')).not.toBeInTheDocument())
    expect(screen.getByText('Needs your reply')).toBeInTheDocument()
  })

  it('clears the active claim after a failed manual send', async () => {
    setInboxData('AUTO', [{
      id: 'msg-customer-manual-fail', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
      created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
    }])
    ;(apiClient.createMessage as any).mockRejectedValueOnce(new Error('delivery failed'))
    render(<UnifiedInbox />)
    const failedInput = await screen.findByPlaceholderText(/Type your reply here/i)
    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    fireEvent.change(failedInput, { target: { value: 'This will fail' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => expect(screen.queryByText('AI is replying')).not.toBeInTheDocument())
  })

  it('clears draft-ready state when the held suggestion is dismissed', async () => {
    const { customerMessage, heldMessage } = draftMessages()
    setInboxData('DRAFT', [customerMessage, heldMessage])
    ;(apiClient.getMessages as any)
      .mockResolvedValueOnce({ messages: [customerMessage, heldMessage], pagination: { page: 1, totalPages: 1 } })
      .mockResolvedValue({ messages: [customerMessage], pagination: { page: 1, totalPages: 1 } })
    render(<UnifiedInbox />)
    expect(await screen.findByText('Draft ready for review')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }))
    await waitFor(() => expect(screen.queryByText('Draft ready for review')).not.toBeInTheDocument())
  })

  it('clears the active claim and exposes the failed terminal state on delivery failure', async () => {
    setInboxData('AUTO', [
      {
        id: 'msg-customer-failed', conversation_id: 'conv-1', content: 'Hello', sender: 'customer', message_type: 'text',
        created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(),
      },
      {
        id: 'msg-ai-failed', conversation_id: 'conv-1', content: 'Reply', sender: 'ai', message_type: 'text',
        delivery_state: 'SEND_PENDING', metadata: { delivery_state: 'SEND_PENDING', delivery_status: 'pending' },
        created_at: new Date(Date.now() - 30000).toISOString(), updated_at: new Date(Date.now() - 30000).toISOString(),
      },
    ])
    render(<UnifiedInbox />)

    expect(await screen.findByRole('status')).toHaveTextContent(/AI is replying/i)
    act(() => {
      latestSSECallbacks().onDeliveryFailed?.({ conversation_id: 'conv-1', message_id: 'msg-ai-failed', reason: 'Meta rejected it' })
    })

    await waitFor(() => {
      expect(screen.queryByText('AI is replying')).not.toBeInTheDocument()
      expect(screen.getByTestId('inbox-reply-status')).toHaveTextContent('AI reply failed')
    })
  })

})

describe('UnifiedInbox AI suggestion visibility (deliver-aware)', () => {
  const olderTs = new Date(Date.now() - 60 * 1000).toISOString()
  const newerTs = new Date(Date.now() - 30 * 1000).toISOString()
  const newestTs = new Date(Date.now() - 10 * 1000).toISOString()

  const customerMsg = {
    id: 'msg-customer-1',
    conversation_id: 'conv-1',
    content: 'Do you have this in red?',
    sender: 'customer' as const,
    message_type: 'text' as const,
    created_at: olderTs,
    updated_at: olderTs,
  }

  const aiMsg = (metadata: Record<string, unknown>, confidence = 0.9) => ({
    id: 'msg-ai-1',
    conversation_id: 'conv-1',
    content: 'AI draft reply',
    ai_suggestion: 'AI draft reply',
    ai_confidence: confidence,
    sender: 'ai' as const,
    message_type: 'text' as const,
    metadata,
    created_at: newerTs,
    updated_at: newerTs,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
    ;(apiClient.getShopAgents as any).mockResolvedValue([])
    ;(apiClient.updateConversation as any).mockResolvedValue({ id: 'conv-1', status: 'active' })
    ;(apiClient.markConversationRead as any).mockResolvedValue({ ...baseConversation, unreadCount: 0, lastReadMessageId: 'msg-read' })
    ;(apiClient.createMessage as any).mockResolvedValue({
      id: 'msg-retry',
      conversation_id: 'conv-1',
      content: 'catalog.pdf',
      sender: 'agent',
      message_type: 'file',
      metadata: {
        file_name: 'catalog.pdf',
        file_url: 'https://cdn.example.com/catalog.pdf',
        delivery_status: 'pending',
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  })

  const renderWith = (conv: any, messages: any[]) => {
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [conv],
      ai_reply_mode: conv.ai_reply_mode || 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages,
      pagination: { page: 1, totalPages: 1 },
    })
    render(<UnifiedInbox />)
  }

  it('HIDES the suggestion panel when the last AI reply was auto-delivered', async () => {
    renderWith({ ...baseConversation, ai_reply_mode: 'AUTO' }, [customerMsg, aiMsg({ delivered: true })])

    // Wait for the thread to render (customer bubble present)…
    await waitFor(() => {
      expect(screen.getByText('Do you have this in red?')).toBeInTheDocument()
    })
    // …then the redundant "Send this" suggestion panel must NOT be present.
    expect(screen.queryByRole('button', { name: /Send this/i })).not.toBeInTheDocument()
  })

  it('keeps an unsent AI candidate out of the normal transcript', async () => {
    renderWith({ ...baseConversation, ai_reply_mode: 'DRAFT' }, [
      customerMsg,
      aiMsg({ delivery_state: 'DRAFT_READY', delivered: false, held_reason: 'draft_mode', suggestion_visibility: 'VISIBLE_DRAFT_REVIEW' }),
    ])

    await waitFor(() => expect(screen.getByText('DRAFT — NOT SENT')).toBeInTheDocument())
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument()
  })

  // MW-V1 §11.1: a policy-blocked candidate is explained truthfully — the
  // stored reason class only; no invented specifics, no provider internals.
  it('explains a policy-blocked AI reply and routes the merchant to recovery', async () => {
    renderWith({ ...baseConversation, ai_reply_mode: 'AUTO' }, [
      customerMsg,
      aiMsg({ delivery_state: 'HELD', delivered: false, held_reason: 'policy_blocked', suggestion_visibility: 'VISIBLE_HITL_REVIEW' }),
    ])

    expect(await screen.findByText(/messaging rules/i)).toBeInTheDocument()
    expect(screen.queryByText(/window closed/i)).not.toBeInTheDocument() // never invents the specific reason
    expect(screen.queryByText(/stack|token|secret|provider error id/i)).not.toBeInTheDocument()
  })

  it('hides normal AUTO suggestions and keeps the processing status non-interactive', async () => {
    renderWith({ ...baseConversation, ai_reply_mode: 'AUTO' }, [
      customerMsg,
      aiMsg({ delivery_state: 'SEND_PENDING', delivery_status: 'pending', delivered: false, suggestion_visibility: 'HIDDEN_AUTO_PROCESSING' }),
    ])
    await waitFor(() => expect(screen.getByTestId('inbox-reply-status')).toHaveTextContent('AI is preparing a reply'))
    expect(screen.queryByRole('button', { name: /Send this/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /AI is replying/i })).not.toBeInTheDocument()
  })

  it('does not show AI is replying for an attempted send with authoritative false state', async () => {
    renderWith({ ...baseConversation, ai_reply_mode: 'AUTO', ai_is_replying: false }, [
      customerMsg,
      aiMsg({
        delivery_state: 'SEND_PENDING',
        delivery_status: 'pending',
        provider_send_attempted: true,
        delivered: false,
        suggestion_visibility: 'HIDDEN_AUTO_PROCESSING',
      }),
    ])

    await waitFor(() => expect(screen.getByText('Do you have this in red?')).toBeInTheDocument())
    expect(screen.queryByText('AI is preparing a reply')).not.toBeInTheDocument()
    expect(screen.queryByText('AI is replying')).not.toBeInTheDocument()
  })

  it('clears the previous thread immediately when another conversation is selected', async () => {
    const otherConversation = {
      ...baseConversation,
      id: 'conv-2',
      customer_id: 'cust-2',
      customer: { id: 'cust-2', name: 'Bob' },
    }
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation, otherConversation],
      ai_reply_mode: 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getMessages as any).mockImplementation(async (conversationId: string) => ({
      messages: conversationId === 'conv-1'
        ? [{
            id: 'msg-alice-only',
            conversation_id: 'conv-1',
            sender: 'customer',
            content: 'Alice thread message',
            created_at: new Date().toISOString(),
          }]
        : [],
      pagination: { page: 1, totalPages: 1 },
    }))
    render(<UnifiedInbox />)

    await screen.findByText('Alice thread message')
    fireEvent.click(screen.getAllByText('Bob')[0])

    expect(screen.queryByText('Alice thread message')).not.toBeInTheDocument()
  })

  it('shows a clearly labelled HITL suggestion when AUTO requires human review', async () => {
    const hitlConversation = { ...baseConversation, ai_reply_mode: 'AUTO', hitl: true }
    renderWith(hitlConversation, [
      customerMsg,
      aiMsg({ delivery_state: 'HELD', delivered: false, held_reason: 'low_confidence', suggestion_visibility: 'VISIBLE_HITL_REVIEW' }),
    ])
    expect(await screen.findByText('Human review required')).toBeInTheDocument()
    expect(screen.getByText('AI suggestion — NOT SENT')).toBeInTheDocument()
  })

  it('removes a stale HITL suggestion immediately when Resume emits terminal dismissal', async () => {
    const hitlConversation = { ...baseConversation, ai_reply_mode: 'AUTO', hitl: true }
    renderWith(hitlConversation, [
      customerMsg,
      aiMsg({ delivery_state: 'HELD', delivered: false, held_reason: 'human_active', suggestion_visibility: 'VISIBLE_HITL_REVIEW' }),
    ])

    expect(await screen.findByText('Human review required')).toBeInTheDocument()
    expect(screen.getByText('AI suggestion — NOT SENT')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Resume AI/i }))
    await waitFor(() => expect(apiClient.updateConversation).toHaveBeenCalledWith('conv-1', { hitl: false }))

    act(() => {
      latestSSECallbacks().onMessageDeliveryUpdated?.({
        conversation_id: 'conv-1',
        message_id: 'msg-ai-1',
        delivery_state: 'DISMISSED',
        metadata: {
          delivery_state: 'DISMISSED',
          delivery_status: 'dismissed',
          suggestion_visibility: 'HIDDEN_DISMISSED',
          held_reason: 'resume_obsolete',
          dismissed_by_resume: true,
        },
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Human review required')).not.toBeInTheDocument()
      expect(screen.queryByText('AI suggestion — NOT SENT')).not.toBeInTheDocument()
    })
  })

  it('renders a resolved Messenger reply quote without duplicating the referenced message', async () => {
    renderWith(baseConversation, [{
      ...customerMsg,
      content: 'L',
      metadata: {
        reply_to: {
          provider_message_id: 'mid-question',
          status: 'resolved',
          sender: 'ai',
          content: 'Which size would you like, M or L?',
          message_type: 'text',
        },
      },
    }])

    expect(await screen.findByText('Which size would you like, M or L?')).toBeInTheDocument()
    expect(screen.getAllByText('L')).toHaveLength(1)
  })

  it('deduplicates repeated SSE messages by message identity', async () => {
    renderWith(baseConversation, [customerMsg])
    await waitFor(() => expect(screen.getByText('Do you have this in red?')).toBeInTheDocument())
    const callback = latestSSECallbacks()
    const newMessage = {
      id: 'new-customer-message', conversation_id: 'conv-1', content: 'One event', sender: 'customer' as const, message_type: 'text' as const,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    act(() => {
      callback.onNewMessage({ conversation_id: 'conv-1', message: newMessage })
      callback.onNewMessage({ conversation_id: 'conv-1', message: newMessage })
    })
    await waitFor(() => {
      // One transcript bubble plus one list preview proves the duplicate SSE
      // did not create a second message bubble.
      expect(screen.getAllByText('One event')).toHaveLength(2)
    })
  })

  it('keeps an SSE message when the stale page-one fetch resolves afterward', async () => {
    const fetchedMessage = {
      id: 'fetched-message', conversation_id: 'conv-1', content: 'Fetched before the event', sender: 'customer' as const, message_type: 'text' as const,
      created_at: new Date(Date.now() - 1000).toISOString(), updated_at: new Date(Date.now() - 1000).toISOString(),
    }
    const sseMessage = {
      id: 'sse-message', conversation_id: 'conv-1', content: 'Arrived over SSE', sender: 'customer' as const, message_type: 'text' as const,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    let resolveMessages!: (value: { messages: any[]; pagination: { page: number; totalPages: number } }) => void
    ;(apiClient.getMessages as any).mockImplementation(() => new Promise((resolve) => {
      resolveMessages = resolve
    }))

    render(<UnifiedInbox />)
    await waitFor(() => expect(latestSSECallbacks()).toBeTruthy())

    act(() => {
      latestSSECallbacks().onNewMessage({ conversation_id: 'conv-1', message: sseMessage })
    })
    expect(await screen.findByText('Arrived over SSE')).toBeInTheDocument()

    act(() => {
      resolveMessages({ messages: [fetchedMessage], pagination: { page: 1, totalPages: 1 } })
    })
    await waitFor(() => expect(screen.getByText('Fetched before the event')).toBeInTheDocument())
    expect(screen.getAllByText('Arrived over SSE').length).toBeGreaterThan(0)
  })

  it('keeps an SSE reopen projection when a stale conversation fetch resolves afterward', async () => {
    const staleClosedConversation = { ...baseConversation, status: 'closed' as const }
    let resolveConversations!: (value: { data: any[]; ai_reply_mode: string; pagination: { page: number; totalPages: number } }) => void
    ;(apiClient.getConversations as any)
      .mockResolvedValueOnce({
        data: [baseConversation],
        ai_reply_mode: 'MANUAL',
        pagination: { page: 1, totalPages: 1 },
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveConversations = resolve }))

    render(<UnifiedInbox />)
    await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument())

    const callback = latestSSECallbacks()
    act(() => {
      callback.onSSEOnline?.()
      callback.onSSEOnline?.()
    })
    act(() => {
      callback.onNewMessage({
        conversation_id: 'conv-1',
        message: {
          id: 'reopen-message',
          conversation_id: 'conv-1',
          content: 'New inbound after resolve',
          sender: 'customer' as const,
          message_type: 'text' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      })
    })

    act(() => {
      resolveConversations({
        data: [staleClosedConversation],
        ai_reply_mode: 'MANUAL',
        pagination: { page: 1, totalPages: 1 },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('1 active')).toBeInTheDocument()
      expect(screen.getByText('Needs your reply')).toBeInTheDocument()
    })
  })

  it('does not consume an SSE id received while its conversation is unselected', async () => {
    const otherConversation = {
      ...baseConversation,
      id: 'conv-2',
      customer_id: 'cust-2',
      customer: { id: 'cust-2', name: 'Bob' },
    }
    const message = {
      id: 'unselected-message', conversation_id: 'conv-2', content: 'Message for Bob', sender: 'customer' as const, message_type: 'text' as const,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    let resolveOtherMessages!: (value: { messages: any[]; pagination: { page: number; totalPages: number } }) => void
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation, otherConversation],
      ai_reply_mode: 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getMessages as any).mockImplementation((conversationId: string) => (
      conversationId === 'conv-1'
        ? Promise.resolve({ messages: [], pagination: { page: 1, totalPages: 1 } })
        : new Promise((resolve) => { resolveOtherMessages = resolve })
    ))

    render(<UnifiedInbox />)
    await waitFor(() => expect(screen.getAllByText('Bob').length).toBeGreaterThan(0))

    act(() => {
      latestSSECallbacks().onNewMessage({ conversation_id: 'conv-2', message })
    })
    fireEvent.click(screen.getAllByText('Bob')[0])

    await waitFor(() => expect(latestSSECallbacks()).toBeTruthy())
    act(() => {
      latestSSECallbacks().onNewMessage({ conversation_id: 'conv-2', message })
    })
    expect(await screen.findByText('Message for Bob')).toBeInTheDocument()

    act(() => {
      resolveOtherMessages({ messages: [], pagination: { page: 1, totalPages: 1 } })
    })
    await waitFor(() => expect(screen.getByText('Message for Bob')).toBeInTheDocument())
  })

  it('SHOWS the held suggestion even when the conversation is in HITL (handoff)', async () => {
    renderWith({ ...baseConversation, hitl: true }, [
      customerMsg,
      aiMsg({ delivered: false, held_reason: 'draft_mode' }),
    ])

    expect(await screen.findByRole('button', { name: /Send this/i })).toBeInTheDocument()
  })

  it('shows the low-confidence note only when held_reason is low_confidence', async () => {
    renderWith({ ...baseConversation, hitl: true }, [
      customerMsg,
      aiMsg({ delivered: false, held_reason: 'low_confidence' }, 0.9),
    ])

    expect(await screen.findByText(/Low confidence/i)).toBeInTheDocument()
  })

  it('surfaces the held draft, not the delivered holding message, after a handoff', async () => {
    const holdingMsg = {
      id: 'msg-ai-holding',
      conversation_id: 'conv-1',
      content: 'A representative will reply shortly.',
      sender: 'ai' as const,
      message_type: 'text' as const,
      metadata: { delivered: true, type: 'escalation_auto_reply' },
      created_at: newestTs,
      updated_at: newestTs,
    }
    renderWith({ ...baseConversation, hitl: true }, [
      customerMsg,
      aiMsg({ delivered: false, held_reason: 'low_confidence' }, 0.4),
      holdingMsg,
    ])

    // Even though the newest AI message is a delivered holding message, the panel
    // must surface the earlier HELD draft (with its low-confidence note).
    expect(await screen.findByRole('button', { name: /Send this/i })).toBeInTheDocument()
    expect(screen.getByText(/Low confidence/i)).toBeInTheDocument()
  })

  it('renders inbound/outbound attachments and retries failed outbound delivery', async () => {
    const inboundImage = {
      id: 'msg-image-in',
      conversation_id: 'conv-1',
      content: '[Attachment]',
      sender: 'customer' as const,
      message_type: 'image' as const,
      metadata: { image_url: 'https://cdn.example.com/inbound.png' },
      created_at: olderTs,
      updated_at: olderTs,
    }
    const outboundFile = {
      id: 'msg-file-out',
      conversation_id: 'conv-1',
      content: 'catalog.pdf',
      sender: 'agent' as const,
      message_type: 'file' as const,
      metadata: {
        file_name: 'catalog.pdf',
        file_url: 'https://api.easymod.tech/uploads/conversation-attachments/shop-1/catalog.pdf?expires=1&signature=expired',
        attachment_source: 'inbox_upload',
        attachment_storage_key: 'shop-1/catalog.pdf',
        attachment_available: true,
        delivery_status: 'failed',
        delivery_error: 'Meta API rejected the attachment',
      },
      created_at: newerTs,
      updated_at: newerTs,
    }

    renderWith(baseConversation, [inboundImage, outboundFile])

    expect(await screen.findByAltText('Attachment')).toHaveAttribute('src', 'https://cdn.example.com/inbound.png')
    expect(screen.getByText('catalog.pdf')).toBeInTheDocument()
    expect(screen.getByText('Download file')).toHaveAttribute('href', 'https://api.easymod.tech/uploads/conversation-attachments/shop-1/catalog.pdf?expires=1&signature=expired')
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))

    await waitFor(() => {
      expect(apiClient.createMessage).toHaveBeenCalledWith('conv-1', expect.objectContaining({
        content: 'catalog.pdf',
        sender: 'agent',
        message_type: 'file',
        metadata: expect.objectContaining({
          file_name: 'catalog.pdf',
          file_url: 'https://api.easymod.tech/uploads/conversation-attachments/shop-1/catalog.pdf?expires=1&signature=expired',
          attachment_source: 'inbox_upload',
          attachment_storage_key: 'shop-1/catalog.pdf',
          delivery_status: 'pending',
        }),
      }), expect.objectContaining({ idempotencyKey: expect.any(String) }))
    })
  })

  it('renders an explicit unavailable state for a missing attachment', async () => {
    const missingImage = {
      id: 'msg-image-missing',
      conversation_id: 'conv-1',
      content: '[Attachment]',
      sender: 'customer' as const,
      message_type: 'image' as const,
      metadata: {
        message_type: 'image',
        attachment_source: 'inbox_upload',
        attachment_storage_key: 'shop-1/missing.png',
        attachment_available: false,
      },
      created_at: olderTs,
      updated_at: olderTs,
    }

    renderWith(baseConversation, [missingImage])

    expect(await screen.findByRole('status')).toHaveTextContent('Attachment unavailable')
  })

  it('falls back when an attachment disappears after serialization', async () => {
    const image = {
      id: 'msg-image-race',
      conversation_id: 'conv-1',
      content: '[Attachment]',
      sender: 'customer' as const,
      message_type: 'image' as const,
      metadata: { image_url: 'https://api.easymod.tech/uploads/conversation-attachments/shop-1/race.png' },
      created_at: olderTs,
      updated_at: olderTs,
    }

    renderWith(baseConversation, [image])
    const renderedImage = await screen.findByAltText('Attachment')
    fireEvent.error(renderedImage)

    expect(await screen.findByText('Attachment unavailable')).toBeInTheDocument()
  })

  it('renders each native attachment type from metadata', async () => {
    const nativeAttachments = {
      id: 'msg-native-attachments',
      conversation_id: 'conv-1',
      content: '[Attachments]',
      sender: 'customer' as const,
      message_type: 'file' as const,
      metadata: {
        attachments: [
          { type: 'image', url: 'https://cdn.example.com/inline.png' },
          { type: 'video', url: 'https://cdn.example.com/demo.mp4' },
          { type: 'audio', url: 'https://cdn.example.com/voice.ogg' },
          { type: 'file', url: 'https://cdn.example.com/guide.pdf', name: 'guide.pdf' },
          { type: 'sticker', url: 'https://cdn.example.com/sticker.webp' },
        ],
      },
      created_at: olderTs,
      updated_at: olderTs,
    }

    renderWith(baseConversation, [nativeAttachments])

    expect(await screen.findByAltText('Inline image')).toHaveAttribute('src', 'https://cdn.example.com/inline.png')
    expect(screen.getByText('Video')).toBeInTheDocument()
    expect(screen.getByText('Voice message')).toBeInTheDocument()
    expect(screen.getByText('guide.pdf')).toBeInTheDocument()
    expect(screen.getByText('Sticker')).toBeInTheDocument()
  })

  it('explains AUTO resume after resolve and sends the last seen message id', async () => {
    ;(apiClient.updateConversation as any).mockResolvedValue({
      ...baseConversation,
      status: 'closed',
      hitl: false,
    })
    renderWith({ ...baseConversation, ai_reply_mode: 'AUTO' }, [customerMsg])

    await screen.findByText(customerMsg.content)
    fireEvent.click(await screen.findByRole('button', { name: /^Resolve$/i }))
    expect(screen.getByText('AI will resume for the next eligible customer message.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Mark Resolved/i }))
    await waitFor(() => {
      expect(apiClient.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
        status: 'closed',
        last_seen_message_id: 'msg-customer-1',
      }))
    })
  })

  it('does not offer a blind retry after a provider call has started', async () => {
    const providerAttemptedFile = {
      id: 'msg-file-unknown',
      conversation_id: 'conv-1',
      content: 'catalog.pdf',
      sender: 'agent' as const,
      message_type: 'file' as const,
      metadata: {
        file_name: 'catalog.pdf',
        delivery_status: 'failed',
        provider_send_attempted: true,
      },
      created_at: newerTs,
      updated_at: newerTs,
    }

    renderWith(baseConversation, [providerAttemptedFile])

    expect(await screen.findByText('Provider result pending reconciliation')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument()
  })
})

// FE-01: quick-reply fallbacks must be claim-free, and merchant templates must
// win whenever they exist — including when the templates API fails.
describe('FE-01 quick reply fallback wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [],
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      ai_reply_mode: 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.markConversationRead as any).mockResolvedValue({
      ...baseConversation,
      unreadCount: 0,
      lastReadMessageId: 'msg-read',
    })
  })

  const openQuickReplies = async () => {
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /quick replies/i }))
  }

  it('shows only neutral fallback chips when the shop has no templates', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
    render(<UnifiedInbox />)
    await openQuickReplies()

    expect(await screen.findByText('Let me check')).toBeInTheDocument()
    const legacyClaimLabels = ['Order Confirmed', 'Courier Update', 'Advance Payment', 'Out of Stock', 'Delivery Charge', 'Return Window', 'Cash on Delivery', 'Dispatch Today']
    for (const label of legacyClaimLabels) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('inserting a fallback yields claim-free text into the editable composer only (no auto-send)', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
    render(<UnifiedInbox />)
    await openQuickReplies()
    fireEvent.click(await screen.findByText('Need Address'))

    const composer = screen.getByPlaceholderText(/Type your reply here/i) as HTMLTextAreaElement
    expect(composer.value).toMatch(/ঠিকানা|নম্বর/)
    expect(composer.value).not.toMatch(/৳\s?\d|stock|courier|paid|confirmed|COD/i)
    expect(apiClient.createMessage).not.toHaveBeenCalled()
  })

  it('falls back to the neutral chips instead of crashing when the templates API fails', async () => {
    ;(apiClient.getResponseTemplates as any).mockRejectedValue(new Error('boom'))
    render(<UnifiedInbox />)
    await openQuickReplies()

    expect(await screen.findByText('Let me check')).toBeInTheDocument()
  })

  it('lists merchant templates and hides fallbacks when the merchant has any', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([
      { id: 'tpl-1', name: 'My shop reply', content: 'Shop answer', category: 'Quick Reply', is_active: true },
    ])
    render(<UnifiedInbox />)
    await openQuickReplies()

    expect(await screen.findByText('My shop reply')).toBeInTheDocument()
    expect(screen.queryByText('Let me check')).not.toBeInTheDocument()
  })

  it('ignores inactive merchant templates without resurrecting claim fallbacks', async () => {
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([
      { id: 'tpl-1', name: 'Retired reply', content: 'old', is_active: false },
    ])
    render(<UnifiedInbox />)
    await openQuickReplies()

    expect(await screen.findByText('Let me check')).toBeInTheDocument()
    expect(screen.queryByText('Retired reply')).not.toBeInTheDocument()
  })
})

// MW-V1: the customer-context toggle opens the panel for the LIVE conversation,
// and while the customer_intelligence flag is OFF the gated detail is never fetched.
describe('MW-V1 customer-context mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiClient.getConversations as any).mockResolvedValue({
      data: [baseConversation],
      ai_reply_mode: 'MANUAL',
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [],
      pagination: { page: 1, totalPages: 1 },
    })
    ;(apiClient.markConversationRead as any).mockResolvedValue(baseConversation)
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
  })

  it('toggle opens the panel; gated 360 read stays untouched when flag is off', async () => {
    const ci = await import('@/api/domains/customer-intelligence')
    render(<MemoryRouter><UnifiedInbox /></MemoryRouter>)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your reply here/i)).toBeInTheDocument()
    })

    expect(screen.queryByTestId('customer-context-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('context-toggle'))

    const panel = await screen.findByTestId('customer-context-panel')
    expect(panel).toBeInTheDocument()
    // honest state even for a flag-off / possibly-unlinked conversation:
    expect(ci.getCustomer360).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('context-close'))
    await waitFor(() => expect(screen.queryByTestId('customer-context-panel')).not.toBeInTheDocument())
  })
})

describe('UnifiedInbox integration contracts', () => {
  const pageSize = 50
  const conversation = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...baseConversation,
    id,
    customer_id: `customer-${id}`,
    customer: { id: `customer-${id}`, name: id === 'conv-1' ? 'Alice' : 'Bob' },
    ...overrides,
  })
  const pageResult = (data: any[], page: number, total = 51) => ({
    data,
    page,
    pageSize,
    total,
    ai_reply_mode: 'MANUAL',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    routerState.location.search = ''
    routerState.navigate.mockClear()
    ;(apiClient.getResponseTemplates as any).mockReset().mockResolvedValue([])
    ;(apiClient.getShopAgents as any).mockReset().mockResolvedValue([])
    ;(apiClient.markConversationRead as any).mockReset().mockResolvedValue({ ...baseConversation, unreadCount: 0 })
    ;(apiClient.getMessages as any).mockReset().mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } })
    ;(apiClient.getConversations as any).mockReset().mockResolvedValue(pageResult([conversation('conv-1')], 1))
    ;(getOrders as any).mockReset().mockResolvedValue([])
    ;(apiClient.createMessage as any).mockReset().mockResolvedValue({})
  })

  it('loads the next server page and points the URL at its selected conversation', async () => {
    const firstPage = conversation('conv-1')
    const secondPage = conversation('conv-2')
    ;(apiClient.getConversations as any).mockImplementation(async ({ page = 1 }: { page?: number }) => (
      pageResult(page === 1 ? [firstPage] : [secondPage], page)
    ))

    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    fireEvent.click(await screen.findByRole('button', { name: /Next page/i }))

    await screen.findByText('Bob', { selector: 'h3' })
    expect(apiClient.getConversations).toHaveBeenLastCalledWith({ page: 2, limit: pageSize })
    expect(screen.getByText(/Page 2 of 2/i)).toBeInTheDocument()
    expect(routerState.navigate).toHaveBeenLastCalledWith(
      { search: '?page=2&conversation=conv-2' },
      { replace: true },
    )
  })

  it('clamps an out-of-range deep-linked page to the last page', async () => {
    routerState.location.search = '?source=customer&page=99'
    const lastPage = conversation('conv-2')
    ;(apiClient.getConversations as any).mockImplementation(async ({ page = 1 }: { page?: number }) => (
      page === 99 ? pageResult([], 99) : pageResult([lastPage], page)
    ))

    render(<UnifiedInbox />)

    await screen.findByText('Bob', { selector: 'h3' })
    expect(apiClient.getConversations).toHaveBeenNthCalledWith(1, { page: 99, limit: pageSize })
    expect(apiClient.getConversations).toHaveBeenNthCalledWith(2, { page: 2, limit: pageSize })
    expect(screen.getByText(/Page 2 of 2/i)).toBeInTheDocument()
    expect(routerState.navigate).toHaveBeenLastCalledWith(
      { search: '?source=customer&page=2&conversation=conv-2' },
      { replace: true },
    )
  })

  it('restores the URL filter and preserves it when a conversation is selected by keyboard', async () => {
    routerState.location.search = '?source=customer-profile&tab=needs_review'
    const needsReply = conversation('conv-1', {
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED',
    })
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([needsReply], 1, 1))

    render(<UnifiedInbox />)
    const row = await screen.findByRole('button', { name: /Alice/i })
    expect(screen.getByRole('button', { name: /Needs your reply/i })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(routerState.navigate).toHaveBeenLastCalledWith(
      { search: '?source=customer-profile&tab=needs_review&conversation=conv-1' },
      { replace: true },
    )
  })

  it('resets to page one once when a page-local filter changes and avoids duplicate pending loads', async () => {
    let resolveFirstPage!: (value: ReturnType<typeof pageResult>) => void
    const firstPage = conversation('conv-1')
    const secondPage = conversation('conv-2')
    ;(apiClient.getConversations as any)
      .mockResolvedValueOnce(pageResult([firstPage], 1))
      .mockResolvedValueOnce(pageResult([secondPage], 2))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstPage = resolve }))

    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    fireEvent.click(await screen.findByRole('button', { name: /Next page/i }))
    await screen.findByText('Bob', { selector: 'h3' })
    fireEvent.click(screen.getByRole('button', { name: /Needs your reply/i }))
    await waitFor(() => expect(apiClient.getConversations).toHaveBeenCalledTimes(3))
    fireEvent.change(screen.getByPlaceholderText(/search customers/i), { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: /^Done/i }))
    expect(apiClient.getConversations).toHaveBeenCalledTimes(3)

    resolveFirstPage(pageResult([firstPage], 1))
    await waitFor(() => expect(screen.getByText(/Page 1 of 2/i)).toBeInTheDocument())
  })

  it('refreshes the requested page after SSE reconnect while a page transition is pending', async () => {
    const firstPage = conversation('conv-1')
    const secondPage = conversation('conv-2')
    ;(apiClient.getConversations as any).mockImplementation(async ({ page = 1 }: { page?: number }) => (
      pageResult(page === 1 ? [firstPage] : [secondPage], page)
    ))

    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    act(() => latestSSECallbacks().onSSEOnline?.())
    fireEvent.click(await screen.findByRole('button', { name: /Next page/i }))
    await screen.findByText('Bob', { selector: 'h3' })
    act(() => latestSSECallbacks().onSSEOnline?.())

    await waitFor(() => {
      expect(apiClient.getConversations).toHaveBeenLastCalledWith({ page: 2, limit: pageSize })
    })
    expect(apiClient.getConversations).toHaveBeenCalledTimes(3)
  })

  it('keeps the prior page visible and exposes an accessible retry when paging fails', async () => {
    const firstPage = conversation('conv-1')
    const secondPage = conversation('conv-2')
    ;(apiClient.getConversations as any)
      .mockResolvedValueOnce(pageResult([firstPage], 1))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(pageResult([secondPage], 2))

    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    fireEvent.click(await screen.findByRole('button', { name: /Next page/i }))

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent(/load conversations/i)
    expect(screen.getByText('Alice', { selector: 'h3' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    await screen.findByText('Bob', { selector: 'h3' })
    expect(apiClient.getConversations).toHaveBeenLastCalledWith({ page: 2, limit: pageSize })
  })

  it('announces an empty search and filter result and explains it is page-local', async () => {
    const noReply = conversation('conv-1')
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([noReply], 1))

    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    fireEvent.change(screen.getByPlaceholderText(/search customers/i), { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: /Needs your reply/i }))

    expect(screen.getByRole('status')).toHaveTextContent(/search and filter/i)
    expect(screen.getByText(/apply only to this page/i)).toBeInTheDocument()
  })

  it('does not clear a provider-confirmed AI reply status during a language refresh', async () => {
    const { default: i18n } = await import('@/i18n')
    const autoConversation = conversation('conv-1', { ai_is_replying: false })
    const confirmedAiReply = {
      id: 'ai-confirmed',
      conversation_id: 'conv-1',
      content: 'The catalog is ready.',
      sender: 'ai',
      message_type: 'text',
      delivery_state: 'SENT',
      provider_message_id: 'provider-1',
      metadata: { delivery_state: 'SENT', delivery_status: 'sent', provider_message_id: 'provider-1' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const earlierCustomerMessage = {
      id: 'customer-before-ai', conversation_id: 'conv-1', content: 'Is this in stock?', sender: 'customer',
      message_type: 'text', created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    }
    ;(apiClient.getConversations as any).mockResolvedValue({ ...pageResult([autoConversation], 1, 1), ai_reply_mode: 'AUTO' })
    ;(apiClient.getMessages as any).mockResolvedValue({ messages: [earlierCustomerMessage, confirmedAiReply], pagination: { page: 1, totalPages: 1 } })

    render(<UnifiedInbox />)
    expect(await screen.findByTestId('inbox-reply-status')).toHaveTextContent(/AI reply sent/i)
    await act(async () => { await i18n.changeLanguage('bn') })

    expect(await screen.findByTestId('inbox-reply-status')).toBeInTheDocument()
    await act(async () => { await i18n.changeLanguage('en') })
  })

  it('does not carry an AI reply status to another conversation', async () => {
    const autoConversation = conversation('conv-1', { ai_is_replying: false, ai_reply_mode: 'AUTO' })
    const otherConversation = conversation('conv-2', { ai_is_replying: false, ai_reply_mode: 'AUTO' })
    const confirmedAiReply = {
      id: 'ai-confirmed', conversation_id: 'conv-1', content: 'Confirmed', sender: 'ai', message_type: 'text',
      delivery_state: 'SENT', provider_message_id: 'provider-1',
      metadata: { delivery_state: 'SENT', delivery_status: 'sent', provider_message_id: 'provider-1' },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    const earlierCustomerMessage = {
      id: 'customer-before-ai', conversation_id: 'conv-1', content: 'Is this in stock?', sender: 'customer',
      message_type: 'text', created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    }
    ;(apiClient.getConversations as any).mockResolvedValue({
      ...pageResult([autoConversation, otherConversation], 1, 2),
      ai_reply_mode: 'AUTO',
    })
    ;(apiClient.getMessages as any).mockImplementation(async (conversationId: string) => ({
      messages: conversationId === 'conv-1' ? [earlierCustomerMessage, confirmedAiReply] : [],
      pagination: { page: 1, totalPages: 1 },
    }))

    render(<UnifiedInbox />)
    expect(await screen.findByTestId('inbox-reply-status')).toHaveTextContent(/AI reply sent/i)
    fireEvent.click(await screen.findByRole('button', { name: /Bob/i }))

    await waitFor(() => expect(screen.queryByTestId('inbox-reply-status')).not.toBeInTheDocument())
  })

  it('does not let an older conversation refresh overwrite a newer AI mode event', async () => {
    const current = conversation('conv-1', { ai_is_replying: false })
    ;(apiClient.getConversations as any).mockResolvedValue({
      ...pageResult([current], 1, 1), ai_reply_mode: 'MANUAL',
    })
    render(<UnifiedInbox />)
    await screen.findByText('Alice', { selector: 'h3' })
    act(() => latestSSECallbacks().onSSEOnline?.())

    let resolveOlderRefresh!: (value: ReturnType<typeof pageResult> & { ai_reply_mode: string }) => void
    ;(apiClient.getConversations as any).mockImplementationOnce(() => new Promise((resolve) => {
      resolveOlderRefresh = resolve;
    }))
    act(() => latestSSECallbacks().onSSEOnline?.())
    await waitFor(() => expect(apiClient.getConversations).toHaveBeenCalledTimes(2))
    act(() => latestSSECallbacks().onAiReplyModeChanged?.({ mode: 'AUTO' }))
    expect(await screen.findByText(/AUTO/i)).toBeInTheDocument()

    resolveOlderRefresh({ ...pageResult([current], 1, 1), ai_reply_mode: 'MANUAL' })
    await waitFor(() => expect(screen.getByText(/AUTO/i)).toBeInTheDocument())
  })

  it('keeps tablet Inbox in one-pane mode until a conversation is opened', async () => {
    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 })
    ;(apiClient.getMessages as any).mockResolvedValue({
      messages: [{ id: 'unread', conversation_id: 'conv-1', sender: 'customer', content: 'Please help', created_at: new Date().toISOString() }],
      pagination: { page: 1, totalPages: 1 },
    })

    try {
      const { container } = render(<UnifiedInbox />)
      await screen.findByRole('button', { name: /Alice/i })
      const workbench = container.querySelector('.mw-inbox-workbench')
      const conversationList = workbench?.children[0]
      const conversationDetail = workbench?.children[1]
      expect(conversationList?.className).toContain('lg:w-80')
      expect(conversationList?.className).toContain('lg:flex')
      expect(conversationDetail?.className).toContain('lg:flex')
      expect(apiClient.markConversationRead).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: /Alice/i }))
      await screen.findByText('Please help')
      await waitFor(() => expect(apiClient.markConversationRead).toHaveBeenCalledWith('conv-1', 'unread'))
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
    }
  })

  it('opens the exact linked customer profile in a narrow context sheet without inventing an order link', async () => {
    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    const linked = conversation('conv-1', {
      customer_id: 'cust-exact',
      customer: { id: 'cust-exact', name: 'Alice' },
    })
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([linked], 1, 1))

    try {
      render(<MemoryRouter><UnifiedInbox /></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: /Alice/i }))
      fireEvent.click(await screen.findByTestId('context-toggle'))

      const panel = await screen.findByTestId('customer-context-panel')
      const profileLink = within(panel).getByRole('link', { name: /View customer profile/i })
      expect(profileLink).toHaveAttribute('href', '/customers?customerId=cust-exact')
      expect(getOrders).toHaveBeenCalledWith({ customer_id: 'cust-exact', limit: 3 })
      expect(within(panel).queryByTestId('context-order-row')).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
    }
  })

  it('does not infer customer or order links for an unlinked conversation', async () => {
    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    const unlinked = conversation('conv-1', { customer_id: null, customer: null, title: 'Unlinked thread' })
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([unlinked], 1, 1))

    try {
      render(<MemoryRouter><UnifiedInbox /></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: /Unlinked thread/i }))
      fireEvent.click(await screen.findByTestId('context-toggle'))

      const panel = await screen.findByTestId('customer-context-panel')
      expect(within(panel).getByTestId('context-no-link')).toBeInTheDocument()
      expect(within(panel).queryByRole('link', { name: /View customer profile/i })).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('context-order-row')).not.toBeInTheDocument()
      expect(getOrders).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
    }
  })

  it('keeps the reply task open and shows no success toast before provider confirmation', async () => {
    const needsReply = conversation('conv-1', {
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED',
    })
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([needsReply], 1, 1))
    ;(apiClient.createMessage as any).mockResolvedValue({
      id: 'msg-pending', conversation_id: 'conv-1', sender: 'agent', content: 'A reply waiting for confirmation',
      message_type: 'text', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })

    render(<UnifiedInbox />)
    fireEvent.change(await screen.findByPlaceholderText(/Type your reply here/i), {
      target: { value: 'A reply waiting for confirmation' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Alice/i })).toHaveTextContent(/Needs reply/i)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('offers the next reply task only after provider-confirmed delivery', async () => {
    const first = conversation('conv-1', { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED' })
    const next = conversation('conv-2', { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED' })
    ;(apiClient.getConversations as any).mockResolvedValue(pageResult([first, next], 1, 2))
    ;(apiClient.createMessage as any).mockResolvedValue({
      id: 'msg-confirmed', conversation_id: 'conv-1', sender: 'agent', content: 'Confirmed reply', message_type: 'text',
      delivery_state: 'SENT', provider_message_id: 'provider-message-1',
      metadata: { delivery_state: 'SENT', provider_message_id: 'provider-message-1' },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })

    render(<UnifiedInbox />)
    fireEvent.change(await screen.findByPlaceholderText(/Type your reply here/i), { target: { value: 'A verified reply' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const options = (toast.success as any).mock.calls.at(-1)?.[1]
    expect(options?.action?.label).toMatch(/Open next reply task/i)
    act(() => options?.action?.onClick())
    expect(routerState.navigate).toHaveBeenLastCalledWith({ search: '?conversation=conv-2' }, { replace: true })
  })

  it('reuses the send idempotency key when retrying the same draft after a lost response', async () => {
    ;(apiClient.createMessage as any)
      .mockRejectedValueOnce(new Error('Network response was lost'))
      .mockResolvedValueOnce({
        id: 'msg-replayed', conversation_id: 'conv-1', sender: 'agent', content: 'Same request',
        message_type: 'text', delivery_state: 'SEND_PENDING',
        metadata: { delivery_status: 'pending' },
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })

    render(<UnifiedInbox />)
    const composer = await screen.findByPlaceholderText(/Type your reply here/i)
    fireEvent.change(composer, { target: { value: 'Same request' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1))
    const firstKey = (apiClient.createMessage as any).mock.calls[0][2].idempotencyKey

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2))
    const retryKey = (apiClient.createMessage as any).mock.calls[1][2].idempotencyKey

    expect(retryKey).toBe(firstKey)
  })
})

describe('ADR-0013 inbox contract (reasons, owner, effective mode, stop, takeover)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiClient.getResponseTemplates as any).mockResolvedValue([])
    ;(apiClient.getMessages as any).mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } })
    ;(apiClient.getShopAgents as any).mockResolvedValue([])
    ;(apiClient.getConversations as any).mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1 } })
    ;(apiClient.updateConversation as any).mockResolvedValue({ id: 'conv-1', status: 'active', hitl: true, updated_at: new Date().toISOString() })
  })

  it('renders the reason through the literal display map, never a raw interpolated key', async () => {
    setInboxData('AUTO', [], {
      ...baseConversation,
      needs_merchant_reply: true,
      needs_merchant_reply_reason: 'HITL_REQUIRED',
    })
    render(<UnifiedInbox />)

    expect(await screen.findByText('Human takeover required')).toBeInTheDocument()
    expect(screen.queryByText(/inbox\.replyReason\.HITL_REQUIRED/)).not.toBeInTheDocument()
  })

  it('shows the owner/assignee chip in the thread list and detail header', async () => {
    setInboxData('AUTO', [], {
      ...baseConversation,
      assignee_id: 'agent-1',
      assignee: { id: 'agent-1', name: 'Nowrin Sultana' },
      hitl: true,
    })
    render(<UnifiedInbox />)

    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-owner-chip').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Nowrin Sultana').length).toBeGreaterThan(0)
    })
  })

  it('uses effective_ai_reply_mode for the inbox badge, falling back to the business mode', async () => {
    setInboxData('AUTO', [], {
      ...baseConversation,
      effective_ai_reply_mode: 'DRAFT',
      mode_source: 'channel_override',
    })
    render(<UnifiedInbox />)

    await waitFor(() =>
      expect(screen.getByTestId('inbox-ai-reply-mode')).toHaveTextContent('Drafts for review'),
    )
  })

  it('shows the PAUSED-billing badge when the conversation payload is billing-inactive', async () => {
    setInboxData('AUTO', [], {
      ...baseConversation,
      effective_ai_reply_mode: 'AUTO',
      billing_ai_active: false,
    })
    render(<UnifiedInbox />)

    await waitFor(() =>
      expect(screen.getByTestId('inbox-ai-reply-mode')).toHaveTextContent('Paused — billing'),
    )
    expect(screen.getByTestId('inbox-ai-reply-mode')).not.toHaveTextContent('Automatic replies')
  })

  it('shows the emergency-stop banner from the conversation payload', async () => {
    setInboxData('AUTO', [], {
      ...baseConversation,
      emergency_stop: { active: true, at: null, by: null, source: 'merchant', prior_mode: 'AUTO' },
    })
    render(<UnifiedInbox />)

    expect(await screen.findByTestId('emergency-stop-banner')).toHaveTextContent(
      /AI replies are stopped for every channel/,
    )
  })

  it('reacts to the emergency_stop_changed SSE event', async () => {
    setInboxData('AUTO', [], baseConversation)
    render(<UnifiedInbox />)
    await screen.findByTestId('inbox-ai-reply-mode')

    act(() => {
      latestSSECallbacks().onEmergencyStopChanged?.({ active: true })
    })

    expect(await screen.findByTestId('emergency-stop-banner')).toBeInTheDocument()
  })

  it('collects an optional takeover reason and PATCHes handoff_reason with hitl', async () => {
    setInboxData('AUTO', [], baseConversation)
    render(<UnifiedInbox />)

    const takeOverButtons = await screen.findAllByRole('button', { name: /^Take over$/i })
    fireEvent.click(takeOverButtons[0])

    const select = await screen.findByTestId('takeover-reason-select')
    fireEvent.change(select, { target: { value: 'customer_request' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Take over$/i }))

    await waitFor(() =>
      expect(apiClient.updateConversation).toHaveBeenCalledWith('conv-1', {
        hitl: true,
        handoff_reason: 'customer_request',
      }),
    )
  })
})
