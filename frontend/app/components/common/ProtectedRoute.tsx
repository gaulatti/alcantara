import { AppLoading } from '../AppLoading';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuthStatus } from '../../hooks/useAuth';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuthStatus();

  if (!isLoaded) {
    return <AppLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to='/login' replace />;
  }

  return <>{children}</>;
}
