// gaulatti/alcantara#741 follow-up: the production image's static server (frontend/serve.mjs) resolves requests only
// within build/client. These tests run the real server from a temporary frontend directory that holds a client build
// and a file beside it, and send raw, encoded and dotted request paths. No response may carry the file outside the
// client build.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { createServer, request } = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const serverScript = resolve(__dirname, '../../frontend/serve.mjs');
const SECRET = 'SECRET-OUTSIDE-BUILD-CLIENT';
const SHELL = '<!doctype html><title>shell</title>';

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
    probe.on('error', fail);
  });
}

async function withServer(run) {
  const dir = mkdtempSync(join(tmpdir(), 'serve-static-'));
  try {
    mkdirSync(join(dir, 'build/client/assets'), { recursive: true });
    writeFileSync(join(dir, 'build/client/index.html'), SHELL);
    writeFileSync(join(dir, 'build/client/assets/app.js'), 'console.log(1)');
    // The file a request must never reach: beside build/client, and one level above the frontend directory.
    writeFileSync(join(dir, 'build/secret.txt'), SECRET);
    writeFileSync(join(dir, 'outside.txt'), SECRET);
    const port = await freePort();
    const child = spawn(process.execPath, [serverScript], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await waitForListening(port);
      await run(port, dir);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForListening(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await rawGet(port, '/').then(
      () => true,
      () => false,
    );
    if (up) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('the static server did not start');
}

function rawGet(port, path) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

// Every request below is a traversal or encoding attempt. Each must answer with the shell or a 404, never the secret.
const ATTEMPTS = [
  '/../build/secret.txt',
  '/../../outside.txt',
  '/..%2fbuild%2fsecret.txt',
  '/..%2F..%2Foutside.txt',
  '/%2e%2e/build/secret.txt',
  '/%2e%2e%2fbuild%2fsecret.txt',
  '/%2E%2E/%2E%2E/outside.txt',
  '/..%5cbuild%5csecret.txt',
  '/%252e%252e/build/secret.txt',
  '/%252e%252e%252fbuild%252fsecret.txt',
  '/assets/../../build/secret.txt',
  '/assets/%2e%2e/%2e%2e/build/secret.txt',
  '/assets/..%2f..%2fbuild%2fsecret.txt',
  '/./../build/secret.txt',
  '/..',
  '/%2e%2e',
  '/%00../build/secret.txt',
  '/..%00/build/secret.txt',
  '/%E0%A4%A',
];

test('no encoded or dotted request path resolves to a file outside build/client', async () => {
  await withServer(async (port) => {
    for (const path of ATTEMPTS) {
      const { status, body } = await rawGet(port, path);
      assert.doesNotMatch(body, new RegExp(SECRET), `${path} reached the file outside build/client (status ${status})`);
      assert.ok(status === 200 || status === 404, `${path} answered ${status}`);
      if (status === 200) assert.equal(body, SHELL, `${path} served something other than the shell`);
    }
  });
});

test('a traversal request gets the SPA shell, the same as any unknown route', async () => {
  await withServer(async (port) => {
    const traversal = await rawGet(port, '/../build/secret.txt');
    const unknown = await rawGet(port, '/no-such-route');
    assert.equal(traversal.status, 200);
    assert.equal(traversal.body, unknown.body);
  });
});

test('a client build file still resolves within build/client, encoded or not', async () => {
  await withServer(async (port) => {
    const plain = await rawGet(port, '/assets/app.js');
    const encoded = await rawGet(port, '/assets/%61pp.js');
    assert.equal(plain.body, 'console.log(1)');
    assert.equal(encoded.body, 'console.log(1)');
  });
});

test('a request path that is not valid percent-encoding is refused, not served', async () => {
  await withServer(async (port) => {
    const { status, body } = await rawGet(port, '/%E0%A4%A');
    assert.doesNotMatch(body, new RegExp(SECRET));
    assert.ok(status === 200 || status === 404);
  });
});
