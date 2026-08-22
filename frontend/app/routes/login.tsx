import { LoadingSpinner } from '@gaulatti/bleecker';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuthStatus } from '../hooks/useAuth';
import {
  cancelLoginRedirect,
  prepareLoginRedirect,
  returnPathFromSearch,
  takeLoginReturnPath
} from '../services/login-return';

export default function Login() {
  const { isAuthenticated, isLoaded } = useAuthStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (isAuthenticated) {
      navigate(takeLoginReturnPath() ?? returnPathFromSearch(location.search), { replace: true });
      return;
    }
    if (!prepareLoginRedirect(location.search)) return;
    void signInWithRedirect({ provider: 'Google' }).catch(() => {
      cancelLoginRedirect();
      setFailed(true);
    });
  }, [isAuthenticated, isLoaded, location.search, navigate]);

  return (
    <main className='flex min-h-screen items-center justify-center bg-deep-sea p-6 text-white'>
      <div className='text-center'>
        <LoadingSpinner size='lg' />
        <p className='mt-4'>{failed ? 'Sign-in could not start. Refresh to retry.' : 'Continuing through Alcantara secure sign-in…'}</p>
      </div>
    </main>
  );
}
