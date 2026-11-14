import { Link, Outlet, useLocation } from "react-router-dom";
import BillingStandingBanner from './BillingStandingBanner';
import {
  Home, MessageCircle, Grid3X3, ShoppingBag,
  Store, LogOut, Users,
  CreditCard, Bell, ChevronLeft, ChevronRight,
  ChevronDown, Building2, MessageSquare, Truck, BookOpen,
  FileClock, ShieldCheck, Puzzle,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import InstallPrompt from "./InstallPrompt";
import BrandLogo from "./BrandLogo";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../features/auth/AuthProvider";
import { UserRole } from "@/shared/lib/rbac/types";
import { useUserPermissions } from "@/shared/lib/rbac/useUserPermissions";
import LanguageToggle from "./LanguageToggle";
import InAppNotificationCenter from "./InAppNotificationCenter";
import { buildMarketingUrl } from "@/app/lib/config";

const dashboardPath = '/dashboard';

export default function DashboardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const navigation = [
    { name: t('nav.home'), path: dashboardPath, icon: Home },
    { name: t('nav.messages'), path: '/inbox', icon: MessageCircle },
    { name: t('nav.orders'), path: '/orders', icon: ShoppingBag },
    { name: t('nav.customers'), path: '/customers', icon: Users },
    { name: t('nav.products'), path: '/products', icon: Grid3X3 },
    { name: t('addons.navTitle', { defaultValue: 'Add-ons' }), path: '/addons', icon: Puzzle },
  ];

  const settingsNavigation = [
    { name: t('nav.businessInfo'), path: '/manage-shop/business-info', icon: Building2 },
    { name: t('nav.chat'), path: '/manage-shop/chat-settings', icon: MessageSquare },
    { name: t('nav.delivery'), path: '/manage-shop/delivery-settings', icon: Truck },
    { name: t('nav.payment'), path: '/manage-shop/payment-settings', icon: CreditCard },
    { name: t('nav.notifications'), path: '/manage-shop/notifications', icon: Bell },
    { name: t('nav.faqs'), path: '/manage-shop/faqs', icon: BookOpen },
  ];

  const mobileNavigation = navigation;

  const { user, currentShop, logout } = useAuth();
  const { hasRole } = useUserPermissions();
  const isAdmin = hasRole(UserRole.ADMIN);

  const [collapsed, setCollapsed] = useState(false);
  const [showShopPanel, setShowShopPanel] = useState(false);

  const activeShopName = currentShop?.shop_name || currentShop?.unique_code || currentShop?.id;

  const subscriptionItem = { name: t('nav.subscription'), path: '/subscription', icon: CreditCard };

  // Derive page title from current route (check settings group first — more specific paths)
  const allNavItems = [...settingsNavigation, ...navigation, subscriptionItem];
  const activeNav = allNavItems.find(item =>
    item.path === location.pathname ||
    (item.path !== dashboardPath && location.pathname.startsWith(item.path)) ||
    (item.path === '/products' && location.pathname.startsWith('/categories'))
  );
  const pageTitle = activeNav?.name
    ?? (location.pathname.startsWith('/manage-shop') ? t('nav.settings') : 'EasyModerator');

  const handleLogout = async () => {
    await logout();
    setShowShopPanel(false);
    navigate('/signin');
  };

  const sidebarW = collapsed ? 'md:w-16' : 'md:w-64';
  const mainML = collapsed ? 'md:ml-16' : 'md:ml-64';

  return (
    <div className="min-h-screen bg-gray-50 flex font-bn">

      {/* ─── Sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`${sidebarW} hidden md:flex bg-white border-r border-gray-200 fixed inset-y-0 left-0 flex-col transition-all duration-200 z-30`}
      >
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center overflow-hidden">
            <BrandLogo size="sm" iconOnly={collapsed} />
          </div>
        </div>

        {/* Nav */}
        <nav aria-label={t('nav.workspaceNavigation')} className="flex-1 py-3 px-2 overflow-y-auto">
          <div className="space-y-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              const isActive =
                location.pathname === item.path ||
                (item.path !== dashboardPath && location.pathname.startsWith(item.path)) ||
                (item.path === '/products' && location.pathname.startsWith('/categories'));

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={collapsed ? item.name : undefined}
                  title={collapsed ? item.name : undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group relative ${
                    isActive
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {!collapsed && <span className="text-sm font-medium">{item.name}</span>}
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-blue-600 rounded-r-full" />
                  )}
                </Link>
              );
            })}
          </div>

          {/* Settings section */}
          <div className="mt-4 pt-3 border-t border-gray-100">
            {!collapsed && (
              <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {t('nav.settings')}
              </div>
            )}
            <div className="space-y-0.5">
              {settingsNavigation.map((item) => {
                const Icon = item.icon;
                const isActive =
                  location.pathname === item.path ||
                  location.pathname.startsWith(item.path);

                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-label={collapsed ? item.name : undefined}
                    title={collapsed ? item.name : undefined}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group relative ${
                      isActive
                        ? 'bg-blue-50 text-blue-600'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    {!collapsed && <span className="text-sm font-medium">{item.name}</span>}
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-blue-600 rounded-r-full" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Billing footer: Subscription */}
        <div className="border-t border-gray-100 px-2 pt-2 pb-1 shrink-0 space-y-1">
          {[subscriptionItem].map((item) => {
            const isActive =
              location.pathname === item.path ||
              location.pathname.startsWith(item.path);
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                aria-label={collapsed ? item.name : undefined}
                title={collapsed ? item.name : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group relative ${
                  isActive
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {!collapsed && <span className="text-sm font-medium">{item.name}</span>}
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-blue-600 rounded-r-full" />
                )}
              </Link>
            );
          })}
        </div>

        {/* Footer: language + privacy */}
        {!collapsed && (
          <div className="px-4 pb-2 flex items-center justify-between shrink-0">
            <a
              href={buildMarketingUrl("/privacy-policy")}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-600 hover:underline"
            >
              {t('common.privacyPolicy')}
            </a>
            <LanguageToggle variant="dark" />
          </div>
        )}

        {/* Collapse toggle button */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="shrink-0 mx-2 mb-2 flex items-center justify-center gap-2 py-2 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700 transition-colors text-xs"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          {!collapsed && <span>{t('nav.collapse')}</span>}
        </button>
      </aside>

      {/* ─── Main area ───────────────────────────────────────────────── */}
      {/* min-w-0: a flex child defaults to min-width:auto, so a wide table or
          grid inside refuses to shrink and forces the whole page to scroll
          horizontally on narrow screens. */}
      <div className={`flex-1 min-w-0 ${mainML} transition-all duration-200 flex flex-col h-screen`}>

        {/* ─── Sticky AppBar ─────────────────────────────────────────── */}
        <header className="sticky top-0 z-20 h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-4 shrink-0">
          {/* Page title. Deliberately not a heading: every page renders its own
              <h1> in <main>; an <h1> here duplicated the document heading and
              made heading-based locators ambiguous (customer-intelligence
              journeys, release-readiness sweep). */}
          <p className="text-sm font-semibold text-gray-800 flex-1 truncate">{pageTitle}</p>

          {/* Notifications */}
          <InAppNotificationCenter />

          {/* Account menu */}
          <div
            className="relative"
            onKeyDown={(event) => {
              if (event.key === "Escape") setShowShopPanel(false);
            }}
          >
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={showShopPanel}
              aria-controls="merchant-account-menu"
              aria-label={`${t('nav.accountMenu', { defaultValue: 'Account menu' })}: ${activeShopName || user?.full_name || user?.email || t('common.activeShop', { defaultValue: 'Active shop' })}`}
              title={activeShopName || user?.full_name || user?.email || 'Shop'}
              onClick={() => setShowShopPanel(p => !p)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <span className="font-medium truncate max-w-[140px]">{activeShopName || user?.full_name || user?.email || 'Shop'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden="true" />
            </button>

            {showShopPanel && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  aria-label={t('common.close', { defaultValue: 'Close' })}
                  onClick={() => setShowShopPanel(false)}
                />
                <div
                  id="merchant-account-menu"

                  aria-label={t('nav.accountMenu', { defaultValue: 'Account menu' })}
                  className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden"
                >
                  {/* User info header */}
                  <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                    <p className="text-xs font-semibold text-gray-900 truncate">{user?.full_name || user?.email || 'Account'}</p>
                    {user?.full_name && <p className="text-xs text-gray-500 truncate">{user?.email}</p>}
                  </div>
                  {/* Navigation links */}
                  <div className="py-1">
                    <button type="button" onClick={() => { setShowShopPanel(false); navigate("/manage-shop"); }} className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                      <Store className="w-4 h-4 text-gray-400" aria-hidden="true" />
                      {t('nav.shopSettings')}
                    </button><button type="button" onClick={() => { setShowShopPanel(false); navigate("/subscription"); }} className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                      <CreditCard className="w-4 h-4 text-gray-400" aria-hidden="true" />
                      {t('nav.subscription')}
                    </button><button type="button" onClick={() => { setShowShopPanel(false); navigate("/audit-logs"); }} className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                      <FileClock className="w-4 h-4 text-gray-400" aria-hidden="true" />
                      {t('nav.auditLogs', { defaultValue: 'Audit logs' })}
                    </button>{isAdmin && (<button type="button" onClick={() => { setShowShopPanel(false); navigate("/team/users"); }} className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                        <ShieldCheck className="w-4 h-4 text-gray-400" aria-hidden="true" />
                        {t('nav.teamUsers', { defaultValue: 'Team users' })}
                      </button>)}
                  </div>
                  {/* Logout */}
                  <div className="border-t border-gray-100 py-1">
                    <button
                      type="button"
                      onClick={() => { setShowShopPanel(false); handleLogout(); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" aria-hidden="true" />
                      {t('dashboard.logoutTitle')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </header>

        {/* ─── Page content ──────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <BillingStandingBanner />
          <Outlet />
        </main>
      </div>

      <nav aria-label={t('nav.workspaceNavigation')} className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2">
        <ul className="grid grid-cols-6 gap-1">
          {mobileNavigation.map((item) => {
            const Icon = item.icon;
            const isActive =
                location.pathname === item.path ||
                (item.path !== dashboardPath && location.pathname.startsWith(item.path)) ||
                (item.path === '/products' && location.pathname.startsWith('/categories'));

            return (
              <li key={`mobile-${item.path}`}>
                <Link
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                  className={`flex min-h-12 flex-col items-center justify-center rounded-lg px-1 text-[11px] font-semibold transition-colors ${
                    isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600'
                  }`}
                >
                  <Icon className="mb-1 h-4 w-4" />
                  <span className="leading-none">{item.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ─── PWA install prompt ───────────────────────────────────── */}
      <InstallPrompt />

    </div>
  );
}
