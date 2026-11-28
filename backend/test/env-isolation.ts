/**
 * Clears the configuration a local Compose stack sets, for the duration of one spec file, and restores it afterwards.
 * Specs that assert "missing configuration" must not depend on the machine's environment: CI sets none of these, and
 * a local stack does. NODE_ENV is left alone, because some specs set and read it themselves.
 */
const ISOLATED_PREFIXES = [
  'AUTH_MODE',
  'POMPEII_',
  'LIVEKIT_',
  'WEBRTC_',
  'TEST_AUTH_',
  'ALANA_',
  'EXTERNAL_SOURCE_',
  'AWS_',
  'ARAUCO_',
  'LOCAL_MEDIA_',
  'MEDIA_',
  'BUCKET_',
  'METRICS_TOKEN_FILE',
  'PALAZZO_ALLOWED_URLS',
];

/** Clears the isolated variables now; returns the function that restores exactly what was there. */
export function isolateEnv(): () => void {
  const saved: Record<string, string> = {};
  for (const name of Object.keys(process.env)) {
    if (ISOLATED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      saved[name] = process.env[name] as string;
      delete process.env[name];
    }
  }
  return () => {
    for (const name of Object.keys(process.env)) {
      if (ISOLATED_PREFIXES.some((prefix) => name.startsWith(prefix))) delete process.env[name];
    }
    Object.assign(process.env, saved);
  };
}
