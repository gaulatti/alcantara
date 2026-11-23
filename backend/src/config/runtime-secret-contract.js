const { isIP } = require('node:net');

const RUNTIME_SECRET_KEYS = Object.freeze([
  'palazzoAllowedUrls',
  'alanaControlToken',
  'alanaControlUrl',
  'externalSourceConfigCurrentVersion',
  'externalSourceConfigKeys',
]);
// POMPEII_ACCESS_CREDENTIAL (gaulatti/alcantara#224) is optional: absent or
// blank, the access screens answer access_unavailable and startup is unaffected.
const ALLOWLISTED_OPTIONAL_SECRET_KEYS = Object.freeze([
  'programTemplateOrigins',
  'POMPEII_ACCESS_CREDENTIAL',
]);
// gaulatti/alcantara#354: LiveKit and the WebRTC session secret. All four or none:
// none leaves guest calls and the return feed off, as before; a partial set fails.
const LIVEKIT_SECRET_KEYS = Object.freeze([
  'livekitWsUrl',
  'livekitApiKey',
  'livekitApiSecret',
  'webrtcSessionSecret',
]);
// The program renderer's key for the WebRTC renderer routes; optional.
const OPTIONAL_WEBRTC_SECRET_KEYS = Object.freeze(['webrtcRendererKey']);
// LiveKit refuses an API secret shorter than 32 characters; the session secret
// signs guest sessions and gets the same floor.
const MINIMUM_WEBRTC_SECRET_LENGTH = 32;
const allowedSecretFields = new Set([
  ...RUNTIME_SECRET_KEYS,
  ...ALLOWLISTED_OPTIONAL_SECRET_KEYS,
  ...LIVEKIT_SECRET_KEYS,
  ...OPTIONAL_WEBRTC_SECRET_KEYS,
]);
const alanaTokenPattern = /^[a-f0-9]{64}$/;

function isValidAlanaControlToken(value) {
  return typeof value === 'string' && alanaTokenPattern.test(value);
}

function normalizePrivateServiceUrl(value, fieldName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} contains an invalid URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(`${fieldName} contains an invalid URL`);
  }
  return parsed.origin;
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::1') return true;
  const first = normalized.split(':', 1)[0];
  if (first.startsWith('fc') || first.startsWith('fd')) return true;
  return /^fe[89ab]/.test(first);
}

function isPrivateServiceHostname(hostname) {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  const ipVersion = isIP(normalized.replace(/^\[|\]$/g, ''));
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  const labels = normalized.split('.');
  if (
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    return false;
  }
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.local') ||
    !normalized.includes('.')
  );
}

function normalizeAlanaControlUrl(value) {
  const normalized = normalizePrivateServiceUrl(value, 'ALANA_CONTROL_URL');
  const parsed = new URL(normalized);
  if (!isPrivateServiceHostname(parsed.hostname)) {
    throw new Error('ALANA_CONTROL_URL must use a private service hostname');
  }
  return normalized;
}

function normalizeTemplateOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PROGRAM_TEMPLATE_ORIGINS contains an invalid origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('PROGRAM_TEMPLATE_ORIGINS contains an invalid origin');
  }
  return parsed.origin;
}

function validateProgramTemplateOrigins(originsString) {
  if (typeof originsString !== 'string') {
    throw new Error('PROGRAM_TEMPLATE_ORIGINS is malformed');
  }
  return originsString
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeTemplateOrigin);
}

function validateExternalSourceEncryption(currentVersion, encodedKeys) {
  const current = Number(currentVersion);
  let parsed;
  try {
    parsed = JSON.parse(encodedKeys ?? '');
  } catch {
    throw new Error('External source encryption configuration is malformed');
  }
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('External source encryption configuration is malformed');
  }
  const entries = Object.entries(parsed);
  if (!entries.length || !Object.hasOwn(parsed, String(current))) {
    throw new Error('External source encryption configuration is malformed');
  }
  for (const [version, encoded] of entries) {
    if (
      !/^\d+$/.test(version) ||
      Number(version) < 1 ||
      typeof encoded !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      Buffer.from(encoded, 'base64').length !== 32
    ) {
      throw new Error('External source encryption configuration is malformed');
    }
  }
}

