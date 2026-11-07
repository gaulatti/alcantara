import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// Writes only the scrape bearer token to stdout so the deploy can place it in a
// root-owned file. Never logs the token or the secret payload.
const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
const region = process.env.AWS_REGION?.trim();
if (!secretId || !region) {
  console.error('ALCANTARA_CONFIG_SECRET_ID and AWS_REGION are required');
  process.exit(1);
}

let token;
try {
  const response = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  token = JSON.parse(response.SecretString ?? '').metrics_bearer_token;
} catch {
  console.error('Alcantara metrics token configuration is unavailable');
  process.exit(1);
}
if (typeof token !== 'string' || !token.trim()) {
  console.error('Alcantara secret field metrics_bearer_token is missing');
  process.exit(1);
}
process.stdout.write(token.trim());
