import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { readFile } from 'node:fs/promises';
import {
  isValidAlanaControlToken,
  normalizeAlanaControlUrl,
  normalizePrivateServiceUrl,
  parseRuntimeSecretPayload,
  validateExternalSourceEncryption as validateExternalSourceEncryptionValues,
} from './runtime-secret-contract';

interface SecretClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

interface RuntimeEnvironment {
  NODE_ENV?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  ALCANTARA_CONFIG_SECRET_ID?: string;
  PALAZZO_ALLOWED_URLS?: string;
  ALANA_CONTROL_TOKEN?: string;
  ALANA_CONTROL_TOKEN_FILE?: string;
  ALANA_CONTROL_URL?: string;
  EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION?: string;
  EXTERNAL_SOURCE_CONFIG_KEYS?: string;
  [key: string]: string | undefined;
}

export { normalizePrivateServiceUrl };

export function normalizePalazzoBaseUrl(value: string): string {
  return normalizePrivateServiceUrl(value, 'PALAZZO_ALLOWED_URLS');
}

/** Validate the Palazzo machine configuration without constructing Nest. */
export function validatePalazzoRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
): void {
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
  const token = environment.ALANA_CONTROL_TOKEN ?? '';
  if (!isValidAlanaControlToken(token)) {
    throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
  }
  normalizeAlanaControlUrl(environment.ALANA_CONTROL_URL?.trim() ?? '');
}

export function validateRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
): void {
  validatePalazzoRuntimeConfiguration(environment);
  validateAlanaRuntimeConfiguration(environment);
  validateExternalSourceEncryption(environment);
}

/** Load production private-service configuration before constructing clients. */
export async function loadRuntimeSecrets(
  environment: RuntimeEnvironment = process.env,
  client?: SecretClient,
): Promise<void> {
  if (environment.NODE_ENV !== 'production') return;
  const secretId = environment.ALCANTARA_CONFIG_SECRET_ID?.trim();
  if (!secretId) {
    const alanaTokenFile = environment.ALANA_CONTROL_TOKEN_FILE?.trim();
    if (!alanaTokenFile) {
      throw new Error(
        'ALCANTARA_CONFIG_SECRET_ID or ALANA_CONTROL_TOKEN_FILE is required',
      );
    }
    try {
      const alanaToken = await readFile(alanaTokenFile, 'utf8');
      environment.ALANA_CONTROL_TOKEN = alanaToken.replace(/\r?\n$/, '');
    } catch {
      throw new Error('Alcantara runtime configuration is unavailable');
    }
    validateRuntimeConfiguration(environment);
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
  const selected = parseRuntimeSecretPayload(response.SecretString);
  environment.PALAZZO_ALLOWED_URLS = selected.palazzoAllowedUrls;
  environment.ALANA_CONTROL_TOKEN = selected.alanaControlToken;
  environment.ALANA_CONTROL_URL = selected.alanaControlUrl;
  environment.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION =
    selected.externalSourceConfigCurrentVersion;
  environment.EXTERNAL_SOURCE_CONFIG_KEYS = selected.externalSourceConfigKeys;
  validateRuntimeConfiguration(environment);
}

export function validateExternalSourceEncryption(
  environment: RuntimeEnvironment = process.env,
): void {
  validateExternalSourceEncryptionValues(
    environment.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION,
    environment.EXTERNAL_SOURCE_CONFIG_KEYS,
  );
}
