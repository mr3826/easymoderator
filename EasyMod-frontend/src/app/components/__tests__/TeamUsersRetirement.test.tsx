/**
 * D-A3-7 (cross-screen CTA truth) — Team users retirement, mirroring the
 * exact Add-ons precedent (PR #269, commit 73de365f):
 *  1. The merchant shell nav no longer advertises the feature to admins —
 *     /api/users has no backend mount, so every request 404s.
 *  2. The /team/users route is "hidden, not deleted": a redirect loader to
 *     /dashboard, like /addons, /addons/* and /more.
 *  3. The UsersPage components + their tests stay in the repo (reversible,
 *     A0 decision pending founder review) — asserted here so a future
 *     "clean the dead code" PR has to revisit this contract deliberately.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DashboardLayout from "../DashboardLayout";
import { router } from "../../routes";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
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
          'nav.shopSettings': 'Shop settings',
          'nav.subscription': 'Subscription',
          'nav.workspaceNavigation': 'Workspace navigation',
          'nav.teamUsers': 'Team users',
        };
        return labels[key] ?? key;
      },
    }),
  };
});

vi.mock('../../../features/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-admin', full_name: 'Admin A', email: 'admin@example.test' },
    currentShop: { id: 'shop-a', shop_name: 'Shop A' },
    logout: vi.fn(),
  }),
}));

// Admin so the pre-fix code path that rendered the Team entry is exercised.
vi.mock('@/shared/lib/rbac/useUserPermissions', () => ({
  useUserPermissions: () => ({ hasRole: () => true, canManageTeam: true }),
}));

vi.mock('../BillingStandingBanner', () => ({ default: () => null }));
vi.mock('../InstallPrompt', () => ({ default: () => null }));
vi.mock('../BrandLogo', () => ({ default: () => <span>EasyModerator</span> }));
vi.mock('../LanguageToggle', () => ({ default: () => null }));
vi.mock('../InAppNotificationCenter', () => ({ default: () => null }));
// Phase 1 W2: the shell now mounts the nav-badge sources and the AI status
// chip. Default posture — every read unavailable (no badges, degraded chip),
// which keeps the retirement assertions structural rather than data-driven.
// PARTIAL mocks (spread actual): this file imports the route tree, which
// evaluates the api barrel against every export of these domain modules.
vi.mock("@/api/domains/order", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrderCounts: vi.fn(async () => { throw new Error("unavailable"); }),
}));
vi.mock("@/api/domains/conversation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNeedsReplyCount: vi.fn(async () => { throw new Error("unavailable"); }),
}));
vi.mock("@/api/domains/product", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStockExceptions: vi.fn(async () => { throw new Error("unavailable"); }),
}));
vi.mock("@/api/domains/meta-channels", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listMetaChannels: vi.fn(async () => { throw new Error("unavailable"); }),
}));

function findRoute(routes: readonly any[] | undefined, path: string): any {
  for (const route of routes ?? []) {
    if (route.path === path) return route;
    const nested = findRoute(route.children, path);
    if (nested) return nested;
  }
  return null;
}

describe('Team users retirement (D-A3-7, mirrors the Add-ons precedent)', () => {
  it('does not advertise Team users in the account menu, even for admins', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="*" element={<div>Workspace page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Shop A/i }));
    // The menu is open (real entries present)…
    expect(screen.getByRole('button', { name: /Shop settings/i })).toBeInTheDocument();
    // …but the dead feature is no longer advertised.
    expect(screen.queryByRole('button', { name: /Team users/i })).not.toBeInTheDocument();
    expect(screen.queryByText('nav.teamUsers')).not.toBeInTheDocument();
  });

  it('redirects the retired /team/users path to /dashboard, hidden not deleted', async () => {
    const node = findRoute(router.routes, '/team/users');
    expect(node).not.toBeNull();
    expect(node.Component).toBeUndefined();
    expect(typeof node.loader).toBe('function');

    const result = await node.loader({
      request: new Request('http://localhost/team/users'),
      params: {},
    });
    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get('Location')).toBe('/dashboard');
  });

  it('keeps the UsersPage implementation in the repo for reversible re-exposure', () => {
    // Add-ons precedent: components/tests stay so the feature can return
    // without a rewrite. A disappearance here must be a deliberate decision.
    const usersPagePath = path.resolve(
      __dirname,
      '../../features/users/components/UsersPage.tsx',
    );
    expect(fs.existsSync(usersPagePath)).toBe(true);
  });
});
