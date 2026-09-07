const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  RUNTIME_SECRET_KEYS,
  isValidAlanaControlToken,
  normalizeAlanaControlUrl,
  parseRuntimeSecretPayload,
} = require('../src/config/runtime-secret-contract');

const fixturePath = join(
  __dirname,
  'fixtures',
  'production-runtime-secret.json',
);
const contractPath = join(
  __dirname,
  '..',
  'src',
  'config',
  'runtime-secret-contract.js',
);

test('accepts only the exact required production secret keys', () => {
  const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
  payload.untrustedValue = 'must-not-enter-runtime';

  const selected = parseRuntimeSecretPayload(JSON.stringify(payload));

  assert.deepEqual(Object.keys(selected), [...RUNTIME_SECRET_KEYS]);
  assert.equal(selected.untrustedValue, undefined);
});

test('requires a 64-character lowercase hexadecimal Alana bearer token', () => {
  assert.equal(isValidAlanaControlToken('a'.repeat(64)), true);
  assert.equal(isValidAlanaControlToken('A'.repeat(64)), false);
  assert.equal(isValidAlanaControlToken('a'.repeat(63)), false);
  assert.equal(isValidAlanaControlToken(`a${' '.repeat(63)}`), false);
  const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
  payload.alanaControlToken = ` ${payload.alanaControlToken}`;
  assert.throws(
    () => parseRuntimeSecretPayload(JSON.stringify(payload)),
    /ALANA_CONTROL_TOKEN is missing or invalid/,
  );
});

test('allows only origin-only private Alana service targets', () => {
  assert.equal(
    normalizeAlanaControlUrl('http://alana:8080'),
    'http://alana:8080',
  );
  assert.equal(
    normalizeAlanaControlUrl('https://recorder.broadcast.internal'),
    'https://recorder.broadcast.internal',
  );
  assert.throws(
    () => normalizeAlanaControlUrl('http://198.51.100.10:8080'),
    /private service hostname/,
  );
  assert.throws(
    () => normalizeAlanaControlUrl('http://-:8080'),
    /private service hostname/,
  );
  assert.throws(
    () => normalizeAlanaControlUrl('https://user:password@alana:8080/path'),
    /invalid URL/,
  );
});

test('the fixture-driven production preflight never prints configuration values', () => {
  const input = readFileSync(fixturePath, 'utf8');
  const result = spawnSync(process.execPath, [contractPath], {
    encoding: 'utf8',
    input,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Alcantara production secret contract passed\n');
  for (const value of Object.values(JSON.parse(input))) {
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value));
  }
});

test('invalid production input fails with redacted evidence', () => {
  const sensitiveValue = 'DO_NOT_PRINT_THIS_VALUE';
  const input = JSON.stringify({
    palazzoControlToken: 'fictional-palazzo-control-token',
    palazzoAllowedUrls: 'http://palazzo:3100',
    alanaControlToken: sensitiveValue,
    alanaControlUrl: 'https://public.example.com',
  });
  const result = spawnSync(process.execPath, [contractPath], {
    encoding: 'utf8',
    input,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ALANA_CONTROL_TOKEN is missing or invalid/);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_THIS_VALUE/);
  assert.doesNotMatch(result.stdout + result.stderr, /public\.example\.com/);
});
