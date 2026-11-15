import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { LoadingState } from '@/components/states';
import { GrowthUnavailablePage } from '@/pages/GrowthUnavailablePage';

export function ProtectedRoute() {
  const auth = useGrowthAuth();
  const location = useLocation();

  if (auth.status === 'loading') return <LoadingState />;
  if (auth.status === 'authenticated') return <Outlet />;
  if (auth.status === 'bootstrap-pending') return <Navigate to="/bootstrap-pending" replace />;
  if (auth.status === 'access-denied') return <Navigate to="/access-denied" replace />;
  if (auth.status === 'session-expired') return <Navigate to="/session-expired" replace />;
  if (auth.status === 'unavailable') return <GrowthUnavailablePage />;

  return <Navigate to="/login" state={{ from: location.pathname }} replace />;
}
