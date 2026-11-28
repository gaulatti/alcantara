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
// webrtcFleetKey (gaulatti/alcantara#884): the return runner's credential for the one cross-program call.
const OPTIONAL_WEBRTC_SECRET_KEYS = Object.freeze(['webrtcRendererKey', 'webrtcFleetKey']);
// LiveKit refuses an API secret shorter than 32 characters; the session secret
// signs guest sessions and gets the same floor.
const MINIMUM_WEBRTC_SECRET_LENGTH = 32;
// webrtcProgramKeys (gaulatti/alcantara#884): each program's renderer key, as `{ "<programId>": "alrk_…" }`, for the
// machines that serve it. Read by the holders' deploy only; the backend checks a key by its stored hash.
const PROGRAM_KEYS_FIELD = 'webrtcProgramKeys';
const PROGRAM_KEY_PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROGRAM_RENDERER_KEY = /^alrk_[A-Za-z0-9_-]{43}$/;
const WEBRTC_SECRET_FIELDS = new Set([
  ...LIVEKIT_SECRET_KEYS,
  ...OPTIONAL_WEBRTC_SECRET_KEYS,
  PROGRAM_KEYS_FIELD,
]);

/** The program key map, or null when it is not an object of program ids to renderer keys. */
function parseProgramKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = {};
  for (const [programId, key] of Object.entries(value)) {
    if (!PROGRAM_KEY_PROGRAM_ID.test(programId)) return null;
    if (typeof key !== 'string' || !PROGRAM_RENDERER_KEY.test(key)) return null;
    keys[programId] = key;
  }
  return keys;
}
const allowedSecretFields = new Set([
  ...RUNTIME_SECRET_KEYS,
  ...ALLOWLISTED_OPTIONAL_SECRET_KEYS,
  ...LIVEKIT_SECRET_KEYS,
  ...OPTIONAL_WEBRTC_SECRET_KEYS,
  PROGRAM_KEYS_FIELD,
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

/**
 * Why the WebRTC group cannot be used, naming fields and never a value; null
 * when it is valid or absent. All four LiveKit fields or none; the renderer key
 * is optional but must be a non-blank string.
 */
function livekitSecretGroupProblem(selected, invalidFields) {
  if (invalidFields.length) {
    return `Alcantara runtime configuration field ${invalidFields.join(', ')} is malformed`;
  }
  const present = LIVEKIT_SECRET_KEYS.filter(
    (key) => selected[key] !== undefined,
  );
  if (!present.length) return null;
  const missing = LIVEKIT_SECRET_KEYS.filter(
    (key) => selected[key] === undefined,
  );
  if (missing.length) {
    return `Alcantara runtime configuration is incomplete; LiveKit needs all of its keys, missing: ${missing.join(', ')}`;
  }
  try {
    selected.livekitWsUrl = normalizeLivekitWsUrl(selected.livekitWsUrl);
  } catch (error) {
    return error.message;
  }
  if (/\s/.test(selected.livekitApiKey)) return 'LIVEKIT_API_KEY is invalid';
  for (const [key, name] of [
    ['livekitApiSecret', 'LIVEKIT_API_SECRET'],
    ['webrtcSessionSecret', 'WEBRTC_SESSION_SECRET'],
  ]) {
    if (
      /\s/.test(selected[key]) ||
      selected[key].length < MINIMUM_WEBRTC_SECRET_LENGTH
    ) {
      return `${name} must be at least ${MINIMUM_WEBRTC_SECRET_LENGTH} characters with no spaces`;
    }
  }
  return null;
}

/**
 * Parse the runtime secret. With `strictWebrtc` (the default: the deploy's
 * contract gate and the LiveKit renderer), an invalid WebRTC group fails. Without
 * it (backend start-up), the group is dropped and `webrtcProblem` names the fields,
 * so a mistake in an optional feature never stops the backend.
 */
function parseRuntimeSecretPayload(secretString, { strictWebrtc = true } = {}) {
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
  const invalidWebrtcFields = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedSecretFields.has(key)) continue;
    if (key === PROGRAM_KEYS_FIELD) {
      const keys = parseProgramKeys(value);
      if (keys === null) invalidWebrtcFields.push(key);
      else selected[key] = keys;
      continue;
    }
    if (WEBRTC_SECRET_FIELDS.has(key)) {
      // Judged with the LiveKit group below, so a lenient caller can drop it.
      if (typeof value !== 'string' || !value.trim())
        invalidWebrtcFields.push(key);
      else selected[key] = value.trim();
      continue;
    }
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
  const livekitProblem = livekitSecretGroupProblem(
    selected,
    invalidWebrtcFields,
  );
  if (livekitProblem) {
    if (strictWebrtc) throw new Error(livekitProblem);
    // An optional feature: drop the whole WebRTC group and report it by field name.
    for (const key of WEBRTC_SECRET_FIELDS) delete selected[key];
    Object.defineProperty(selected, 'webrtcProblem', {
      value: livekitProblem,
      enumerable: false,
    });
  }
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
  PROGRAM_KEYS_FIELD,
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
