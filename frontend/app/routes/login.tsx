import { Button, Card, IconBadge, LoadingSpinner } from '@gaulatti/bleecker';
import { LogIn } from 'lucide-react';
import { useState } from 'react';
import { Navigate } from 'react-router';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useAuthStatus } from '../hooks/useAuth';

export default function Login() {
  const [isSigningIn, setIsSigningIn] = useState(false);
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

  const handleGoogleSignIn = async () => {
    if (isSigningIn) {
      return;
    }

    setIsSigningIn(true);
    try {
      await signInWithRedirect({ provider: 'Google' });
    } catch (e) {
      console.error('Error signing in', e);
      setIsSigningIn(false);
    }
  };

  return (
    <div className='flex min-h-screen items-center justify-center bg-light-sand px-4 dark:bg-deep-sea'>
      <Card className='w-full max-w-md space-y-8 p-8'>
        <div className='text-center'>
          <IconBadge size='lg' className='mx-auto mb-4 rounded-full bg-sea text-white dark:bg-accent-blue dark:text-white'>
            <LogIn className='h-8 w-8' />
          </IconBadge>
          <h1 className='mb-2 text-3xl font-bold text-text-primary dark:text-text-primary'>Welcome Back</h1>
          <p className='text-text-secondary dark:text-text-secondary'>Sign in to access the admin panel</p>
        </div>

        <Button onClick={handleGoogleSignIn} size='lg' className='w-full justify-center' disabled={isSigningIn}>
          {isSigningIn ? (
            <>
              <LoadingSpinner size='sm' />
              Redirecting...
            </>
          ) : (
            <>
              <svg className='h-5 w-5' viewBox='0 0 24 24' aria-hidden='true'>
                <path
                  fill='currentColor'
                  d='M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.107-1.453-.267-2.133H12.48z'
                />
              </svg>
              Sign in with Google
            </>
          )}
        </Button>
      </Card>
    </div>
  );
}
