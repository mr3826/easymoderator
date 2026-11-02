import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import RtoNetworkSettings from '@/app/components/RtoNetworkSettings'

const mockedAuth = vi.hoisted(() => ({ role: 'owner' }))

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: mockedAuth.role } }),
}))

vi.mock('@/api', () => ({
  apiClient: {
    getRtoNetworkSettings: vi.fn(),
    updateRtoNetworkSettings: vi.fn(),
  },
}))

beforeEach(async () => {
  mockedAuth.role = 'owner'
  const { apiClient } = await import('@/api')
  vi.mocked(apiClient.getRtoNetworkSettings).mockReset().mockResolvedValue({ contribute: true, enforce: true })
  vi.mocked(apiClient.updateRtoNetworkSettings).mockReset()
})

const openPanel = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Fake-Order Shield Network/i }))
}

describe('RtoNetworkSettings', () => {
  it('shows the stored consent state, not an assumed default', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getRtoNetworkSettings).mockResolvedValue({ contribute: false, enforce: true })
    render(<RtoNetworkSettings />)
    await openPanel()

    await screen.findByText('Use the shared network')
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(1)
  })

  it('a failed read is unavailable with a retry, never rendered as enabled choices', async () => {
    const { apiClient } = await import('@/api')
    vi.mocked(apiClient.getRtoNetworkSettings).mockRejectedValueOnce(new Error('network down'))
    render(<RtoNetworkSettings />)
    await openPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing is being assumed on or off/i)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('Use the shared network')).not.toBeInTheDocument()
    expect(screen.queryByText('Contribute my delivery results')).not.toBeInTheDocument()

    vi.mocked(apiClient.getRtoNetworkSettings).mockResolvedValue({ contribute: true, enforce: true })
    fireEvent.click(screen.getByTestId('rto-settings-retry'))
    await waitFor(() => expect(screen.getByText('Use the shared network')).toBeInTheDocument())
    expect(screen.queryByTestId('rto-settings-retry')).toBeNull()
  })

  it('non-owner members can read the state but cannot write from this surface', async () => {
    mockedAuth.role = 'staff'
    render(<RtoNetworkSettings />)
    await openPanel()

    expect(await screen.findByText('Use the shared network')).toBeInTheDocument()
    const switches = screen.getAllByRole('button', { pressed: true })
    expect(switches).toHaveLength(2)
    for (const toggle of switches) {
      expect(toggle).toBeDisabled()
    }
    expect(screen.getByTestId('rto-settings-owner-only-note')).toBeInTheDocument()
  })
})
