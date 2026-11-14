import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { GrowthAuthProvider, useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { RequirePermission } from '@/components/RequirePermission';
import { PROSPECT_READ_PERMISSIONS, REPORT_READ_PERMISSIONS } from '@/auth/usePermission';
import { GrowthShell } from '@/layout/GrowthShell';
import { AccessDeniedPage } from '@/pages/AccessDeniedPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { CapturePage } from '@/pages/CapturePage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { FollowUpsPage } from '@/pages/FollowUpsPage';
import { GrowthUsersPage } from '@/pages/GrowthUsersPage';
import { AccessControlPage } from '@/pages/AccessControlPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { MerchantsPage } from '@/pages/MerchantsPage';
import { MerchantDetailPage } from '@/pages/MerchantDetailPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OperationsPage } from '@/pages/OperationsPage';
import { AuditTrailPage } from '@/pages/AuditTrailPage';
import { PipelinePage } from '@/pages/PipelinePage';
import { ProspectDetailPage } from '@/pages/ProspectDetailPage';
import { ProspectFormPage } from '@/pages/ProspectFormPage';
import { ProspectListPage } from '@/pages/ProspectListPage';
import { QuickAddPage } from '@/pages/QuickAddPage';
import { SearchPage } from '@/pages/SearchPage';
import { SessionExpiredPage } from '@/pages/SessionExpiredPage';
import { SourcesPage } from '@/pages/SourcesPage';
import { GrowthUnavailablePage } from '@/pages/GrowthUnavailablePage';
import { LoadingState, MessageState } from '@/components/states';

function BootstrapPendingRoute() {
  const auth = useGrowthAuth();
  const navigate = useNavigate();

  const returnToSignIn = async () => {
    await auth.logout();
    navigate('/login', { replace: true });
  };

  if (auth.status === 'loading') return <LoadingState />;
  if (auth.status !== 'bootstrap-pending') return <Navigate to="/login" replace />;

  return (
    <MessageState eyebrow="Initial operator" title="Access grant pending">
      <p>The protected Growth OS role grant must complete before workspace access is available.</p>
      <button className="primary-button" type="button" onClick={returnToSignIn}>Return to sign in</button>
    </MessageState>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <GrowthAuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route path="/access-denied" element={<AccessDeniedPage />} />
            <Route path="/session-expired" element={<SessionExpiredPage />} />
            <Route path="/unavailable" element={<GrowthUnavailablePage />} />
            <Route path="/bootstrap-pending" element={<BootstrapPendingRoute />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<GrowthShell />}>
                <Route element={<RequirePermission permission="growth_os.prospects.read_all" />}>
                  <Route index element={<HomePage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.followups.manage" />}>
                  <Route path="my-work" element={<FollowUpsPage scope="mine" />} />
                  <Route path="follow-ups" element={<FollowUpsPage scope="all" />} />
                </Route>
                <Route element={<RequirePermission permission={PROSPECT_READ_PERMISSIONS} />}>
                  <Route path="pipeline" element={<PipelinePage />} />
                </Route>
                <Route element={<RequirePermission permission={PROSPECT_READ_PERMISSIONS} />}>
                  <Route path="prospects" element={<ProspectListPage />} />
                  <Route path="prospects/:prospectId" element={<ProspectDetailPage />} />
                </Route>
                <Route element={<RequirePermission permission={REPORT_READ_PERMISSIONS} />}>
                  <Route path="sources" element={<SourcesPage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.prospects.manage_all" />}>
                  <Route path="prospects/new" element={<ProspectFormPage />} />
                  <Route path="quick-add" element={<QuickAddPage />} />
                  <Route path="capture" element={<CapturePage />} />
                </Route>
                <Route
                  element={(
                    <RequirePermission
                      permission={['growth_os.prospects.manage_all', 'growth_os.prospects.update_assigned']}
                    />
                  )}
                >
                  <Route path="prospects/:prospectId/edit" element={<ProspectFormPage />} />
                </Route>
                <Route element={<RequirePermission permission={REPORT_READ_PERMISSIONS} />}>
                  <Route path="analytics" element={<AnalyticsPage />} />
                </Route>
                <Route
                  element={(
                    <RequirePermission
                      permission={['growth_os.merchants.read_insight', 'growth_os.admin.merchants.read']}
                    />
                  )}
                >
                  <Route path="merchants" element={<MerchantsPage />} />
                  <Route path="merchants/:shopId" element={<MerchantDetailPage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.search.read" />}>
                  <Route path="search" element={<SearchPage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.admin.operations.read" />}>
                  <Route path="operations" element={<OperationsPage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.admin.audit.read" />}>
                  <Route path="audit" element={<AuditTrailPage />} />
                </Route>
                <Route element={<RequirePermission permission="growth_os.admin.users.read" />}>
                  <Route path="growth-users" element={<GrowthUsersPage />} />
                  <Route path="access-control" element={<AccessControlPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="/app" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </GrowthAuthProvider>
    </ErrorBoundary>
  );
}
