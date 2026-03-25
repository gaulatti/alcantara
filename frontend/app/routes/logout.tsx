import { useEffect } from 'react';
import { Card, LoadingSpinner } from '@gaulatti/bleecker';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router';
import { logout as logoutDispatcher, setAuthLoaded } from '../state/dispatchers/auth';

export default function Logout() {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    dispatch(logoutDispatcher());
    dispatch(setAuthLoaded());
    navigate('/login', { replace: true });
  }, [dispatch, navigate]);

  return (
    <div className='flex min-h-screen items-center justify-center bg-light-sand px-4 dark:bg-deep-sea'>
      <Card className='flex w-full max-w-sm flex-col items-center gap-4 text-center'>
        <LoadingSpinner size='lg' />
        <p className='text-text-secondary dark:text-text-secondary'>Signing you out...</p>
      </Card>
    </div>
  );
}
