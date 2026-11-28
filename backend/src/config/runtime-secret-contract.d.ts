export const RUNTIME_SECRET_KEYS: readonly [
  'palazzoAllowedUrls',
  'alanaControlToken',
  'alanaControlUrl',
  'externalSourceConfigCurrentVersion',
  'externalSourceConfigKeys',
];

export const ALLOWLISTED_OPTIONAL_SECRET_KEYS: readonly [
  'programTemplateOrigins',
  'POMPEII_ACCESS_CREDENTIAL',
];

export const LIVEKIT_SECRET_KEYS: readonly [
  'livekitWsUrl',
  'livekitApiKey',
  'livekitApiSecret',
  'webrtcSessionSecret',
];

export const OPTIONAL_WEBRTC_SECRET_KEYS: readonly ['webrtcRendererKey', 'webrtcFleetKey'];

export type RuntimeSecretPayload = {
  palazzoAllowedUrls: string;
  alanaControlToken: string;
  alanaControlUrl: string;
  externalSourceConfigCurrentVersion: string;
  externalSourceConfigKeys: string;
  programTemplateOrigins?: string;
  POMPEII_ACCESS_CREDENTIAL?: string;
  /** All four LiveKit fields are present together, or none is. */
  livekitWsUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  webrtcSessionSecret?: string;
  webrtcRendererKey?: string;
  webrtcFleetKey?: string;
};

export function isPrivateServiceHostname(hostname: string): boolean;
export function isValidAlanaControlToken(value: string): boolean;
export function main(): Promise<void>;
export function normalizeAlanaControlUrl(value: string): string;
export function normalizeLivekitWsUrl(value: string): string;
export function normalizePrivateServiceUrl(
  value: string,
  fieldName: string,
): string;
export function normalizeTemplateOrigin(value: string): string;
export function parseRuntimeSecretPayload(
  secretString: string | undefined,
  options?: { strictWebrtc?: boolean },
): RuntimeSecretPayload & {
  /** Set only without strictWebrtc: why the WebRTC group was dropped (field names only). */
  readonly webrtcProblem?: string;
};
export function validateExternalSourceEncryption(
  currentVersion: string | undefined,
  encodedKeys: string | undefined,
): void;
export function validateProgramTemplateOrigins(
  originsString: string | undefined,
): string[];
