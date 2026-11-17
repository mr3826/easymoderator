import { Outlet, useLocation } from "react-router-dom";
import BillingStandingBanner from './BillingStandingBanner';
import {
  Home, MessageCircle, Grid3X3, ShoppingBag,
  Store, LogOut, Users,
  CreditCard, Bell, ChevronLeft, ChevronRight,
  ChevronDown, Building2, MessageSquare, Truck, BookOpen,
  FileClock, ShieldCheck,
} from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
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
import { ShellNavItem } from "./shell/ShellNavItem";
import { useDialogFocus } from "./inbox/useDialogFocus";

const dashboardPath = '/dashboard';
const COLLAPSE_KEY = 'easymod:shell-collapsed';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function DashboardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Five direct destinations. Add-ons is hidden from the merchant app (founder
  // decision 2026-11-17); its components stay in the repo with no entry point.
  const navigation = [
    { name: t('nav.home'), path: dashboardPath, icon: Home },
    { name: t('nav.messages'), path: '/inbox', icon: MessageCircle },
    { name: t('nav.orders'), path: '/orders', icon: ShoppingBag },
    { name: t('nav.customers'), path: '/customers', icon: Users },
    { name: t('nav.products'), path: '/products', icon: Grid3X3 },
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

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showShopPanel, setShowShopPanel] = useState(false);
  const accountPopupRef = useRef<HTMLDivElement>(null);
  useDialogFocus(accountPopupRef, showShopPanel);

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

  const toggleCollapsed = () => {
    setCollapsed(current => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // A blocked storage must not stop the collapse from applying locally.
      }
      return next;
    });
  };

  const sidebarW = collapsed ? 'md:w-16' : 'md:w-64';
  const mainML = collapsed ? 'md:ml-16' : 'md:ml-64';
  const shellVars = { '--shell-sidebar-w': collapsed ? '4rem' : '16rem' } as CSSProperties;

  const isActivePath = (path: string) =>
    location.pathname === path ||
    (path !== dashboardPath && location.pathname.startsWith(path)) ||
    (path === '/products' && location.pathname.startsWith('/categories'));

  return (
    <div className="em-shell min-h-screen flex" style={shellVars}>
      {/* Skip link (guardrails §18): first tab stop, visible only on focus. */}
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-em-violet-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white ${FOCUS_RING}`}
      >
        {t('common.skipToContent', { defaultValue: 'Skip to content' })}
      </a>

      {/* ─── Sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`${sidebarW} hidden md:flex bg-em-bg-surface border-r border-em-border fixed inset-y-0 left-0 flex-col transition-all duration-200 z-30`}
      >
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-em-border shrink-0">
          <div className="flex items-center overflow-hidden">
            <BrandLogo size="sm" iconOnly={collapsed} wordmarkClass="text-em-text-primary" />
          </div>
        </div>

        {/* Nav */}
        <nav aria-label={t('nav.workspaceNavigation')} className="flex-1 py-3 px-2 overflow-y-auto">
          <div className="space-y-0.5">
            {navigation.map((item) => (
              <ShellNavItem
                key={item.path}
                name={item.name}
                path={item.path}
                icon={item.icon}
                isActive={isActivePath(item.path)}
                collapsed={collapsed}
              />
            ))}
          </div>

          {/* Settings section */}
          <div className="mt-4 pt-3 border-t border-em-border">
            {!collapsed && (
              <div className="px-3 pb-1.5 text-xs font-semibold text-em-text-secondary">
                {t('nav.settings')}
              </div>
            )}
            <div className="space-y-0.5">
              {settingsNavigation.map((item) => (
                <ShellNavItem
                  key={item.path}
                  name={item.name}
                  path={item.path}
                  icon={item.icon}
                  isActive={location.pathname === item.path || location.pathname.startsWith(item.path)}
                  collapsed={collapsed}
                />
              ))}
            </div>
          </div>
        </nav>

        {/* Billing footer: Subscription */}
        <div className="border-t border-em-border px-2 pt-2 pb-1 shrink-0 space-y-1">
          <ShellNavItem
            name={subscriptionItem.name}
            path={subscriptionItem.path}
            icon={subscriptionItem.icon}
            isActive={location.pathname === subscriptionItem.path || location.pathname.startsWith(subscriptionItem.path)}
            collapsed={collapsed}
          />
        </div>

        {/* Footer: language + privacy */}
        {!collapsed && (
          <div className="px-4 pb-2 flex items-center justify-between shrink-0">
            <a
              href={buildMarketingUrl("/privacy-policy")}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs text-em-text-secondary hover:text-em-text-primary hover:underline ${FOCUS_RING}`}
            >
              {t('common.privacyPolicy')}
            </a>
            <LanguageToggle variant="workspace" />
          </div>
        )}

        {/* Collapse toggle button */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t('nav.expand', { defaultValue: 'Expand' }) : t('nav.collapse')}
          aria-expanded={!collapsed}
          className={`shrink-0 mx-2 mb-2 flex min-h-11 items-center justify-center gap-2 py-2 rounded-lg text-em-text-secondary hover:bg-em-bg-muted hover:text-em-text-primary transition-colors text-xs ${FOCUS_RING}`}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" aria-hidden="true" /> : <ChevronLeft className="w-4 h-4" aria-hidden="true" />}
          {!collapsed && <span>{t('nav.collapse')}</span>}
        </button>
      </aside>

      {/* ─── Main area ───────────────────────────────────────────────── */}
      {/* min-w-0: a flex child defaults to min-width:auto, so a wide table or
          grid inside refuses to shrink and forces the whole page to scroll
          horizontally on narrow screens. */}
      <div className={`flex-1 min-w-0 ${mainML} transition-all duration-200 flex flex-col h-screen`}>

        {/* ─── Sticky AppBar ─────────────────────────────────────────── */}
        <header className="sticky top-0 z-20 h-14 bg-em-bg-surface border-b border-em-border flex items-center px-4 gap-4 shrink-0">
          {/* Page title. Deliberately not a heading: every page renders its own
              <h1> in <main>; an <h1> here duplicated the document heading and
              made heading-based locators ambiguous (customer-intelligence
              journeys, release-readiness sweep). */}
          <p className="text-sm font-semibold text-em-text-primary flex-1 truncate">{pageTitle}</p>

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
              aria-haspopup="dialog"
              aria-expanded={showShopPanel}
              aria-controls="merchant-account-menu"
              aria-label={`${t('nav.accountMenu', { defaultValue: 'Account menu' })}: ${activeShopName || user?.full_name || user?.email || t('common.activeShop', { defaultValue: 'Active shop' })}`}
              title={activeShopName || user?.full_name || user?.email || 'Shop'}
              onClick={() => setShowShopPanel(p => !p)}
              className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg border border-em-border-strong bg-em-bg-surface text-sm text-em-text-primary hover:bg-em-bg-muted transition-colors ${FOCUS_RING}`}
            >
              <span className="font-medium truncate max-w-[140px]">{activeShopName || user?.full_name || user?.email || 'Shop'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-em-text-secondary shrink-0" aria-hidden="true" />
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
                  ref={accountPopupRef}
                  role="dialog"
                  aria-modal="false"
                  aria-label={t('nav.accountMenu', { defaultValue: 'Account menu' })}
                  className="absolute right-0 top-full mt-2 w-56 bg-em-bg-surface rounded-xl border border-em-border shadow-lg z-50 overflow-hidden"
                >
                  {/* User info header */}
                  <div className="px-4 py-3 border-b border-em-border bg-em-bg-muted">
                    <p className="text-xs font-semibold text-em-text-primary truncate">{user?.full_name || user?.email || 'Account'}</p>
                    {user?.full_name && <p className="text-xs text-em-text-secondary truncate">{user?.email}</p>}
                  </div>
                  {/* Navigation links */}
                  <div className="py-1">
                    <button type="button" onClick={() => { setShowShopPanel(false); navigate("/manage-shop"); }} className={`w-full flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted transition-colors ${FOCUS_RING}`}>
                      <Store className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                      {t('nav.shopSettings')}
                    </button><button type="button" onClick={() => { setShowShopPanel(false); navigate("/subscription"); }} className={`w-full flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted transition-colors ${FOCUS_RING}`}>
                      <CreditCard className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                      {t('nav.subscription')}
                    </button><button type="button" onClick={() => { setShowShopPanel(false); navigate("/audit-logs"); }} className={`w-full flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted transition-colors ${FOCUS_RING}`}>
                      <FileClock className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                      {t('nav.auditLogs', { defaultValue: 'Audit logs' })}
                    </button>{isAdmin && (<button type="button" onClick={() => { setShowShopPanel(false); navigate("/team/users"); }} className={`w-full flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted transition-colors ${FOCUS_RING}`}>
                        <ShieldCheck className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                        {t('nav.teamUsers', { defaultValue: 'Team users' })}
                      </button>)}
                  </div>
                  {/* Logout */}
                  <div className="border-t border-em-border py-1">
                    <button
                      type="button"
                      onClick={() => { setShowShopPanel(false); handleLogout(); }}
                      className={`w-full flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm text-em-danger-700 hover:bg-em-danger-100 transition-colors ${FOCUS_RING}`}
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
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto pb-20 md:pb-0 focus:outline-none">
          <BillingStandingBanner />
          <Outlet />
        </main>
      </div>

      <nav aria-label={t('nav.workspaceNavigation')} className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-em-bg-surface border-t border-em-border px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2">
        <ul className="grid grid-cols-5 gap-1">
          {mobileNavigation.map((item) => (
            <li key={`mobile-${item.path}`}>
              <ShellNavItem
                name={item.name}
                path={item.path}
                icon={item.icon}
                isActive={isActivePath(item.path)}
                variant="mobile"
              />
            </li>
          ))}
        </ul>
      </nav>

      {/* ─── PWA install prompt ───────────────────────────────────── */}
      <InstallPrompt />

    </div>
  );
}
