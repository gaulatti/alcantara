// The return runner on Helix, started by infra/helix/return-runner-up.sh: it publishes nothing, and the renderer key
// travels only on ssh input.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(repo, 'infra/helix/compose.return-runner.yml'), 'utf8');
const script = path.join(repo, 'infra/helix/return-runner-up.sh');
const SECRET = 'fictional-renderer-key-for-the-test';

function runUp({ render = 0, healthy = true, fromContainer = false, printed = `motd line\\nWEBRTC_RENDERER_KEY=${SECRET}\\n` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-runner-up-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stdin = path.join(dir, 'ssh-stdin');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('docker', `printf 'docker %s\\n' "$*" >> "${log}"\n[ "${render}" -eq 0 ] && printf 'WEBRTC_RENDERER_KEY=${SECRET}\\n'\nexit ${render}`);
  stub('ssh', `printf 'ssh %s\\n' "$*" >> "${log}"\ncase "$*" in\n  *print-return-runner-env*) [ "${render}" -eq 0 ] && printf '${printed}'; exit ${render} ;;\n  *"cat >"*) cat >> "${stdin}" ;;\n  *"docker inspect"*) exit ${healthy ? 0 : 1} ;;\nesac\nexit 0`);
  stub('scp', `printf 'scp %s\\n' "$*" >> "${log}"`);
  const args = [...(fromContainer ? ['--from-container', 'operator@backend.example.test'] : []), 'operator@helix.example.test'];
  const result = spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      ...(fromContainer ? {} : { AWS_REGION: 'us-east-1', ALCANTARA_CONFIG_SECRET_ID: 'fictional/secret-id' }),
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const sent = fs.existsSync(stdin) ? fs.readFileSync(stdin, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, sent };
}

test('the runner compose publishes no port', () => {
  assert.match(compose, /^name: alcantara-return-runner$/m);
  assert.doesNotMatch(compose, /ports:|expose:|network_mode: *host|privileged/);
});

test('return-runner-up.sh writes the key only through ssh input, then builds, starts and waits', () => {
  const run = runUp();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.sent,
    `ALCANTARA_API_URL=https://api.alcantara.gaulatti.com\nALCANTARA_APP_URL=https://alcantara.gaulatti.com\nWEBRTC_BROWSER=chromium\nWEBRTC_RENDERER_KEY=${SECRET}\n`,
  );
  for (const text of [run.calls, run.stdout, run.stderr]) assert.ok(!text.includes(SECRET));
  assert.match(run.calls, /node scripts\/print-return-runner-env\.mjs/);
  assert.match(run.calls, /umask 077 && cat > \$HOME\/\.alcantara-return-runner\/return-runner\.env\.new && mv -f/);
  assert.match(run.calls, /docker compose -f compose\.return-runner\.yml up -d --build/);
  assert.match(run.stdout, /healthy on operator@helix\.example\.test/);
});

test('return-runner-up.sh leaves Helix untouched without a key, and fails when the runner is not healthy', () => {
  for (const [render, status] of [
    [3, 3],
    [1, 1],
  ]) {
    const run = runUp({ render });
    assert.equal(run.status, status);
    assert.doesNotMatch(run.calls, /^(ssh|scp) /m);
    assert.match(run.stderr, /Helix is unchanged/);
  }
  const unhealthy = runUp({ healthy: false });
  assert.equal(unhealthy.status, 1);
  assert.match(unhealthy.stderr, /did not report healthy/);
});

test('return-runner-up.sh --from-container renders in the running backend, with no image pull or cloud access here', () => {
  const run = runUp({ fromContainer: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.calls, /ssh .*operator@backend\.example\.test sh -c 'docker exec alcantara-backend node scripts\/print-return-runner-env\.mjs'/);
  assert.doesNotMatch(run.calls, /^docker /m);
  // Only the key line reaches the file, whatever else the host's shell printed.
  assert.equal(
    run.sent,
    `ALCANTARA_API_URL=https://api.alcantara.gaulatti.com\nALCANTARA_APP_URL=https://alcantara.gaulatti.com\nWEBRTC_BROWSER=chromium\nWEBRTC_RENDERER_KEY=${SECRET}\n`,
  );
  for (const text of [run.calls, run.stdout, run.stderr]) assert.ok(!text.includes(SECRET));
  const missing = runUp({ fromContainer: true, render: 3 });
  assert.equal(missing.status, 3);
  assert.doesNotMatch(missing.calls, /^scp /m);
});

test('return-runner-up.sh passes the fleet key and the programs\' keys, one line each, and nothing else', () => {
  // Fictional values, built here.
  const fleet = 'fictional-fleet-key-for-the-launcher-test';
  const programs = '{"station-a":"alrk_fictional"}';
  const run = runUp({
    fromContainer: true,
    printed: `motd\\nWEBRTC_FLEET_KEY=${fleet}\\nWEBRTC_PROGRAM_KEYS=${programs}\\nWEBRTC_FLEET_KEY=second\\nOTHER=1\\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.sent, new RegExp(`^WEBRTC_FLEET_KEY=${fleet}$`, 'm'));
  assert.match(run.sent, /^WEBRTC_PROGRAM_KEYS=\{"station-a":"alrk_fictional"\}$/m);
  assert.doesNotMatch(run.sent, /second|OTHER|motd/);
  for (const text of [run.calls, run.stdout, run.stderr]) assert.ok(!text.includes(fleet));
});

test('return-runner-up.sh leaves Helix unchanged with program keys but no key for the router list', () => {
  const run = runUp({ fromContainer: true, printed: 'WEBRTC_PROGRAM_KEYS={"station-a":"alrk_fictional"}\\n' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /could not be read; Helix is unchanged/);
  assert.equal(run.sent, '');
});
