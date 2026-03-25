import { LoadingSpinner } from '@gaulatti/bleecker';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuthStatus } from '../../hooks/useAuth';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuthStatus();

  if (!isLoaded) {
    return (
      <div className='min-h-screen flex items-center justify-center'>
        <LoadingSpinner size='lg' />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to='/login' replace />;
  }

  return <>{children}</>;
}
