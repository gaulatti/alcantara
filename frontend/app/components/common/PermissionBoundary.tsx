import { Button, LoadingSpinner } from '@gaulatti/bleecker';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { routePermission } from '../../auth/permissions';
import { useFeatures } from '../../hooks/useFeatures';

export default function PermissionBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { status, hasPermission, reload } = useFeatures();
  const required = routePermission(location.pathname);

  if (status === 'loading') {
    return <div className='flex min-h-[50vh] items-center justify-center'><LoadingSpinner size='lg' /></div>;
  }
  if (status === 'unauthenticated') {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    return null;
  }
  if (status === 'unavailable') {
    return <AccessState title='Authorization service unavailable' detail='Access could not be verified. Nothing was allowed. Retry when Pompeii is healthy.' action={<Button onClick={reload}>Retry</Button>} />;
  }
  if (status === 'denied' || !hasPermission(required)) {
    return <AccessState title='Access denied' detail={`Your current Pompeii assignment does not grant ${required}.`} />;
  }
  return <>{children}</>;
}

function AccessState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <main className='flex min-h-[60vh] items-center justify-center p-6'><div className='max-w-lg text-center'><h1 className='text-3xl font-semibold'>{title}</h1><p className='mt-3 text-text-secondary'>{detail}</p>{action ? <div className='mt-6'>{action}</div> : null}</div></main>;
}
