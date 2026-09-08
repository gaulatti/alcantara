import {
  AuthShell,
  Button,
  Card,
  IconBadge,
  LoadingSpinner,
} from '@gaulatti/bleecker';
import { LogIn } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useAuthStatus } from '../hooks/useAuth';

export type LoginFixtureState =
  | 'authenticated'
  | 'failure'
  | 'loading'
  | 'ready'
  | 'submitting';

const fixtureStates = new Set<LoginFixtureState>([
  'authenticated',
  'failure',
  'loading',
  'ready',
  'submitting',
]);

const loginError = 'Sign-in could not begin. Please retry or contact your administrator.';

export default function Login() {
  const [searchParams] = useSearchParams();
  const requestedFixture = searchParams.get('auth-state');
  const fixtureState =
    import.meta.env.DEV &&
    requestedFixture &&
    fixtureStates.has(requestedFixture as LoginFixtureState)
      ? (requestedFixture as LoginFixtureState)
      : undefined;
  const auth = useAuthStatus();
  const isAuthenticated = fixtureState === 'authenticated' || auth.isAuthenticated;
  const isLoaded = fixtureState ? fixtureState !== 'loading' : auth.isLoaded;
  const [isSigningIn, setIsSigningIn] = useState(fixtureState === 'submitting');
  const [errorMessage, setErrorMessage] = useState<string | null>(
    fixtureState === 'failure' ? loginError : null,
  );
  const signInPending = useRef(fixtureState === 'submitting');

  const handleGoogleSignIn = async (): Promise<void> => {
    if (signInPending.current) return;
    signInPending.current = true;
    setIsSigningIn(true);
    setErrorMessage(null);
    try {
      await signInWithRedirect({ provider: 'Google' });
    } catch {
      signInPending.current = false;
      setIsSigningIn(false);
      setErrorMessage(loginError);
    }
  };

  let content: ReactNode;
  if (!isLoaded || isAuthenticated) {
    content = (
      <>
        <div
          aria-busy='true'
          className='flex min-h-72 flex-col items-center justify-center gap-4'
          role='status'
        >
          <LoadingSpinner size='lg' />
          <p className='font-secondary text-sm text-text-secondary'>
            {isAuthenticated ? 'Opening the broadcast console…' : 'Checking your session…'}
          </p>
        </div>
        {isAuthenticated && !fixtureState ? <Navigate to='/' replace /> : null}
      </>
    );
  } else {
    content = (
      <Card className='w-full space-y-8' padding='lg' variant='elevated'>
        <div>
          <IconBadge size='lg' className='mb-6 bg-sea text-white dark:bg-accent-blue dark:text-deep-sea'>
            <LogIn className='h-7 w-7' aria-hidden='true' />
          </IconBadge>
          <p className='text-[10px] font-semibold uppercase tracking-[0.14em] text-terracotta'>
            Alcantara control room
          </p>
          <h1 className='mt-3 text-3xl font-semibold tracking-refined text-text-primary'>
            Welcome back.
          </h1>
          <p className='font-secondary mt-3 text-sm leading-6 text-text-secondary'>
            Sign in with your organization account to manage the live broadcast.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleGoogleSignIn();
          }}
        >
          <Button
            className='w-full justify-center'
            disabled={isSigningIn}
            loading={isSigningIn}
            size='lg'
            type='submit'
          >
            {!isSigningIn ? (
              <svg className='h-5 w-5' viewBox='0 0 24 24' aria-hidden='true'>
                <path
                  fill='currentColor'
                  d='M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.107-1.453-.267-2.133H12.48z'
                />
              </svg>
            ) : null}
            {isSigningIn ? 'Redirecting…' : 'Sign in with Google'}
          </Button>
        </form>
        {errorMessage ? (
          <p className='font-secondary text-sm leading-6 text-terracotta' role='alert'>
            {errorMessage}
          </p>
        ) : null}
      </Card>
    );
  }

  return (
    <AuthShell
      aside={
        <div className='max-w-lg'>
          <p className='text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-gold'>
            Broadcast operations
          </p>
          <h2 className='mt-5 text-4xl font-medium leading-[1.12] tracking-refined'>
            Every transition, deliberate. Every signal, composed.
          </h2>
          <p className='font-secondary mt-5 max-w-md text-sm leading-7 text-white/65'>
            Secure access to program, preview, media, calls, scenes, and live radio control.
          </p>
        </div>
      }
      asideLabel='Alcantara broadcast operations'
      brand={
        <div>
          <p className='text-sm font-semibold tracking-[0.09em]'>ALCANTARA</p>
          <p className='font-secondary mt-1 text-[11px] text-text-secondary'>Broadcast control</p>
        </div>
      }
      footer='Authorized production access only.'
      layout='split'
      side='start'
    >
      {content}
    </AuthShell>
  );
}
