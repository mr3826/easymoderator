/**
 * Shell chrome contracts (guardrails §15/§18/§29): collapse persistence +
 * accessible toggle, aria-current on every nav variant, skip link, account
 * popup dialog semantics + focus return, notification center a11y. Additive
 * suite; DashboardLayout.test.tsx and InAppNotificationCenter.test.tsx stay
 * untouched.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardLayout from '../DashboardLayout'
import InAppNotificationCenter from '../InAppNotificationCenter'
import { getInAppNotifications, markInAppNotificationRead } from '@/api/domains/notification'

vi.mock('../../../features/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-a', full_name: 'Merchant A', email: 'merchant@example.test' },
    currentShop: { id: 'shop-a', shop_name: 'Shop A' },
    logout: vi.fn(),
  }),
}))
vi.mock('../BillingStandingBanner', () => ({ default: () => null }))
vi.mock('../InstallPrompt', () => ({ default: () => null }))
vi.mock('../BrandLogo', () => ({ default: () => <span>EasyModerator</span> }))
vi.mock('../LanguageToggle', () => ({ default: () => null }))
vi.mock('@/api/domains/notification', () => ({
  getInAppNotifications: vi.fn(async () => []),
  markInAppNotificationRead: vi.fn(async () => undefined),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

function renderLayout(pathname = '/inbox') {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="*" element={<div>Workspace page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('shell chrome', () => {
  it('keeps the five mobile destinations and both workspace navs in order', () => {
    renderLayout('/inbox')
    const navs = screen.getAllByRole('navigation', { name: 'Workspace navigation' })
    expect(navs).toHaveLength(2)
    const mobile = navs[1]
    expect(within(mobile).getAllByRole('link').map(l => l.textContent)).toEqual([
      'Home', 'Inbox', 'Orders', 'Customers', 'Products',
    ])
  })

  it('marks the active rail, settings and billing links with aria-current', () => {
    const { unmount } = renderLayout('/manage-shop/payment-settings')
    const rail = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
    expect(within(rail).getByRole('link', { name: 'Payment' })).toHaveAttribute('aria-current', 'page')
    unmount()
    renderLayout('/subscription')
    // Billing lives in the sidebar footer, outside the nav landmark.
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('aria-current', 'page')
  })

  it('persists collapse and names the toggle in both states', () => {
    const { unmount } = renderLayout()
    const toggle = screen.getByRole('button', { name: 'Collapse' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(localStorage.getItem('easymod:shell-collapsed')).toBe('1')
    expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false')
    // The sidebar width var is the AddProduct footer coupling contract.
    const root = document.querySelector('.em-shell') as HTMLElement
    expect(root.style.getPropertyValue('--shell-sidebar-w')).toBe('4rem')
    // Collapsed rail links carry accessible names instead of visible labels.
    const rail = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
    expect(within(rail).getByRole('link', { name: 'Inbox' })).toBeInTheDocument()
    unmount()
    renderLayout()
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument()
  })

  it('offers a skip link that targets the main landmark', () => {
    renderLayout()
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main-content')
    expect(document.getElementById('main-content')?.tagName).toBe('MAIN')
  })

  it('account popup is a dialog, closes on Escape and returns focus', () => {
    renderLayout()
    const trigger = screen.getByRole('button', { name: /Shop A/i })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Account menu' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Shop Settings/i })).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Account menu' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('notification center chrome', () => {
  it('bell exposes dialog semantics and Escape closes with focus return', async () => {
    vi.mocked(getInAppNotifications).mockResolvedValue([])
    render(<InAppNotificationCenter />)
    const bell = screen.getByRole('button', { name: 'Notifications' })
    expect(bell).toHaveAttribute('aria-expanded', 'false')
    bell.focus()
    fireEvent.click(bell)
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(bell).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('No notifications')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(bell)
    expect(markInAppNotificationRead).not.toHaveBeenCalled()
  })

  it('payment confirmations deep-link via SPA navigation and close the panel', async () => {
    vi.mocked(getInAppNotifications).mockResolvedValue([
      {
        id: 'n-pay', shop_id: 'shop-1', type: 'payment_confirmation',
        customer_message: 'Confirm payment', customer_data: { title: 'Payment', orderId: 'order-9' },
        status: 'pending', created_at: '2026-07-23T10:00:00.000Z',
      } as never,
    ])
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<InAppNotificationCenter />} />
          <Route path="/orders" element={<div>Orders page</div>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    const review = await screen.findByRole('link', { name: 'Review' })
    expect(review).toHaveAttribute('href', '/orders?orderId=order-9')
    expect(screen.queryByRole('button', { name: 'Mark notification read' })).not.toBeInTheDocument()
    fireEvent.click(review)
    expect(await screen.findByText('Orders page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
  })

  it('ordinary pending notifications mark read through the API', async () => {
    vi.mocked(getInAppNotifications).mockResolvedValue([
      {
        id: 'n-1', shop_id: 'shop-1', type: 'escalation',
        customer_message: 'Customer needs help', customer_data: { title: 'Escalation' },
        status: 'pending', created_at: '2026-07-23T10:00:00.000Z',
      } as never,
    ])
    render(<InAppNotificationCenter />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark notification read' }))
    expect(markInAppNotificationRead).toHaveBeenCalledWith('n-1')
  })
})
