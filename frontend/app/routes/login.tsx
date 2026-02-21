import { Navigate } from 'react-router';
import { LogIn } from 'lucide-react';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useAuthStatus } from '../hooks/useAuth';
import LoadingSpinner from '../components/common/LoadingSpinner';

export default function Login() {
  const { isAuthenticated, isLoaded } = useAuthStatus();

  if (!isLoaded) {
    return (
      <div className='min-h-screen flex items-center justify-center'>
        <LoadingSpinner size='lg' />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to='/' replace />;
  }

  return (
    <div className='min-h-screen flex items-center justify-center bg-light-sand dark:bg-deep-sea'>
      <div className='max-w-md w-full mx-4 bg-white dark:bg-sand/10 rounded-2xl border border-sand/10 dark:border-sand/20 p-8 shadow-lg'>
        <div className='text-center mb-8'>
          <div className='inline-flex h-16 w-16 items-center justify-center rounded-full bg-sea dark:bg-accent-blue mb-4'>
            <LogIn className='h-8 w-8 text-white' />
          </div>
          <h1 className='text-3xl font-bold text-text-primary dark:text-text-primary mb-2'>Welcome Back</h1>
          <p className='text-text-secondary dark:text-text-secondary'>Sign in to access the admin panel</p>
        </div>

        <button
          onClick={() => signInWithRedirect({ provider: 'Google' }).catch((e) => console.error('Error signing in', e))}
          className='w-full px-6 py-3 bg-sea dark:bg-accent-blue text-white rounded-lg hover:opacity-90 transition-opacity font-medium flex items-center justify-center gap-3'
        >
          <svg className='w-5 h-5' viewBox='0 0 24 24'>
            <path
              fill='currentColor'
              d='M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.107-1.453-.267-2.133H12.48z'
            />
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
