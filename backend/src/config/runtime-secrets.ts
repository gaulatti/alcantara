import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

interface SecretClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

interface RuntimeEnvironment {
  NODE_ENV?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  ALCANTARA_CONFIG_SECRET_ID?: string;
  PALAZZO_CONTROL_TOKEN?: string;
  PALAZZO_ALLOWED_URLS?: string;
  [key: string]: string | undefined;
}

const ALLOWED_SECRET_FIELDS = new Set([
  'palazzoControlToken',
  'palazzoAllowedUrls',
]);

/** Load the production Palazzo credential before Nest constructs any client. */
export async function loadRuntimeSecrets(
  environment: RuntimeEnvironment = process.env,
  client?: SecretClient,
): Promise<void> {
  if (environment.NODE_ENV !== 'production') return;
  const secretId = environment.ALCANTARA_CONFIG_SECRET_ID?.trim();
  const region = (
    environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION
  )?.trim();
  if (!secretId) throw new Error('ALCANTARA_CONFIG_SECRET_ID is required');
  if (!region) throw new Error('AWS_REGION is required');
  const secrets = client ?? new SecretsManagerClient({ region });
  let response: { SecretString?: string };
  try {
    response = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
  } catch {
    throw new Error('Alcantara runtime configuration is unavailable');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.SecretString ?? '');
  } catch {
    throw new Error('Alcantara runtime configuration is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Alcantara runtime configuration is malformed');
  }
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_SECRET_FIELDS.has(key)) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Alcantara runtime configuration is malformed');
    }
    selected[key] = value.trim();
  }
  if (!selected.palazzoControlToken || !selected.palazzoAllowedUrls) {
    throw new Error('Alcantara Palazzo configuration is incomplete');
  }
  environment.PALAZZO_CONTROL_TOKEN = selected.palazzoControlToken;
  environment.PALAZZO_ALLOWED_URLS = selected.palazzoAllowedUrls;
}
