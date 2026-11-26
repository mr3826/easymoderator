/**
 * Shell chrome contracts (guardrails §15/§18/§29): collapse persistence +
 * accessible toggle, aria-current on every nav variant, skip link, account
 * popup dialog semantics + focus return, notification center a11y.
 * Phase 1 W2 additions (A3): the three-group rail IA (D9), the 236px/
 * 14.75rem geometry pin, honest nav badges incl. destinations, cap 99+ and
 * lower-bound rendering (D1), and the degraded AI status chip (D6).
 * Real i18n is used so nav.groups/nav.badges/nav.aiStatus keys + {{count}}
 * interpolation are proven against the published locale leaves.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardLayout from '../DashboardLayout'
import InAppNotificationCenter from '../InAppNotificationCenter'
import { getInAppNotifications, markInAppNotificationRead } from '@/api/domains/notification'
import { getOrderCounts } from '@/api/domains/order'
import { getNeedsReplyCount } from '@/api/domains/conversation'
import { getStockExceptions } from '@/api/domains/product'
import { listMetaChannels } from '@/api/domains/meta-channels'

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
vi.mock('@/api/domains/notification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/notification')>()),
  getInAppNotifications: vi.fn(async () => []),
  markInAppNotificationRead: vi.fn(async () => undefined),
}))
// Shell read-models (D1 badges / D6 chip) are mocked here; C1/C2 ship with
// A5 this wave, so the mocks ARE the contract (doc 05).
vi.mock('@/api/domains/order', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/order')>()),
   getOrderCounts: vi.fn()
}))
vi.mock('@/api/domains/conversation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/conversation')>()),
   getNeedsReplyCount: vi.fn()
}))
vi.mock('@/api/domains/product', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/product')>()),
  getStockExceptions: vi.fn(),
}))
vi.mock('@/api/domains/meta-channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/meta-channels')>()),
   listMetaChannels: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

function rail(): HTMLElement {
  return screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
}
function mobileBar(): HTMLElement {
  return screen.getAllByRole('navigation', { name: 'Workspace navigation' })[1]
}

function mockSources(values: {
  orders?: number
  inbox?: { count: number; coverageComplete?: boolean }
  products?: { exceptions: number; coverageComplete?: boolean }
  channels?: unknown[] | 'fail'
}) {
  if (values.orders === undefined) {
    vi.mocked(getOrderCounts).mockRejectedValue(new Error('unavailable'))
  } else {
    vi.mocked(getOrderCounts).mockResolvedValue({
      total: 0, to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0,
      needs_action: values.orders, returned: 0, delivered: 0,
    })
  }
  if (values.inbox === undefined) {
    vi.mocked(getNeedsReplyCount).mockRejectedValue(new Error('unavailable'))
  } else {
    vi.mocked(getNeedsReplyCount).mockResolvedValue({
      count: values.inbox.count, scanned: values.inbox.count, cap: 200,
      coverageComplete: values.inbox.coverageComplete ?? true,
      generated_at: '2026-11-24T10:00:00.000Z',
    })
  }
  if (values.products === undefined) {
    vi.mocked(getStockExceptions).mockRejectedValue(new Error('unavailable'))
  } else {
    vi.mocked(getStockExceptions).mockResolvedValue({
      outOfStock: values.products.exceptions, lowStock: 0,
      exceptions: values.products.exceptions, scanned: 10, cap: 1000,
      coverageComplete: values.products.coverageComplete ?? true,
      generated_at: '2026-11-24T10:00:00.000Z',
    })
  }
  if (values.channels === 'fail' || values.channels === undefined) {
    vi.mocked(listMetaChannels).mockRejectedValue(new Error('unavailable'))
  } else {
    vi.mocked(listMetaChannels).mockResolvedValue(values.channels as never)
  }
}

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
  // Default posture: every shell source is unavailable → no badges, and the
  // AI chip renders its honest degraded state.
  mockSources({})
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

  it('groups the rail into Workspace / Business settings / Account & ops with Audit logs promoted (D9)', () => {
    renderLayout('/audit-logs')
    const sidebar = rail()
    expect(within(sidebar).getByText('Workspace')).toBeInTheDocument()
    expect(within(sidebar).getByText('Business settings')).toBeInTheDocument()
    expect(within(sidebar).getByText('Account & ops')).toBeInTheDocument()
    const audit = within(sidebar).getByRole('link', { name: 'Audit Logs' })
    expect(audit).toHaveAttribute('href', '/audit-logs')
    expect(audit).toHaveAttribute('aria-current', 'page')
    // Billing lives inside the Account & ops group now (still one link).
    expect(within(sidebar).getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/subscription')
  })

  it('marks the active rail, settings and billing links with aria-current', () => {
    const { unmount } = renderLayout('/manage-shop/payment-settings')
    expect(within(rail()).getByRole('link', { name: 'Payment' })).toHaveAttribute('aria-current', 'page')
    unmount()
    renderLayout('/subscription')
    // Billing moved into the rail's Account & ops group (D9).
    expect(within(rail()).getByRole('link', { name: 'Billing' })).toHaveAttribute('aria-current', 'page')
  })

  it('persists collapse, hides group labels while collapsed, and pins the sidebar width var (D9 geometry)', () => {
    const { unmount } = renderLayout()
    const root = document.querySelector('.em-shell') as HTMLElement
    // Expanded geometry is 236px expressed as the pinned rem value consumed
    // by AddProduct's fixed footer.
    expect(root.style.getPropertyValue('--shell-sidebar-w')).toBe('14.75rem')
    const toggle = screen.getByRole('button', { name: 'Collapse' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(localStorage.getItem('easymod:shell-collapsed')).toBe('1')
    expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false')
    expect(root.style.getPropertyValue('--shell-sidebar-w')).toBe('4rem')
    // Group headers disappear while collapsed; icons + tooltips + aria stay.
    const sidebar = rail()
    expect(within(sidebar).queryByText('Business settings')).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: 'Inbox' })).toBeInTheDocument()
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

  it('renders the AI status chip honestly degraded when channels cannot be read (D6)', async () => {
    renderLayout()
    const chip = await screen.findByRole('link', {
      name: 'AI reply status could not be loaded. This is not the same as AI being off.',
    })
    expect(chip).toHaveAttribute('href', '/manage-shop/channels')
    expect(chip).toHaveAttribute('data-state', 'unavailable')
    expect(chip).toHaveTextContent('Status unavailable')
    // D6: no toggle control exists anywhere in the shell.
    expect(chip.querySelectorAll('button, [role="switch"]')).toHaveLength(0)
  })
})

describe('nav badges (D1)', () => {
  it('carries each badge destination on the link itself, in rail and mobile', async () => {
    mockSources({ orders: 4, inbox: { count: 3 }, products: { exceptions: 2 } })
    renderLayout('/dashboard')
    const orders = await within(rail()).findByRole('link', { name: /orders need action/i })
    expect(orders).toHaveAttribute('href', '/orders?bucket=needs_action')
    expect(orders).toHaveTextContent('4')
    expect(within(rail()).getByRole('link', { name: /messages need a reply/i })).toHaveAttribute('href', '/inbox?tab=needs_review')
    expect(within(rail()).getByRole('link', { name: /products have stock exceptions/i })).toHaveAttribute('href', '/products?stock=exceptions')

    const mobileOrders = within(mobileBar()).getByRole('link', { name: /orders need action/i })
    expect(mobileOrders).toHaveAttribute('href', '/orders?bucket=needs_action')
    expect(mobileOrders).toHaveClass('min-h-12') // mobile geometry pin preserved
  })

  it('caps display at 99+ and renders incomplete coverage as a lower bound, never a false exact', async () => {
    mockSources({ orders: 150, inbox: { count: 12, coverageComplete: false } })
    renderLayout('/dashboard')
    const orders = await within(rail()).findByRole('link', { name: /99\+ orders need action/ })
    expect(orders).toHaveTextContent('99+')
    const inbox = within(rail()).getByRole('link', { name: /12\+ messages need a reply/ })
    expect(inbox).toHaveTextContent('12+')
  })

  it('hides badges entirely when a source fails — and never renders a zero pill', async () => {
    // default beforeEach posture: every source rejects; a resolved zero too.
    mockSources({ orders: 0, inbox: { count: 0 }, products: { exceptions: 0 } })
    renderLayout('/inbox')
    const inbox = within(rail()).getByRole('link', { name: 'Inbox' })
    await waitFor(() => expect(inbox).toHaveAttribute('href', '/inbox'))
    expect(within(rail()).getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders')
    expect(within(rail()).queryByText('0')).not.toBeInTheDocument()
    expect(within(mobileBar()).getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders')
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
