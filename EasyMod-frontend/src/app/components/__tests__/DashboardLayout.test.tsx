import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import DashboardLayout from '../DashboardLayout'

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
        'addons.navTitle': 'Add-ons',
        'nav.businessInfo': 'Business info',
        'nav.chat': 'Chat settings',
        'nav.delivery': 'Delivery settings',
        'nav.payment': 'Payment settings',
        'nav.notifications': 'Notifications',
        'nav.faqs': 'FAQs',
        'nav.settings': 'Settings',
        'nav.subscription': 'Subscription',
        'nav.shopSettings': 'Shop settings',
        'nav.collapse': 'Collapse',
        'nav.workspaceNavigation': 'Workspace navigation',
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

describe('DashboardLayout navigation', () => {
  it('keeps six direct mobile destinations and leaves Settings in the account menu', () => {
    renderLayout('/inbox')
    const navigations = screen.getAllByRole('navigation', { name: 'Workspace navigation' })
    const mobileNavigation = navigations[1]
    const links = within(mobileNavigation).getAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual([
      'Home', 'Inbox', 'Orders', 'Customers', 'Products', 'Add-ons',
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
})
