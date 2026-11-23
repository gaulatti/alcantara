const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

// Runs the real script against a local fake Secrets Manager endpoint. Every
// value here is fictional.
const script = join(__dirname, '..', 'scripts', 'print-metrics-token.mjs');
const fakeToken = 'fictional-scrape-token';

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => handler(response));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function respondWith(secretString) {
  return (response) => {
    response.setHeader('content-type', 'application/x-amz-json-1.1');
    response.end(JSON.stringify({ SecretString: secretString }));
  };
}

async function run({ handler, env = {} }) {
  const server = handler ? await serve(handler) : null;
  const endpoint = server
    ? `http://127.0.0.1:${server.address().port}`
    : 'http://127.0.0.1:9';
  const child = spawn(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'fictional',
      AWS_SECRET_ACCESS_KEY: 'fictional',
      AWS_ENDPOINT_URL: endpoint,
      AWS_REGION: 'us-east-1',
      ALCANTARA_CONFIG_SECRET_ID: 'fictional/config',
      AWS_MAX_ATTEMPTS: '1',
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const status = await new Promise((resolve) => child.on('close', resolve));
  server?.close();
  return { status, stdout, stderr };
}

function assertNoDisclosure(result) {
  assert.ok(!result.stderr.includes(fakeToken));
}

test('prints only the trimmed token field to stdout', async () => {
  const result = await run({
    handler: respondWith(
      JSON.stringify({ metrics_bearer_token: `  ${fakeToken}\n`, other: 'x' }),
    ),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, fakeToken);
  assert.equal(result.stderr, '');
});

test('fails without the secret id or the region', async () => {
  for (const env of [{ ALCANTARA_CONFIG_SECRET_ID: ' ' }, { AWS_REGION: '' }]) {
    const result = await run({ env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /are required/);
  }
});

test('fails when the secret cannot be read, is not JSON, or has no payload', async () => {
  const failing = await run({
    handler: (response) => {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/x-amz-json-1.1');
      response.end(JSON.stringify({ __type: 'ResourceNotFoundException' }));
    },
  });
  const notJson = await run({ handler: respondWith('not json') });
  const noPayload = await run({
    handler: (response) => {
      response.setHeader('content-type', 'application/x-amz-json-1.1');
      response.end('{}');
    },
  });
  for (const result of [failing, notJson, noPayload]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /configuration is unavailable/);
  }
});

test('fails when the token field is missing, blank or not a string', async () => {
  for (const payload of [
    {},
    { metrics_bearer_token: '   ' },
    { metrics_bearer_token: 42 },
  ]) {
    const result = await run({ handler: respondWith(JSON.stringify(payload)) });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /metrics_bearer_token is missing/);
    assertNoDisclosure(result);
  }
});
