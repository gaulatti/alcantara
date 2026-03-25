import { BleeckerThemeScript, ThemeProvider } from '@gaulatti/bleecker';
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import type { ReactNode } from 'react';

import type { Route } from './+types/root';
import './app.css';

export const links: Route.LinksFunction = () => [
  { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous'
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=EB+Garamond:wght@400;700&family=Encode+Sans:wght@700&family=JetBrains+Mono:wght@400;700&family=Libre+Franklin:wght@300;400;500;600;700&family=Outfit:wght@500&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap'
  }
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <Meta />
        <Links />
        <BleeckerThemeScript storageKey='theme' />
      </head>
      <body className='bg-light-sand text-text-primary'>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme='system' storageKey='theme'>
      <Outlet />
    </ThemeProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details = error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <div className='min-h-screen flex flex-col'>
      <main className='flex-1 flex items-center justify-center bg-light-sand dark:bg-dark-sand p-6'>
        <div className='text-center px-4 max-w-2xl mx-auto'>
          <h1 className='text-6xl font-bold text-text-primary dark:text-text-primary mb-4'>{message}</h1>
          <p className='text-xl text-text-secondary dark:text-text-secondary mb-8'>{details}</p>
          {stack && (
            <pre className='w-full p-4 overflow-x-auto bg-white/50 rounded-lg text-left text-sm'>
              <code>{stack}</code>
            </pre>
          )}
        </div>
      </main>
    </div>
  );
}
