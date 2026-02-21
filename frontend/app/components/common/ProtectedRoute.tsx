import { Navigate } from 'react-router';
import { useAuthStatus } from '../../hooks/useAuth';
import LoadingSpinner from './LoadingSpinner';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
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
