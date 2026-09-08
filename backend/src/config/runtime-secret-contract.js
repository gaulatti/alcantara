const { isIP } = require('node:net');

const RUNTIME_SECRET_KEYS = Object.freeze([
  'palazzoControlToken',
  'palazzoAllowedUrls',
  'alanaControlToken',
  'alanaControlUrl',
  'externalSourceConfigCurrentVersion',
  'externalSourceConfigKeys',
]);
const allowedSecretFields = new Set(RUNTIME_SECRET_KEYS);
const alanaTokenPattern = /^[a-f0-9]{64}$/;

function isValidPrivateControlToken(value) {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 4096 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

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
    if (typeof value !== 'string' || !value.trim()) {
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
  if (!isValidPrivateControlToken(selected.palazzoControlToken)) {
    throw new Error('PALAZZO_CONTROL_TOKEN is missing or invalid');
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

if (require.main === module) void main();

module.exports = {
  RUNTIME_SECRET_KEYS,
  isPrivateServiceHostname,
  isValidAlanaControlToken,
  isValidPrivateControlToken,
  normalizeAlanaControlUrl,
  normalizePrivateServiceUrl,
  parseRuntimeSecretPayload,
  validateExternalSourceEncryption,
};
