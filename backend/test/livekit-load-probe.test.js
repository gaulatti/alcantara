// gaulatti/alcantara#354: infra/livekit-load-probe.sh proves media flows through production LiveKit from outside the
// studio's network. Its credentials come from the runtime secret through backend/scripts/livekit-probe-env.mjs, which
// writes them to a 0600 file and never prints them. Fictional values only.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const helper = path.join(repo, 'backend/scripts/livekit-probe-env.mjs');
const probe = fs.readFileSync(path.join(repo, 'infra/livekit-load-probe.sh'), 'utf8');
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/production-runtime-secret.json'), 'utf8'),
);
const livekit = {
  livekitWsUrl: 'wss://livekit.example.test',
  livekitApiKey: 'APIfictionalprobekey',
  livekitApiSecret: 'fictional-probe-secret-'.padEnd(48, 'x'),
  webrtcSessionSecret: 'fictional-session-secret-'.padEnd(48, 'y'),
};

/** A stand-in for Secrets Manager's GetSecretValue that answers with `payload`, or fails with `status`. */
async function fakeSecretsManager(payload, status = 200) {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
      response.end(
        status === 200
          ? JSON.stringify({ SecretString: JSON.stringify(payload) })
          : JSON.stringify({ __type: 'ResourceNotFoundException', message: 'not found' }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd: path.join(repo, 'backend'),
      env: {
        PATH: process.env.PATH,
        AWS_ACCESS_KEY_ID: 'fictional',
        AWS_SECRET_ACCESS_KEY: 'fictional',
        AWS_MAX_ATTEMPTS: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withSecret(payload, status, check) {
  const server = await fakeSecretsManager(payload, status);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-probe-'));
  try {
    const target = path.join(dir, 'livekit.env');
    const result = await run([target], {
      ALCANTARA_CONFIG_SECRET_ID: 'fictional/config',
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: `http://127.0.0.1:${server.address().port}`,
    });
    await check(result, target);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('writes LiveKit URL, key and secret to a 0600 file and prints none of them', async () => {
  await withSecret({ ...fixture, ...livekit }, 200, (result, target) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      `LIVEKIT_URL=wss://livekit.example.test\nLIVEKIT_API_KEY=${livekit.livekitApiKey}\nLIVEKIT_API_SECRET=${livekit.livekitApiSecret}\n`,
    );
    assert.equal(result.stdout, '');
    for (const value of [livekit.livekitApiKey, livekit.livekitApiSecret, livekit.webrtcSessionSecret])
      assert.ok(!result.stderr.includes(value));
  });
});

test('exits 3 without a LiveKit group, and 1 when the secret cannot be read or no file is named', async () => {
  await withSecret(fixture, 200, (result, target) => {
    assert.equal(result.status, 3);
    assert.equal(fs.existsSync(target), false);
  });
  await withSecret(fixture, 400, (result, target) => {
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(target), false);
  });
  const missing = await run([], {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /output file argument are required/);
});

test('the probe runs the pinned CLI in a room of its own from the env file, and always cleans up', () => {
  assert.match(probe, /^set -euo pipefail$/m);
  assert.match(probe, /LIVEKIT_CLI_IMAGE="\$\{LIVEKIT_CLI_IMAGE:-livekit\/livekit-cli:v\d+\.\d+\.\d+\}"/);
  assert.match(probe, /PROBE_ROOM="alcantara-probe-/);
  assert.match(probe, /--env-file "\$workdir\/livekit\.env"/);
  assert.match(probe, /node scripts\/livekit-probe-env\.mjs \/probe\/livekit\.env/);
  assert.match(probe, /trap cleanup EXIT/);
  assert.match(probe, /rm -f "\$workdir\/livekit\.env"/);
  // Nothing reads the env file back onto the terminal or a command line.
  assert.doesNotMatch(probe, /cat "\$workdir|source "\$workdir|\. "\$workdir/);
});
