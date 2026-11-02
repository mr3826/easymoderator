import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import App from '../app/App'

vi.mock('@/api', () => ({
  apiClient: {
    initCsrfToken: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/shared/lib/http', async () => {
  const actual = await vi.importActual<typeof import('@/shared/lib/http')>('@/shared/lib/http')
  return { ...actual, useAuthHttpShopId: vi.fn() }
})

describe('App', () => {
  it('renders without crashing', () => {
    expect(() => render(<App />)).not.toThrow()
  })
})
