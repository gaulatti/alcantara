import { Amplify, type ResourcesConfig } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const userPoolDomain = import.meta.env.VITE_COGNITO_DOMAIN;
const fqdn = import.meta.env.VITE_FQDN || 'http://localhost:5173';

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
            redirectSignIn: ['http://localhost:5173', fqdn],
            redirectSignOut: ['http://localhost:5173/logout', `${fqdn}/logout`],
            responseType: 'code'
          }
        }
      }
    }
  };

  Amplify.configure(config);
}
