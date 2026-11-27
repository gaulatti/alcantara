// The on-air contribution worker on cumulus, started by infra/cumulus/contribution-up.sh: it publishes nothing, is
// memory-capped beside Palazzo, and the renderer key travels only on ssh input.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(repo, 'infra/cumulus/compose.contribution.yml'), 'utf8');
const script = path.join(repo, 'infra/cumulus/contribution-up.sh');
const SECRET = 'fictional-renderer-key-for-the-test';

function runUp({ render = 0, healthy = true, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-up-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stdin = path.join(dir, 'ssh-stdin');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('ssh', `printf 'ssh %s\\n' "$*" >> "${log}"\ncase "$*" in\n  *print-return-runner-env*) [ "${render}" -eq 0 ] && printf 'motd line\\nWEBRTC_RENDERER_KEY=${SECRET}\\n'; exit ${render} ;;\n  *"cat >"*) cat >> "${stdin}" ;;\n  *"inspect"*) exit ${healthy ? 0 : 1} ;;\nesac\nexit 0`);
  stub('scp', `printf 'scp %s\\n' "$*" >> "${log}"`);
  const result = spawnSync('sh', [script, 'operator@cumulus.example.test'], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...env },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const sent = fs.existsSync(stdin) ? fs.readFileSync(stdin, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, sent };
}

test('the contribution compose publishes no port, is capped and joins only the broadcast-control network', () => {
  assert.match(compose, /^name: alcantara-contribution$/m);
  assert.doesNotMatch(compose, /ports:|expose:|network_mode: *host|privileged/);
  assert.match(compose, /^ {4}mem_limit: 256m$/m);
  assert.match(compose, /^ {4}memswap_limit: 256m$/m);
  assert.match(compose, /^ {4}cpus: 0\.5$/m);
  assert.match(compose, /broadcast-control:\n {4}external: true/);
});

test('contribution-up.sh writes the key only through ssh input, then builds, starts and waits', () => {
  const run = runUp();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.sent,
    `ALCANTARA_API_URL=https://api.alcantara.gaulatti.com\nPROGRAM_ID=modoitaliano.fm\nCONTRIBUTION_RTMP_URL=rtmp://palazzo:1935/live/contribution\nWEBRTC_RENDERER_KEY=${SECRET}\n`,
  );
  for (const text of [run.calls, run.stdout, run.stderr]) assert.ok(!text.includes(SECRET));
  assert.match(run.calls, /ssh .*operator@cumulus\.example\.test sh -c 'docker exec alcantara-backend node scripts\/print-return-runner-env\.mjs'/);
  assert.match(run.calls, /umask 077 && cat > \$HOME\/\.alcantara-contribution\/contribution\.env\.new && mv -f/);
  assert.match(run.calls, /scp .*worker\.mjs/);
  assert.match(run.calls, /docker compose -f compose\.contribution\.yml up -d --build/);
  assert.match(run.stdout, /healthy on operator@cumulus\.example\.test/);
});

test('contribution-up.sh takes another program, address and docker command', () => {
  const run = runUp({
    env: {
      CONTRIBUTION_PROGRAM_ID: 'harbor.fm',
      CONTRIBUTION_RTMP_URL: 'rtmp://palazzo-b:1935/live/x',
      ALCANTARA_BACKEND_DOCKER: 'sudo docker',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.sent, /^PROGRAM_ID=harbor\.fm$/m);
  assert.match(run.sent, /^CONTRIBUTION_RTMP_URL=rtmp:\/\/palazzo-b:1935\/live\/x$/m);
  assert.match(run.calls, /sudo docker exec alcantara-backend/);
  assert.match(run.calls, /sudo docker compose -f compose\.contribution\.yml/);
});

test('contribution-up.sh leaves cumulus unchanged without a key, and fails when the worker is not healthy', () => {
  for (const [render, status] of [
    [3, 3],
    [1, 1],
  ]) {
    const run = runUp({ render });
    assert.equal(run.status, status);
    assert.doesNotMatch(run.calls, /^scp /m);
    assert.doesNotMatch(run.calls, /cat >/);
    assert.match(run.stderr, /cumulus is unchanged/);
  }
  const unhealthy = runUp({ healthy: false });
  assert.equal(unhealthy.status, 1);
  assert.match(unhealthy.stderr, /did not report healthy/);
  const usage = spawnSync('sh', [script], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage:/);
});
