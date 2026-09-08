export const RUNTIME_SECRET_KEYS: readonly [
  'palazzoControlToken',
  'palazzoAllowedUrls',
  'alanaControlToken',
  'alanaControlUrl',
  'externalSourceConfigCurrentVersion',
  'externalSourceConfigKeys',
];

export type RuntimeSecretPayload = {
  palazzoControlToken: string;
  palazzoAllowedUrls: string;
  alanaControlToken: string;
  alanaControlUrl: string;
  externalSourceConfigCurrentVersion: string;
  externalSourceConfigKeys: string;
};

export function isPrivateServiceHostname(hostname: string): boolean;
export function isValidAlanaControlToken(value: string): boolean;
export function isValidPrivateControlToken(value: string): boolean;
export function normalizeAlanaControlUrl(value: string): string;
export function normalizePrivateServiceUrl(
  value: string,
  fieldName: string,
): string;
export function parseRuntimeSecretPayload(
  secretString: string | undefined,
): RuntimeSecretPayload;
export function validateExternalSourceEncryption(
  currentVersion: string | undefined,
  encodedKeys: string | undefined,
): void;
