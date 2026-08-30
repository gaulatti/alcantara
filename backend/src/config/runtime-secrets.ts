import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { readFile } from 'node:fs/promises';

interface SecretClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

interface RuntimeEnvironment {
  NODE_ENV?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  ALCANTARA_CONFIG_SECRET_ID?: string;
  PALAZZO_CONTROL_TOKEN?: string;
  PALAZZO_CONTROL_TOKEN_FILE?: string;
  PALAZZO_ALLOWED_URLS?: string;
  ALANA_CONTROL_URL?: string;
  ALANA_CONTROL_TOKEN?: string;
  ALANA_CONTROL_TOKEN_FILE?: string;
  [key: string]: string | undefined;
}

const ALLOWED_SECRET_FIELDS = new Set([
  'palazzoControlToken',
  'palazzoAllowedUrls',
  'alanaControlUrl',
  'alanaControlToken',
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

export function validateAlanaRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
): void {
  const controlUrl = environment.ALANA_CONTROL_URL?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(controlUrl);
  } catch {
    throw new Error('ALANA_CONTROL_URL is missing or invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('ALANA_CONTROL_URL is missing or invalid');
  }
  const token = environment.ALANA_CONTROL_TOKEN?.trim() ?? '';
  if (token.length < 16 || token.length > 4096) {
    throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
  }
}

/** Load the production Palazzo credential before Nest constructs any client. */
export async function loadRuntimeSecrets(
  environment: RuntimeEnvironment = process.env,
  client?: SecretClient,
): Promise<void> {
  if (environment.NODE_ENV !== 'production') return;
  const secretId = environment.ALCANTARA_CONFIG_SECRET_ID?.trim();
  if (!secretId) {
    const tokenFile = environment.PALAZZO_CONTROL_TOKEN_FILE?.trim();
    const alanaTokenFile = environment.ALANA_CONTROL_TOKEN_FILE?.trim();
    if (!tokenFile || !alanaTokenFile) {
      throw new Error(
        'ALCANTARA_CONFIG_SECRET_ID or both executor token files are required',
      );
    }
    try {
      const [palazzoToken, alanaToken] = await Promise.all([
        readFile(tokenFile, 'utf8'),
        readFile(alanaTokenFile, 'utf8'),
      ]);
      environment.PALAZZO_CONTROL_TOKEN = palazzoToken.trim();
      environment.ALANA_CONTROL_TOKEN = alanaToken.trim();
    } catch {
      throw new Error('Alcantara runtime configuration is unavailable');
    }
    validatePalazzoRuntimeConfiguration(environment);
    validateAlanaRuntimeConfiguration(environment);
    return;
  }
  const region = (
    environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION
  )?.trim();
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
  if (
    !selected.palazzoControlToken ||
    !selected.palazzoAllowedUrls ||
    !selected.alanaControlUrl ||
    !selected.alanaControlToken
  ) {
    throw new Error('Alcantara runtime configuration is incomplete');
  }
  environment.PALAZZO_CONTROL_TOKEN = selected.palazzoControlToken;
  environment.PALAZZO_ALLOWED_URLS = selected.palazzoAllowedUrls;
  environment.ALANA_CONTROL_URL = selected.alanaControlUrl;
  environment.ALANA_CONTROL_TOKEN = selected.alanaControlToken;
  validatePalazzoRuntimeConfiguration(environment);
  validateAlanaRuntimeConfiguration(environment);
}
