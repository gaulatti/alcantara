import { LoadingSpinner } from '@gaulatti/bleecker';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuthStatus } from '../../hooks/useAuth';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuthStatus();
  const location = useLocation();

  if (!isLoaded) {
    return (
      <div className='min-h-screen flex items-center justify-center'>
        <LoadingSpinner size='lg' />
      </div>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return <>{children}</>;
}
