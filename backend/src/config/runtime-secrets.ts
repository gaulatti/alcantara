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
  EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION?: string;
  EXTERNAL_SOURCE_CONFIG_KEYS?: string;
  [key: string]: string | undefined;
}

const ALLOWED_SECRET_FIELDS = new Set([
  'palazzoControlToken',
  'palazzoAllowedUrls',
  'externalSourceConfigCurrentVersion',
  'externalSourceConfigKeys',
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
  if (!secretId) {
    const tokenFile = environment.PALAZZO_CONTROL_TOKEN_FILE?.trim();
    if (!tokenFile) {
      throw new Error(
        'ALCANTARA_CONFIG_SECRET_ID or PALAZZO_CONTROL_TOKEN_FILE is required',
      );
    }
    try {
      environment.PALAZZO_CONTROL_TOKEN = (
        await readFile(tokenFile, 'utf8')
      ).trim();
    } catch {
      throw new Error('Alcantara runtime configuration is unavailable');
    }
    validatePalazzoRuntimeConfiguration(environment);
    validateExternalSourceEncryption(environment);
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
    !selected.externalSourceConfigCurrentVersion ||
    !selected.externalSourceConfigKeys
  ) {
    throw new Error('Alcantara runtime configuration is incomplete');
  }
  environment.PALAZZO_CONTROL_TOKEN = selected.palazzoControlToken;
  environment.PALAZZO_ALLOWED_URLS = selected.palazzoAllowedUrls;
  environment.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION =
    selected.externalSourceConfigCurrentVersion;
  environment.EXTERNAL_SOURCE_CONFIG_KEYS = selected.externalSourceConfigKeys;
  validatePalazzoRuntimeConfiguration(environment);
  validateExternalSourceEncryption(environment);
}

export function validateExternalSourceEncryption(
  environment: RuntimeEnvironment = process.env,
): void {
  const current = Number(environment.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION);
  let parsed: unknown;
  try {
    parsed = JSON.parse(environment.EXTERNAL_SOURCE_CONFIG_KEYS ?? '');
  } catch {
    throw new Error('External source encryption configuration is malformed');
  }
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  )
    throw new Error('External source encryption configuration is malformed');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length || !Object.hasOwn(parsed, String(current)))
    throw new Error('External source encryption configuration is malformed');
  for (const [version, encoded] of entries) {
    if (
      !/^\d+$/.test(version) ||
      Number(version) < 1 ||
      typeof encoded !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      Buffer.from(encoded, 'base64').length !== 32
    )
      throw new Error('External source encryption configuration is malformed');
  }
}
