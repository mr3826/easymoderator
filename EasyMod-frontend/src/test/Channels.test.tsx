/**
 * ChatSettings (formerly Channels) — component integration tests.
 *
 * The Channels component was merged into ChatSettings.tsx in Phase 5.
 * Facebook-only launch (Instagram removed 2026-06-24): the connect entry-point
 * is a single Facebook Page OAuth button (handleConnect), and the picker
 * supports selecting one OR multiple Pages at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ChatSettings from '@/app/components/ChatSettings'
import { toast } from 'sonner'
import type { MetaChannel, MetaOAuthCallbackResult } from '@/api/domains/meta-channels'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, _options?: any) => {
      const map: Record<string, string> = {
        'channels.errors.oauthStateMismatch': 'OAuth validation failed — please try again',
        'channels.errors.connectionFailed': 'Connection failed — please try again',
        'channels.errors.oauthInitFailed': 'Could not start connection',
        'channels.connectCard.pageTaskRequired': 'Messaging and Page management access are required on this Page',
        'channels.connectCard.connectCount': 'Connect ({{count}})',
      }
      let s = map[key] ?? key
      if (_options && typeof _options === 'object') {
        for (const [k, v] of Object.entries(_options)) {
          s = s.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v))
        }
      }
      return s
    },
  }),
}))

// ── Hoist mocks ────────────────────────────────────────────────────────────────
const {
  mockListMetaChannels,
  mockInitiateMetaOAuth,
  mockHandleMetaOAuthCallback,
  mockConnectMetaAsset,
} = vi.hoisted(() => ({
  mockListMetaChannels:        vi.fn<() => Promise<MetaChannel[]>>().mockResolvedValue([]),
  mockInitiateMetaOAuth:       vi.fn(),
  mockHandleMetaOAuthCallback: vi.fn(),
  mockConnectMetaAsset:        vi.fn(),
}))

// Mock the meta-channels client — must include every named export ChatSettings imports
vi.mock('@/api/domains/meta-channels', () => ({
  listMetaChannels:               mockListMetaChannels,
  initiateMetaOAuth:              mockInitiateMetaOAuth,
  handleMetaOAuthCallback:        mockHandleMetaOAuthCallback,
  connectMetaAsset:               mockConnectMetaAsset,
  pingMetaChannel:                vi.fn(),
  disconnectMetaChannel:          vi.fn(),
  reconnectMetaChannel:           vi.fn(),
  getMetaChannelConsentSummary:   vi.fn(),
  updateMetaChannelPurposeLabel:  vi.fn(),
  getMetaChannelSettings:         vi.fn().mockResolvedValue({}),
  updateMetaChannelSettings:      vi.fn(),
  channelQueryKeys: { list: () => ['channels'], settings: (id: string) => ['channel-settings', id] },
}))

vi.mock('@/app/lib/useSubscriptionFeatures', () => ({
  useSubscriptionFeatures: () => ({
    plan: null,
    features: {},
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error:   vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

// BroadcastChannel is not available in happy-dom — provide a no-op stub so the
// OAuth path does not throw when it calls new BroadcastChannel().
class FakeBroadcastChannel {
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage() {}
  close() {}
}
vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)

const CONNECT_BTN = /channels\.connectCard\.title/i

// The connection hook now reads the shared react-query cache, so every render
// must sit inside a QueryClientProvider.
const renderChat = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <BrowserRouter>
      <QueryClientProvider client={client}>
        <ChatSettings />
      </QueryClientProvider>
    </BrowserRouter>,
  )
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ChatSettings (Channels)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListMetaChannels.mockResolvedValue([])
    // Return `window` so oauthPopupRef.current === window in the origin-filter test.
    vi.spyOn(window, 'open').mockReturnValue(window as any)
  })

  // ── 1. Render ───────────────────────────────────────────────────────────────
  it('renders the channel settings page with the Facebook connect button', async () => {
    await act(async () => {
      renderChat()
    })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: CONNECT_BTN })).toBeInTheDocument()
    })
  })

  // ── 2. Origin filter — wrong-origin postMessage is ignored ─────────────────
  it('ignores OAuth postMessage events from wrong origin', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://facebook.com/dialog/oauth?state=${'s'.repeat(64)}`,
    })
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [],
      tempToken: 't'.repeat(64),
      reconnectChannelId: null,
      reconnectAssetId: null,
    } as MetaOAuthCallbackResult)

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))

    await waitFor(() => {
      expect(mockInitiateMetaOAuth).toHaveBeenCalledWith('facebook')
    })

    // Dispatch a message from a hostile origin — the handler checks
    // e.origin !== window.location.origin and returns early.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example.com',
        source: window as any,
        data: { type: 'OAUTH_SUCCESS', code: 'abc', state: 's'.repeat(64) },
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockHandleMetaOAuthCallback).not.toHaveBeenCalled()
  })

  // ── 3. Error postMessage from same origin ──────────────────────────────────
  it('handles OAuth error postMessage from same origin', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({ redirectUrl: 'https://facebook.com/dialog/oauth' })

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))

    await waitFor(() => {
      expect(screen.getByText(/channels\.connectCard\.loginPopup/i)).toBeInTheDocument()
    })

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window as any,
        data: { type: 'OAUTH_ERROR', error: 'OAuth denied by user' },
      }),
    )

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(mockHandleMetaOAuthCallback).not.toHaveBeenCalled()
  })

  // ── 4. Page-picker connect button disabled until selection ─────────────────
  it('keeps the connect button disabled until at least one Page is selected', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://facebook.com/dialog/oauth?state=${'s'.repeat(64)}`,
    })
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [
        { id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: ['MESSAGING', 'MANAGE'], connectable: true, reason: null },
        { id: 'page-2', name: 'Page Two', category: null, pictureUrl: null, tasks: ['MESSAGING', 'MODERATE'], connectable: true, reason: null },
      ],
      tempToken: 't'.repeat(64),
      reconnectChannelId: null,
      reconnectAssetId: null,
    } as MetaOAuthCallbackResult)

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))

    await waitFor(() => {
      expect(mockInitiateMetaOAuth).toHaveBeenCalledWith('facebook')
    })

    // Simulate the OAuth popup replying with a success postMessage
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window as any,
        data: { type: 'OAUTH_SUCCESS', code: 'abc', state: 's'.repeat(64) },
      }),
    )

    await waitFor(() => {
      expect(screen.getByText('Page One')).toBeInTheDocument()
      expect(screen.getByText('Page Two')).toBeInTheDocument()
    })

    // "Connect (0)" must be disabled before any selection
    expect(screen.getByRole('button', { name: /Connect \(0\)/i })).toBeDisabled()

    // Selecting a checkbox enables the button
    const pageOneLabel = screen.getByText('Page One').closest('label') as HTMLElement
    const checkbox = pageOneLabel.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)

    expect(screen.getByRole('button', { name: /Connect \(1\)/i })).not.toBeDisabled()
  })

  it('shows mixed eligible and ineligible Pages without corrupting the selected count', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://facebook.com/dialog/oauth?state=${'s'.repeat(64)}`,
    })
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [
        { id: 'eligible', name: 'Eligible Page', category: null, pictureUrl: null, tasks: ['MESSAGING', 'CREATE_CONTENT'], connectable: true, reason: null },
        { id: 'blocked', name: 'Blocked Page', category: null, pictureUrl: null, tasks: ['MESSAGING'], connectable: false, reason: 'META_PAGE_TASKS_REQUIRED' },
      ],
      tempToken: 't'.repeat(64),
    })

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))
    await waitFor(() => expect(mockInitiateMetaOAuth).toHaveBeenCalledWith('facebook'))

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window as any,
        data: { type: 'OAUTH_SUCCESS', code: 'abc', state: 's'.repeat(64) },
      }),
    )

    await waitFor(() => expect(screen.getByText('Blocked Page')).toBeInTheDocument())
    const blockedCheckbox = screen.getByText('Blocked Page').closest('label')?.querySelector('input')
    expect(blockedCheckbox).toBeDisabled()
    expect(screen.getByText('Messaging and Page management access are required on this Page')).toBeInTheDocument()

    const eligibleCheckbox = screen.getByText('Eligible Page').closest('label')?.querySelector('input')
    expect(eligibleCheckbox).not.toBeDisabled()
    fireEvent.click(eligibleCheckbox!)
    expect(screen.getByRole('button', { name: /Connect \(1\)/i })).toBeEnabled()
  })

  it('renders a target-ID hydrated Page like an /me/accounts Page without source leakage', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://facebook.com/dialog/oauth?state=${'s'.repeat(64)}`,
    })
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [{
        id: 'hydrated',
        name: 'Business Portfolio Page',
        category: null,
        pictureUrl: null,
        tasks: ['MESSAGING', 'CREATE_CONTENT'],
        connectable: true,
        reason: null,
        source: 'GRANULAR_TARGET',
      }],
      tempToken: 't'.repeat(64),
    })

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))
    await waitFor(() => expect(mockInitiateMetaOAuth).toHaveBeenCalledWith('facebook'))
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window as any,
        data: { type: 'OAUTH_SUCCESS', code: 'abc', state: 's'.repeat(64) },
      }),
    )

    expect(await screen.findByText('Business Portfolio Page')).toBeInTheDocument()
    const checkbox = screen.getByText('Business Portfolio Page').closest('label')?.querySelector('input')
    expect(checkbox).not.toBeDisabled()
    expect(screen.queryByText('GRANULAR_TARGET')).not.toBeInTheDocument()
  })

  it('does not show success UI when the server rejects an ineligible Page', async () => {
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://facebook.com/dialog/oauth?state=${'s'.repeat(64)}`,
    })
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [{ id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: ['MESSAGING', 'MANAGE'], connectable: true, reason: null }],
      tempToken: 't'.repeat(64),
      reconnectChannelId: null,
      reconnectAssetId: null,
    } as MetaOAuthCallbackResult)
    mockConnectMetaAsset.mockRejectedValueOnce({
      statusCode: 403,
      code: 'META_PAGE_TASKS_REQUIRED',
      message: 'Page tasks are no longer sufficient',
    })

    await act(async () => {
      renderChat()
    })

    fireEvent.click(await screen.findByRole('button', { name: CONNECT_BTN }))
    await waitFor(() => expect(mockInitiateMetaOAuth).toHaveBeenCalledWith('facebook'))
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window as any,
        data: { type: 'OAUTH_SUCCESS', code: 'abc', state: 's'.repeat(64) },
      }),
    )

    const checkbox = await screen.findByRole('checkbox')
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: /Connect \(1\)/i }))

    await waitFor(() => expect(mockConnectMetaAsset).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByText('Page One')).toBeInTheDocument()
  })
})
