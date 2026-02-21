import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router';
import LoadingSpinner from '../components/common/LoadingSpinner';
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
    <div className='min-h-screen flex items-center justify-center'>
      <div className='flex flex-col items-center text-center gap-4'>
        <LoadingSpinner size='lg' />
        <p>Signing you out...</p>
      </div>
    </div>
  );
}
