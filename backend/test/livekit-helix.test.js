// gaulatti/alcantara#354: production LiveKit runs on Helix, started by
// infra/helix/livekit-up.sh; the backend deploy never starts it.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(
  path.join(repo, '.github/workflows/backend-deploy.yml'),
  'utf8',
);
const compose = fs.readFileSync(
  path.join(repo, 'infra/helix/compose.livekit.yml'),
  'utf8',
);
const nginx = fs.readFileSync(
  path.join(repo, 'infra/helix/nginx-livekit.conf'),
  'utf8',
);
const script = path.join(repo, 'infra/helix/livekit-up.sh');

/** The lines of one top-level compose service, up to the next one. */
function service(name) {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `compose defines ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S|^\S/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

test('the backend deploy neither starts LiveKit nor points the backend at a local one', () => {
  for (const absent of [
    'print-livekit-config',
    'compose.production.yml',
    'compose.livekit.yml',
    'Upload LiveKit deployment definition',
    'LIVEKIT_API_URL',
  ])
    assert.ok(!workflow.includes(absent), `${absent} is gone from the deploy`);
});

test('the Helix compose publishes signalling on loopback and exactly three media ports', () => {
  const livekit = service('livekit');
  const published = [...livekit.matchAll(/^\s*- '([^']+)'$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(published, [
    '127.0.0.1:7880:7880/tcp',
    '7881:7881/tcp',
    '7882:7882/udp',
    '3478:3478/udp',
    // TURN over TLS, behind nginx on 443.
    '127.0.0.1:5349:5349/tcp',
  ]);
  assert.doesNotMatch(service('redis'), /ports:/);
  assert.match(compose, /^name: alcantara-livekit$/m);
  assert.doesNotMatch(compose, /external: true|broadcast-control|letsencrypt/);
});

test('the Helix compose keeps LiveKit bounded, healthy-gated and ingress opt-in', () => {
  const livekit = service('livekit');
  assert.match(livekit, /^\s*cpus: 1\.0$/m);
  assert.match(livekit, /^\s*mem_limit: 1g$/m);
  assert.match(livekit, /restart: always/);
  assert.match(livekit, /healthcheck:\n\s*test: \['CMD', 'wget'/);
  assert.match(service('redis'), /^\s*cpus: 0\.5$/m);
  assert.match(service('redis'), /^\s*mem_limit: 512m$/m);
  assert.match(service('ingress'), /profiles: \['ingress'\]/);
});

test('nginx proxies the public name to loopback signalling with WebSocket upgrades', () => {
  assert.match(nginx, /server_name livekit\.alcantara\.gaulatti\.com;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7880;/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(nginx, /proxy_set_header Connection "upgrade";/);
  // certbot --nginx writes the TLS half, as for the host's other sites.
  assert.doesNotMatch(nginx, /listen .*443|ssl_certificate/);
});

/**
 * Runs livekit-up.sh with stub docker, ssh and scp that record their arguments
 * and the ssh input. `render` is the renderer's exit code; `healthy` whether
 * LiveKit's health check passes.
 */
function runUp({ render, healthy = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-up-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stdin = path.join(dir, 'ssh-stdin');
  const fakeConfig = 'keys:\n  "APIfictional": "fictional-secret-for-the-test"';
  const stub = (name, body) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  stub(
    'docker',
    `printf 'docker %s\\n' "$*" >> "${log}"
[ "${render}" -eq 0 ] && printf '%s\\n' '${fakeConfig}'
exit ${render}`,
  );
  stub(
    'ssh',
    `printf 'ssh %s\\n' "$*" >> "${log}"
case "$*" in
  *"cat >"*) cat >> "${stdin}" ;;
  *"docker inspect"*) exit ${healthy ? 0 : 1} ;;
esac
exit 0`,
  );
  stub('scp', `printf 'scp %s\\n' "$*" >> "${log}"`);
  const result = spawnSync('sh', [script, 'operator@helix.example.test'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      AWS_REGION: 'us-east-1',
      ALCANTARA_CONFIG_SECRET_ID: 'fictional/secret-id',
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const sent = fs.existsSync(stdin) ? fs.readFileSync(stdin, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, sent, fakeConfig };
}

test('livekit-up.sh streams the rendered config only on ssh input, then starts and waits', () => {
  const run = runUp({ render: 0 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.sent, `${run.fakeConfig}\n`);
  // The config is never an argument (visible in process lists) or output.
  assert.ok(!run.calls.includes('fictional-secret-for-the-test'));
  assert.ok(!run.stdout.includes('fictional-secret-for-the-test'));
  assert.ok(!run.stderr.includes('fictional-secret-for-the-test'));
  assert.match(run.calls, /docker run --rm .* node scripts\/print-livekit-config\.mjs/);
  assert.match(run.calls, /umask 077 && cat > \$HOME\/\.alcantara-livekit\/livekit\.yaml\.new && mv -f/);
  assert.match(run.calls, /scp .*compose\.livekit\.yml .*nginx-livekit\.conf .*nginx-turn-stream\.conf .*operator@helix\.example\.test:\.alcantara-livekit\//);
  assert.match(run.calls, /docker compose -f compose\.livekit\.yml up -d/);
  assert.match(run.calls, /docker inspect -f \{\{\.State\.Health\.Status\}\} alcantara-livekit/);
  assert.match(run.stdout, /LiveKit is healthy on operator@helix\.example\.test/);
});

test('livekit-up.sh leaves Helix untouched when the secret has no LiveKit group', () => {
  const run = runUp({ render: 3 });
  assert.equal(run.status, 3);
  assert.doesNotMatch(run.calls, /^(ssh|scp) /m);
  assert.match(run.stderr, /not configured in the runtime secret; Helix is unchanged/);
});

test('livekit-up.sh leaves Helix untouched when the config cannot be rendered', () => {
  const run = runUp({ render: 1 });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.calls, /^(ssh|scp) /m);
  assert.match(run.stderr, /could not be rendered; Helix is unchanged/);
});

test('livekit-up.sh fails when LiveKit does not report healthy', () => {
  const run = runUp({ render: 0, healthy: false });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /did not report healthy within two minutes/);
});
