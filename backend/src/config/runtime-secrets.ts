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

export function isValidPalazzoControlToken(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length <= 4096 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

export function normalizePalazzoBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PALAZZO_ALLOWED_URLS contains an invalid URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('PALAZZO_ALLOWED_URLS contains an invalid URL');
  }
  return parsed.origin;
}

/** Validate the Palazzo machine configuration without constructing Nest. */
export function validatePalazzoRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
): void {
  const token = environment.PALAZZO_CONTROL_TOKEN?.trim() ?? '';
  if (!isValidPalazzoControlToken(token)) {
    throw new Error('PALAZZO_CONTROL_TOKEN is missing or invalid');
  }
  const allowedUrls = (environment.PALAZZO_ALLOWED_URLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePalazzoBaseUrl);
  if (!allowedUrls.length) {
    throw new Error('PALAZZO_ALLOWED_URLS must contain an approved URL');
  }
}

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
  validatePalazzoRuntimeConfiguration(environment);
}
