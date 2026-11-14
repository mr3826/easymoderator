import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { Outlet } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const authState = vi.hoisted(() => ({
  status: 'authenticated' as string,
  permissions: [] as string[],
}));

vi.mock('@/auth/GrowthAuthProvider', () => ({
  GrowthAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useGrowthAuth: () => ({
    status: authState.status,
    session: {
      internalUserId: 'growth-user',
      displayName: 'Growth User',
      role: 'GROWTH_USER',
      legacyRole: null,
      permissions: authState.permissions,
    },
    error: null,
    twoFactorRequired: false,
    refreshSession: vi.fn(),
    signin: vi.fn(),
    verifyTwoFactor: vi.fn(),
    logout: vi.fn(),
    reportApiError: vi.fn(() => false),
  }),
}));

vi.mock('@/layout/GrowthShell', () => ({
  GrowthShell: () => <div><span>Growth shell</span><Outlet /></div>,
}));

vi.mock('@/pages/ProspectListPage', () => ({
  ProspectListPage: () => <div>Prospect list route</div>,
}));

vi.mock('@/pages/ProspectDetailPage', () => ({
  ProspectDetailPage: () => <div>Prospect detail route</div>,
}));

vi.mock('@/pages/ProspectFormPage', () => ({
  ProspectFormPage: () => <div>Prospect form route</div>,
}));
vi.mock('@/pages/AnalyticsPage', () => ({
  AnalyticsPage: () => <div>Analytics route</div>,
}));
vi.mock('@/pages/SourcesPage', () => ({
  SourcesPage: () => <div>Sources route</div>,
}));

vi.mock('@/pages/AccessDeniedPage', () => ({
  AccessDeniedPage: () => <div>Access denied route</div>,
}));

vi.mock('@/pages/LoginPage', () => ({ LoginPage: () => <div>Login route</div> }));
vi.mock('@/pages/UnauthorizedPage', () => ({ UnauthorizedPage: () => <div>Unauthorized route</div> }));
vi.mock('@/pages/SessionExpiredPage', () => ({ SessionExpiredPage: () => <div>Session expired route</div> }));
vi.mock('@/pages/GrowthUnavailablePage', () => ({ GrowthUnavailablePage: () => <div>Unavailable route</div> }));
vi.mock('@/pages/NotFoundPage', () => ({ NotFoundPage: () => <div>Not found route</div> }));

function renderAt(path: string) {
  window.history.replaceState({}, '', path);
  return render(<App />);
}

describe('Growth prospect route permissions', () => {
  afterEach(() => {
    authState.status = 'authenticated';
    authState.permissions = [];
  });

  it('shows the protected pending-grant boundary without an MFA step', () => {
    authState.status = 'bootstrap-pending';

    renderAt('/bootstrap-pending');

    expect(screen.getByText('Access grant pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to sign in' })).toBeInTheDocument();
  });

  it('no longer serves an MFA enrollment route', () => {
    authState.status = 'authenticated';

    renderAt('/enroll-mfa');

    expect(screen.getByText('Not found route')).toBeInTheDocument();
  });

  it('allows a read permission to reach the prospect list route', () => {
    authState.permissions = ['growth_os.prospects.read_source_scope'];

    renderAt('/prospects');

    expect(screen.getByText('Prospect list route')).toBeInTheDocument();
  });

  it('denies prospect routes without the server-mirrored read permission', () => {
    renderAt('/prospects');

    expect(screen.getByText('Access denied route')).toBeInTheDocument();
  });

  it('keeps prospect creation behind manage_all', () => {
    authState.permissions = ['growth_os.prospects.read_all'];

    renderAt('/prospects/new');

    expect(screen.getByText('Access denied route')).toBeInTheDocument();
  });

  it('guards the homepage with the backend home permission', () => {
    authState.permissions = ['growth_os.prospects.read_source_scope'];

    renderAt('/');

    expect(screen.getByText('Access denied route')).toBeInTheDocument();
  });

  it('allows source-scoped reporting only with the report permission', () => {
    authState.permissions = ['growth_os.reports.read_source_scope'];

    renderAt('/sources');

    expect(screen.getByText('Sources route')).toBeInTheDocument();
  });

  it('guards follow-up routes with the follow-up permission', () => {
    authState.permissions = ['growth_os.prospects.read_all'];

    renderAt('/my-work');

    expect(screen.getByText('Access denied route')).toBeInTheDocument();
  });

  it('uses the dedicated audit permission for the audit route', () => {
    authState.permissions = ['growth_os.admin.operations.read'];

    renderAt('/audit');

    expect(screen.getByText('Access denied route')).toBeInTheDocument();
  });
});