/** The public LiveKit signalling URL: wss, no credentials, query, fragment or path. */
function normalizeLivekitWsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('LIVEKIT_WS_URL contains an invalid URL');
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('LIVEKIT_WS_URL must be a wss:// origin');
  }
  return `wss://${parsed.host}`;
}

/** Validate the LiveKit group: all four or none. Messages never carry a value. */
function validateLivekitSecretGroup(selected) {
  const present = LIVEKIT_SECRET_KEYS.filter(
    (key) => selected[key] !== undefined,
  );
  if (!present.length) return;
  const missing = LIVEKIT_SECRET_KEYS.filter(
    (key) => selected[key] === undefined,
  );
  if (missing.length) {
    throw new Error(
      `Alcantara runtime configuration is incomplete; LiveKit needs all of its keys, missing: ${missing.join(', ')}`,
    );
  }
  selected.livekitWsUrl = normalizeLivekitWsUrl(selected.livekitWsUrl);
  if (/\s/.test(selected.livekitApiKey)) {
    throw new Error('LIVEKIT_API_KEY is invalid');
  }
  for (const [key, name] of [
    ['livekitApiSecret', 'LIVEKIT_API_SECRET'],
    ['webrtcSessionSecret', 'WEBRTC_SESSION_SECRET'],
  ]) {
    if (
      /\s/.test(selected[key]) ||
      selected[key].length < MINIMUM_WEBRTC_SECRET_LENGTH
    ) {
      throw new Error(
        `${name} must be at least ${MINIMUM_WEBRTC_SECRET_LENGTH} characters with no spaces`,
      );
    }
  }
}

function parseRuntimeSecretPayload(secretString) {
  let payload;
  try {
    payload = JSON.parse(secretString ?? '');
  } catch {
    throw new Error('Alcantara runtime configuration is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Alcantara runtime configuration is malformed');
  }

  const selected = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedSecretFields.has(key)) continue;
    if (typeof value !== 'string') {
      throw new Error(
        `Alcantara runtime configuration field ${key} is malformed`,
      );
    }
    if (!ALLOWLISTED_OPTIONAL_SECRET_KEYS.includes(key) && !value.trim()) {
      throw new Error(
        `Alcantara runtime configuration field ${key} is malformed`,
      );
    }
    if (key === 'alanaControlToken' && value !== value.trim()) {
      throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
    }
    selected[key] = value.trim();
  }
  const missingKeys = RUNTIME_SECRET_KEYS.filter((key) => !selected[key]);
  if (missingKeys.length) {
    throw new Error(
      `Alcantara runtime configuration is incomplete; missing keys: ${missingKeys.join(', ')}`,
    );
  }
  if (selected.programTemplateOrigins !== undefined) {
    validateProgramTemplateOrigins(selected.programTemplateOrigins);
  }
  const palazzoUrls = selected.palazzoAllowedUrls
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizePrivateServiceUrl(value, 'PALAZZO_ALLOWED_URLS'));
  if (!palazzoUrls.length) {
    throw new Error('PALAZZO_ALLOWED_URLS must contain an approved URL');
  }
  if (!isValidAlanaControlToken(selected.alanaControlToken)) {
    throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
  }
  normalizeAlanaControlUrl(selected.alanaControlUrl);
  validateExternalSourceEncryption(
    selected.externalSourceConfigCurrentVersion,
    selected.externalSourceConfigKeys,
  );
  validateLivekitSecretGroup(selected);
  return selected;
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65_536) {
      throw new Error('Alcantara runtime configuration is malformed');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    parseRuntimeSecretPayload(await readStdin());
    process.stdout.write('Alcantara production secret contract passed\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown failure';
    process.stderr.write(
      `Alcantara production secret contract failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWLISTED_OPTIONAL_SECRET_KEYS,
  LIVEKIT_SECRET_KEYS,
  OPTIONAL_WEBRTC_SECRET_KEYS,
  RUNTIME_SECRET_KEYS,
  isPrivateServiceHostname,
  isValidAlanaControlToken,
  main,
  normalizeAlanaControlUrl,
  normalizeLivekitWsUrl,
  normalizePrivateServiceUrl,
  normalizeTemplateOrigin,
  parseRuntimeSecretPayload,
  validateExternalSourceEncryption,
  validateProgramTemplateOrigins,
};
