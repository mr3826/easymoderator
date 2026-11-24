import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardLayout from '../DashboardLayout'
import { getStockExceptions } from '@/api/domains/product'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => {
        const labels: Record<string, string> = {
        'nav.home': 'Home',
        'nav.orders': 'Orders',
        'nav.messages': 'Inbox',
        'nav.customers': 'Customers',
        'nav.products': 'Products',
        'nav.businessInfo': 'Business info',
        'nav.chat': 'Chat settings',
        'nav.delivery': 'Delivery settings',
        'nav.payment': 'Payment settings',
        'nav.notifications': 'Notifications',
        'nav.faqs': 'FAQs',
        'nav.settings': 'Settings',
        'nav.subscription': 'Subscription',
        'nav.auditLogs': 'Audit logs',
        'nav.shopSettings': 'Shop settings',
        'nav.collapse': 'Collapse',
        'nav.workspaceNavigation': 'Workspace navigation',
        'nav.groups.workspace': 'Workspace',
        'nav.groups.businessSettings': 'Business settings',
        'nav.groups.accountOps': 'Account & ops',
        'nav.badges.products': '{{count}} products have stock exceptions',
        'nav.aiStatus.unavailable.label': 'Status unavailable',
        'nav.aiStatus.unavailable.aria': 'AI reply status could not be loaded. This is not the same as AI being off.',
        'common.privacyPolicy': 'Privacy policy',
        'dashboard.logoutTitle': 'Sign out',
        };
        return labels[key] ?? key;
      },
    }),
  }
})

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
vi.mock('../InAppNotificationCenter', () => ({ default: () => null }))
// Shell read-models (D1/D6): default posture = every source unavailable, so
// the structural pins below see the honest no-badge shell.
vi.mock('@/api/domains/order', () => ({ getOrderCounts: vi.fn(async () => { throw new Error('unavailable'); }) }))
vi.mock('@/api/domains/conversation', () => ({ getNeedsReplyCount: vi.fn(async () => { throw new Error('unavailable'); }) }))
vi.mock('@/api/domains/product', () => ({ getStockExceptions: vi.fn() }))
vi.mock('@/api/domains/meta-channels', () => ({ listMetaChannels: vi.fn(async () => { throw new Error('unavailable'); }) }))

function renderLayout(pathname = '/dashboard') {
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
  vi.mocked(getStockExceptions).mockRejectedValue(new Error('unavailable'))
})

describe('DashboardLayout navigation', () => {
  it('keeps five direct mobile destinations and leaves Settings in the account menu', () => {
    renderLayout('/inbox')
    const navigations = screen.getAllByRole('navigation', { name: 'Workspace navigation' })
    const mobileNavigation = navigations[1]
    const links = within(mobileNavigation).getAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual([
      'Home', 'Inbox', 'Orders', 'Customers', 'Products',
    ])
    expect(within(mobileNavigation).queryByRole('link', { name: /More|Settings/i })).not.toBeInTheDocument()
    expect(within(mobileNavigation).getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/customers')

    fireEvent.click(screen.getByRole('button', { name: /Shop A/i }))
    expect(screen.getByRole('button', { name: /Shop settings/i })).toBeInTheDocument()
  })

  it('keeps Categories in the Products navigation context', () => {
    renderLayout('/categories')
    const mobileNavigation = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[1]
    expect(within(mobileNavigation).getByRole('link', { name: 'Products' })).toHaveAttribute('aria-current', 'page')
  })

  it('highlights Chat on the channels overview, a channel detail, and automation (defect 4)', () => {
    for (const route of ['/manage-shop/channels', '/manage-shop/channels/c-1', '/manage-shop/automation']) {
      const { unmount } = renderLayout(route)
      const chat = screen.getByRole('link', { name: /Chat settings/i })
      expect(chat).toHaveAttribute('aria-current', 'page')
      expect(chat).toHaveAttribute('href', '/manage-shop/channels')
      unmount()
    }
  })

  it('does not highlight Chat outside the channels/automation group', () => {
    const { unmount } = renderLayout('/manage-shop/business-info')
    expect(screen.getByRole('link', { name: /Chat settings/i })).not.toHaveAttribute('aria-current')
    unmount()
  })

  it('promotes Audit logs to the Account & ops rail group (D9) and titles the page', () => {
    renderLayout('/audit-logs')
    const rail = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
    const audit = within(rail).getByRole('link', { name: 'Audit logs' })
    expect(audit).toHaveAttribute('href', '/audit-logs')
    expect(audit).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByText('Account & ops')).toBeInTheDocument()
  })

  it('routes the Products badge to its filtered destination and stays clean without one (D1)', async () => {
    const { unmount } = renderLayout('/dashboard')
    const plain = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
    expect(within(plain).getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products')
    unmount()

    vi.mocked(getStockExceptions).mockResolvedValue({
      outOfStock: 3, lowStock: 0, exceptions: 3, scanned: 10, cap: 1000,
      coverageComplete: true, generated_at: '2026-11-24T10:00:00.000Z',
    })
    renderLayout('/dashboard')
    const badgeRail = screen.getAllByRole('navigation', { name: 'Workspace navigation' })[0]
    await waitFor(() =>
      expect(within(badgeRail).getByRole('link', { name: /stock exceptions/i })).toHaveAttribute('href', '/products?stock=exceptions'),
    )
  })
})
