import { Amplify, type ResourcesConfig } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const userPoolDomain = import.meta.env.VITE_COGNITO_DOMAIN;
const port = import.meta.env.VITE_PORT || '5173';
const fqdn = import.meta.env.VITE_FQDN || `http://localhost:${port}`;
const localOrigin = `http://localhost:${port}`;
const runtimeOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;

const redirectSignIn = Array.from(new Set([runtimeOrigin, localOrigin, fqdn].filter(Boolean))) as string[];
const redirectSignOut = redirectSignIn.map((origin) => `${origin}/logout`);

if (userPoolId && userPoolClientId && userPoolDomain) {
  const config: ResourcesConfig = {
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          oauth: {
            domain: userPoolDomain,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn,
            redirectSignOut,
            responseType: 'code'
          }
        }
      }
    }
  };

  Amplify.configure(config);
}
