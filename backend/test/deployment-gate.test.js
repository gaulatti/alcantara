const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync(
  '../.github/workflows/backend-deploy.yml',
  'utf8',
);
const deployScript = readFileSync('../deploy/cumulus.sh', 'utf8');
const restoreCheck = readFileSync(
  './scripts/verify-restored-database.mjs',
  'utf8',
);
const nginx = readFileSync('../deploy/cumulus.nginx.conf', 'utf8');
const dockerfile = readFileSync('./Dockerfile', 'utf8');
const backendMain = readFileSync('./src/main.ts', 'utf8');

test('validates the production secret contract before build, push, or host mutation', () => {
  const preflight = workflow.indexOf('  production-config-preflight:');
  const build = workflow.indexOf('\n  build:');
  const deploy = workflow.indexOf('\n  deploy:');

  assert.ok(preflight >= 0);
  assert.ok(build > preflight);
  assert.ok(deploy > build);
  // gaulatti/alcantara#188: the build (and so the deploy) waits for the preflight and for the
  // repository's own unit and end-to-end tests.
  assert.match(
    workflow,
    /build:\n    needs: \[production-config-preflight, test\]/,
  );
  const tests = workflow.slice(
    workflow.indexOf('\n  test:'),
    workflow.indexOf('\n  build:'),
  );
  assert.match(tests, /pnpm --dir backend exec jest\n/);
  assert.match(tests, /--config \.\/test\/jest-e2e\.json --runInBand/);
  for (const spec of [
    'metrics',
    'media-label-concurrency',
    'filler-persistence',
    'deploy-candidate',
    'as-run-actor-migration',
    'external-sources',
    'media-analysis-duration',
    'radio-monitor',
    'recording',
    // gaulatti/alcantara#331
    'app.e2e-spec',
    'broadcast-destinations',
  ])
    assert.match(tests, new RegExp(`[|']${spec}[|']`));
  assert.doesNotMatch(tests, /clouseau|coverage/i);
  assert.match(
    workflow,
    /deploy:\n    runs-on: ubuntu-latest\n    needs: build/,
  );
  assert.match(workflow, /secretsmanager get-secret-value/);
  assert.match(
    workflow,
    /node backend\/src\/config\/runtime-secret-contract-cli\.js/,
  );
  assert.match(
    workflow,
    /ALCANTARA_CONFIG_SECRET_ID: broadcast\/production\/config/,
  );
  assert.doesNotMatch(workflow, /echo .*SecretString/);
});

test('preserves on-premises deployment and selects Cumulus when the gate is not true', () => {
  assert.match(workflow, /if: vars\.ON_PREMISES == 'true'/);
  assert.match(workflow, /if: vars\.ON_PREMISES != 'true'/);
  assert.match(workflow, /role\/alcantara-github-deploy/);
  assert.match(workflow, /Name=tag:Name,Values=macondo-services/);
  assert.match(workflow, /Expected exactly one running Macondo service host/);
  assert.match(workflow, /broadcast\/production\/config/);
  assert.match(workflow, /vars\.ARAUCO_SECRET_ARN/);
  assert.match(workflow, /vars\.MEDIA_S3_BUCKET/);
  assert.doesNotMatch(workflow, /MacondoStack/);
  assert.doesNotMatch(workflow, /route53 change-resource-record-sets/);
  assert.match(
    workflow,
    /ghcr\.io\/\$\{\{ github\.repository \}\}:\$\{\{ github\.sha \}\}/,
  );
  assert.match(workflow, /deployment_status=0/);
  assert.match(workflow, /exit \$deployment_status/);
  assert.match(workflow, /InvocationDoesNotExist/);
  assert.match(workflow, /sleep 5\s+continue/);
});

test('fails closed until Arauco contains restored Alcantara production data', () => {
  assert.match(restoreCheck, /ProgramState is absent/);
  assert.match(restoreCheck, /ProgramState is empty/);
  assert.match(deployScript, /pnpm run db:verify:restored/);
  assert.match(deployScript, /pnpm run db:migrate:deploy/);
  assert.ok(
    deployScript.indexOf('pnpm run db:verify:restored') <
      deployScript.indexOf('pnpm run db:migrate:deploy'),
  );
});

test('hydrates database credentials inside containers through the instance profile', () => {
  assert.match(deployScript, /-e ARAUCO_SECRET_ID="\$database_secret_id"/);
  assert.match(deployScript, /-e AWS_REGION=us-east-1/);
  assert.doesNotMatch(deployScript, /-e DATABASE_URL=/);
  assert.doesNotMatch(deployScript, /secretsmanager get-secret-value/);
});

test('ships the PostgreSQL 17 dump client required by hourly backups', () => {
  assert.match(dockerfile, /apk add --no-cache postgresql17-client/);
  assert.match(dockerfile, /pg_dump --version \| grep -Eq ' 17\\\.'/);
});

test('keeps the backend private to nginx and preserves realtime proxy behavior', () => {
  assert.match(deployScript, /127\.0\.0\.1:3006:3006/);
  assert.match(nginx, /proxy_buffering off/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(nginx, /proxy_read_timeout 24h/);
});

test('serves the API over HTTP/2 so long-lived streams cannot starve other requests', () => {
  assert.match(nginx, /^\s*http2 on;$/m);
});

test('allows song upload bodies through nginx while retaining the application file limit', () => {
  assert.match(nginx, /client_max_body_size 210m;/);
  assert.match(backendMain, /fileSize: 200 \* 1024 \* 1024/);
});

test('uses bounded host-local logs without a CloudWatch dependency', () => {
  for (const deployment of [workflow, deployScript]) {
    assert.match(deployment, /--log-driver=local/);
    assert.match(deployment, /--log-opt max-size=10m/);
    assert.match(deployment, /--log-opt max-file=3/);
    assert.doesNotMatch(deployment, /--log-driver=awslogs/);
    assert.doesNotMatch(deployment, /awslogs-/);
    assert.doesNotMatch(deployment, /LOGS_GROUP/);
  }
});

test('retains the previous container until the local-logging replacement is healthy', () => {
  for (const deployment of [workflow, deployScript]) {
    const retainPrevious = deployment.indexOf(
      'docker rename alcantara-backend alcantara-backend-previous',
    );
    const createReplacement = deployment.indexOf('--log-driver=local');
    const removePrevious = deployment.lastIndexOf(
      'docker rm alcantara-backend-previous',
    );

    assert.ok(retainPrevious >= 0);
    assert.ok(createReplacement > retainPrevious);
    assert.ok(removePrevious > createReplacement);
    assert.match(deployment, /rollback_backend\(\)/);
    assert.match(
      deployment,
      /docker rename alcantara-backend-previous alcantara-backend/,
    );
    assert.match(deployment, /docker start alcantara-backend/);
  }
});

test('reclaims only unused images before pulling and after retiring the rollback image', () => {
  const firstPrune = deployScript.indexOf('docker image prune --all --force');
  const pull = deployScript.indexOf('pull "$image"');
  const removePrevious = deployScript.lastIndexOf(
    'docker rm alcantara-backend-previous',
  );
  const finalPrune = deployScript.lastIndexOf(
    'docker image prune --all --force',
  );

  assert.ok(firstPrune >= 0);
  assert.ok(pull > firstPrune);
  assert.ok(finalPrune > removePrevious);
  assert.doesNotMatch(deployScript, /docker system prune/);
  assert.match(deployScript, /trap 'rm -rf "\$docker_config_dir"' EXIT/);
});

test('a failed start prints a bounded, filtered log tail on stderr', () => {
  assert.match(deployScript, /print_startup_log\(\) \{/);
  assert.match(deployScript, /tail -n 35/);
  assert.match(deployScript, /cut -c1-200 >&2/);
  assert.match(
    deployScript,
    /grep -vE 'Mapped \\\{\|RoutesResolver\|InstanceLoader'/,
  );
  const failure = deployScript.indexOf(
    'Alcantara backend failed its local health check; rolling back',
  );
  assert.ok(failure > 0);
  assert.ok(
    deployScript.indexOf('print_startup_log alcantara-backend', failure) >
      failure,
  );
  assert.doesNotMatch(deployScript, /docker logs --tail 200 alcantara-backend/);
});

// gaulatti/alcantara#223: the deploy script itself runs here against stub
// commands. A candidate that fails its health check stops the deploy before
// the running backend is stopped; a healthy one is removed and the deploy
// goes on to replace the running backend as before.
function runDeploy({
  candidateHealthy,
  tokenFails = false,
  automaticPrograms = '1',
  radioPlays = true,
  radioLive = false,
  // The host's nginx: the certificate and the installed site, absent on a new host.
  certificate = false,
  installedSite = null,
  repositorySite = '# nginx',
}) {
  const {
    mkdtempSync,
    writeFileSync,
    chmodSync,
    readFileSync: read,
  } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { spawnSync } = require('node:child_process');
  const bin = mkdtempSync(join(tmpdir(), 'alcantara-deploy-'));
  const calls = join(bin, 'calls.log');
  const stub = (name, body) => {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    'docker',
    `args="$*"
case "$args" in
  *login*) cat >/dev/null ;;
  "inspect alcantara-backend-previous") exit 1 ;;
  "run --rm"*print-metrics-token*) ${tokenFails ? 'exit 1' : 'echo fictional-scrape-token'} ;;
  *"State.Running"*) echo ${candidateHealthy ? 'true' : 'false'} ;;
  *"State.ExitCode"*) echo 3 ;;
  "exec alcantara-backend-candidate"*) exit ${candidateHealthy ? 0 : 1} ;;
  "logs alcantara-backend-candidate") echo 'Error: fictional start-up failure' ;;
  "exec alcantara-backend node"*) ${automaticPrograms === null ? 'exit 1' : `echo '${automaticPrograms}'`} ;;
  "exec palazzo node"*) ${radioLive ? "echo 'RADIO_LIVE'" : radioPlays ? "echo 'RADIO_PLAYING startedAt=fictional'" : "echo 'RADIO_NOT_PLAYING {}'; exit 1"} ;;
esac
exit 0`,
  );
  // A copy of the script with the host's nginx paths inside the sandbox.
  const site = join(bin, 'site.conf');
  const certificateFile = join(bin, 'fullchain.pem');
  if (certificate) writeFileSync(certificateFile, 'fictional certificate');
  if (installedSite !== null) writeFileSync(site, installedSite);
  const script = join(bin, 'cumulus.sh');
  writeFileSync(
    script,
    deployScript
      .replace('/etc/nginx/conf.d/cumulus-alcantara.conf', site)
      .replace(
        '/etc/letsencrypt/live/api.alcantara.gaulatti.com/fullchain.pem',
        certificateFile,
      ),
  );
  stub('curl', 'case "$*" in *write-out*) printf 200 ;; esac\nexit 0');
  // The deploy writes the token to a temp file by redirection (no pipe, so no
  // SIGPIPE under pipefail). mktemp is the one command that must hand back a real,
  // writable path; install and mv are recorded.
  stub('mktemp', `command -p mktemp "${bin}/token.XXXXXX"`);
  for (const name of [
    'install',
    'sleep',
    'mv',
    'nginx',
    'systemctl',
    'certbot',
  ])
    stub(name, 'exit 0');
  const result = spawnSync(
    'bash',
    [
      script,
      'fictional-user',
      Buffer.from('fictional-registry-token').toString('base64'),
      'fictional/broadcast',
      'fictional/database',
      'ghcr.io/example/alcantara:fictional',
      Buffer.from(repositorySite).toString('base64'),
      'fictional-bucket',
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
  const log = read(calls, 'utf8').split('\n').filter(Boolean);
  return { ...result, log, site };
}

test('a candidate that fails its health check leaves the running backend untouched', () => {
  const { status, stdout, stderr, log } = runDeploy({
    candidateHealthy: false,
  });
  assert.equal(status, 1);
  // The candidate exited (the stub reports exit code 3): the message says so, and the start-up
  // lines it prints on stderr are labelled.
  assert.match(
    stdout,
    /Alcantara candidate exited with code 3 before it answered its health check; the running backend is untouched/,
  );
  assert.match(stderr, /--- candidate start-up log/);
  assert.match(stderr, /fictional start-up failure/);
  const candidate = log.findIndex((line) =>
    line.startsWith('docker run -d --name alcantara-backend-candidate'),
  );
  assert.ok(candidate >= 0);
  assert.match(log[candidate], /-e ALCANTARA_DEPLOY_CANDIDATE=1/);
  assert.doesNotMatch(log[candidate], /broadcast-control|-p |--restart/);
  assert.ok(log.includes('docker rm -f alcantara-backend-candidate'));
  for (const line of log) {
    assert.doesNotMatch(line, /^docker (stop|rename|start) /);
    assert.doesNotMatch(line, /^docker run -d --name alcantara-backend /);
  }
});

test('a healthy candidate is removed before the running backend is replaced as before', () => {
  const { status, stdout, log } = runDeploy({ candidateHealthy: true });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /Alcantara candidate passed its health check/);
  assert.match(stdout, /ALCANTARA_HEALTHY/);
  const removed = log.lastIndexOf('docker rm -f alcantara-backend-candidate');
  const stop = log.indexOf('docker stop alcantara-backend');
  const live = log.findIndex((line) =>
    line.startsWith('docker run -d --name alcantara-backend '),
  );
  assert.ok(removed >= 0 && stop > removed && live > stop);
  assert.doesNotMatch(log[live], /ALCANTARA_DEPLOY_CANDIDATE/);
  assert.match(log[live], /--network broadcast-control/);
});

test('mounts the scrape credential from the production secret read-only without exposing it', () => {
  const tokenScript = readFileSync('./scripts/print-metrics-token.mjs', 'utf8');
  const resolve = deployScript.indexOf('node scripts/print-metrics-token.mjs');
  const stop = deployScript.indexOf('docker stop alcantara-backend');
  const run = deployScript.indexOf('docker run -d --name alcantara-backend \\');

  assert.ok(resolve >= 0);
  assert.ok(resolve < stop);
  assert.ok(stop < run);
  assert.match(tokenScript, /metrics_bearer_token/);
  assert.match(tokenScript, /process\.exit\(1\)/);
  assert.doesNotMatch(tokenScript, /console\.(log|error)\([^)]*token\)/);
  assert.match(
    deployScript,
    /node scripts\/print-metrics-token\.mjs >"\$metrics_token_tmp"/,
  );
  assert.match(
    deployScript,
    /install -m 0400 -o root -g root "\$metrics_token_tmp" "\$metrics_token_file\.new"/,
  );
  // No pipe between the writer and install: SIGPIPE under pipefail (141).
  assert.doesNotMatch(deployScript, /print-metrics-token\.mjs\s*\\?\n?\s*\|/);
  assert.doesNotMatch(deployScript, /\/dev\/stdin/);
  assert.match(deployScript, /install -d -m 0755 -o root -g root/);
  assert.match(
    deployScript,
    /-v "\$metrics_token_file":\/run\/secrets\/alcantara-metrics-token:ro/,
  );
  assert.match(
    deployScript,
    /-e METRICS_TOKEN_FILE=\/run\/secrets\/alcantara-metrics-token/,
  );
  assert.doesNotMatch(deployScript, /metrics_bearer_token/);
});

test('a deploy whose scrape token cannot be resolved stops before the running backend is touched', () => {
  const { status, log } = runDeploy({
    candidateHealthy: true,
    tokenFails: true,
  });
  assert.notEqual(status, 0);
  assert.ok(
    log.some((line) => /^docker run --rm .*print-metrics-token/.test(line)),
  );
  for (const line of log) {
    assert.doesNotMatch(line, /^docker (stop|rename|start) /);
    assert.doesNotMatch(line, /^docker run -d --name alcantara-backend /);
  }
});

test('a healthy deploy mounts the scrape token file read-only on the live backend only', () => {
  const { status, stdout, log } = runDeploy({ candidateHealthy: true });
  assert.equal(status, 0, stdout);
  const mount =
    '-v /etc/alcantara/metrics-token:/run/secrets/alcantara-metrics-token:ro';
  const live = log.find((line) =>
    line.startsWith('docker run -d --name alcantara-backend '),
  );
  const candidate = log.find((line) =>
    line.startsWith('docker run -d --name alcantara-backend-candidate'),
  );
  assert.ok(live.includes(mount));
  assert.ok(
    live.includes('-e METRICS_TOKEN_FILE=/run/secrets/alcantara-metrics-token'),
  );
  assert.ok(!candidate.includes('alcantara-metrics-token'));
  assert.doesNotMatch(log.join('\n'), /fictional-scrape-token/);
});

// gaulatti/alcantara#230: after a healthy deploy the radio must play.
test('a healthy deploy waits for a song started after the restart when a program is in automation', () => {
  const { status, stdout, log } = runDeploy({ candidateHealthy: true });
  assert.equal(status, 0, stdout);
  assert.match(
    stdout,
    /ALCANTARA_HEALTHY\n[\s\S]*RADIO_PLAYING startedAt=fictional/,
  );
  const since = deployScript.indexOf('radio_since="$(date +%s)"');
  const live = deployScript.indexOf(
    'if ! docker run -d --name alcantara-backend \\',
  );
  assert.ok(
    since > 0 && since < live,
    'the moment is taken before the new backend starts',
  );
  // The scrape token is read inside the backend container, never on the host.
  const metricsRead = log.find((line) =>
    line.startsWith('docker exec alcantara-backend node'),
  );
  assert.match(metricsRead, /METRICS_TOKEN_FILE/);
  assert.doesNotMatch(metricsRead, /fictional-scrape-token/);
  assert.ok(log.some((line) => line.startsWith('docker exec palazzo node')));
});

test('a deploy whose radio does not play fails loudly and does not roll back', () => {
  const { status, stdout, log } = runDeploy({
    candidateHealthy: true,
    radioPlays: false,
  });
  assert.equal(status, 1);
  assert.match(stdout, /ALCANTARA_HEALTHY/);
  assert.match(stdout, /RADIO_NOT_PLAYING/);
  assert.match(
    stdout,
    /RADIO_CHECK_FAILED: no song started after the restart; the backend stays deployed/,
  );
  assert.doesNotMatch(stdout, /Restoring previous Alcantara backend/);
  const removed = log.indexOf('docker rm alcantara-backend-previous');
  assert.ok(removed >= 0);
});

test('a deploy during a live show passes the radio check', () => {
  const { status, stdout } = runDeploy({
    candidateHealthy: true,
    radioPlays: false,
    radioLive: true,
  });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /RADIO_LIVE/);
  assert.doesNotMatch(stdout, /RADIO_CHECK_FAILED/);
});

test('the radio check is skipped with no program in automation and fails when the backend cannot say', () => {
  const skipped = runDeploy({ candidateHealthy: true, automaticPrograms: '0' });
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(
    skipped.stdout,
    /RADIO_CHECK_SKIPPED: no radio program is in automation/,
  );
  assert.ok(
    !skipped.log.some((line) => line.startsWith('docker exec palazzo node')),
  );

  for (const automaticPrograms of [null, '', 'many']) {
    const unknown = runDeploy({ candidateHealthy: true, automaticPrograms });
    assert.equal(unknown.status, 1);
    assert.match(
      unknown.stdout,
      /RADIO_CHECK_FAILED: the backend did not report its automatic programs/,
    );
  }
});

// The Palazzo-side poll itself, run for real against a fake state endpoint.
async function runRadioPoll(states, since) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const start =
    deployScript.indexOf("if ! docker exec palazzo node -e '") +
    "if ! docker exec palazzo node -e '".length;
  const script = deployScript
    .slice(start, deployScript.indexOf('\n\' "$radio_since"; then', start))
    .replace(
      'http://127.0.0.1:3100',
      'http://127.0.0.1:" + process.env.FAKE_PORT + "',
    )
    .replace(
      'let deadline = Date.now() + 120000;',
      'let deadline = Date.now() + Number(process.env.FAKE_BOUND_MS);',
    )
    .replace('setTimeout(resolve, 5000)', 'setTimeout(resolve, 5)');
  let served = 0;
  const server = http.createServer((request, response) => {
    const next = states[Math.min(served, states.length - 1)];
    served += 1;
    if (next === 500) {
      response.writeHead(500).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(next));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, ['-e', script, String(since)], {
    env: {
      ...process.env,
      PROGRAM_ID: 'radio one',
      FAKE_PORT: String(port),
      FAKE_BOUND_MS: '200',
    },
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  server.close();
  return { code, stdout, served };
}

test('the radio poll passes on a song started after the restart and reports a stall without URLs', async () => {
  const since = Math.floor(Date.now() / 1000);
  const idle = {
    availability: 'available',
    status: 'idle',
    track: null,
    intro: null,
    remainingSeconds: null,
    levels: { output: { rms: 0 } },
    live: { onAir: false },
    liquidsoap: { running: true },
    icecast: { connected: true },
  };
  const fresh = {
    ...idle,
    status: 'playing',
    track: {
      startedAt: new Date((since + 5) * 1000).toISOString(),
      url: 'https://media.example.test/a.mp3',
    },
    remainingSeconds: 100,
  };

  const played = await runRadioPoll([500, idle, fresh], since);
  assert.equal(played.code, 0);
  assert.match(played.stdout, /^RADIO_PLAYING startedAt=/);

  const stalled = await runRadioPoll([idle], since);
  assert.equal(stalled.code, 1);
  const report = JSON.parse(stalled.stdout.replace(/^RADIO_NOT_PLAYING /, ''));
  assert.deepEqual(report, {
    error: null,
    availability: 'available',
    status: 'idle',
    trackStartedAt: null,
    remainingSeconds: null,
    intro: null,
    outputRms: 0,
    liveOnAir: false,
    liquidsoapRunning: true,
    icecastConnected: true,
  });
  assert.doesNotMatch(stalled.stdout, /https?:/);

  // A live show passes at once, even with no song.
  const live = await runRadioPoll([{ ...idle, live: { onAir: true } }], since);
  assert.equal(live.code, 0);
  assert.equal(live.stdout, 'RADIO_LIVE\n');
  assert.equal(live.served, 1);

  const unreachable = await runRadioPoll([500], since);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stdout, /"error":"http 500"/);
});

test('a song already on air at the restart extends the wait to its end, within 15 minutes', async () => {
  const since = Math.floor(Date.now() / 1000);
  const old = {
    availability: 'available',
    status: 'playing',
    track: { startedAt: new Date((since - 60) * 1000).toISOString() },
    intro: null,
    remainingSeconds: 0.05,
    levels: { output: { rms: 0.2 } },
    live: { onAir: false },
    liquidsoap: { running: true },
    icecast: { connected: true },
  };
  const next = {
    ...old,
    track: { startedAt: new Date((since + 1) * 1000).toISOString() },
  };
  // Past the 200 ms bound the old song's end still keeps the poll going.
  const states = Array.from({ length: 60 }, () => old).concat([next]);
  const result = await runRadioPoll(states, since);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.served > 40);
});

test('writes the nginx site and asks for a certificate only while the host has no TLS', () => {
  for (const state of [
    {},
    { installedSite: 'ssl_certificate /somewhere;' },
    { certificate: true },
    { certificate: true, installedSite: 'listen 80;' },
  ]) {
    const { status, stdout, log, site } = runDeploy({
      candidateHealthy: true,
      ...state,
    });
    assert.equal(status, 0, stdout);
    assert.ok(log.some((line) => line.startsWith('install -m 0644') && line.endsWith(site)));
    assert.ok(log.includes('systemctl reload nginx'));
    assert.ok(log.some((line) => line.startsWith('certbot --nginx')));
    assert.doesNotMatch(stdout, /NGINX_SITE_KEPT/);
  }
});

test('never writes the HTTP-only file over a site that serves TLS, and names what it lacks', () => {
  const repositorySite = readFileSync('../deploy/cumulus.nginx.conf', 'utf8');
  const installedSite = `${repositorySite}\n    ssl_certificate /etc/letsencrypt/live/x/fullchain.pem; # managed by Certbot\n`;
  const same = runDeploy({ candidateHealthy: true, certificate: true, installedSite, repositorySite });
  assert.equal(same.status, 0, same.stdout);
  assert.match(same.stdout, /NGINX_SITE_KEPT/);
  assert.doesNotMatch(same.stdout, /NGINX_SITE_DRIFT/);
  assert.equal(readFileSync(same.site, 'utf8'), installedSite);
  for (const line of same.log) {
    assert.doesNotMatch(line, /^(certbot|nginx) |^systemctl reload|^install -m 0644/);
  }
  assert.ok(same.log.includes('systemctl enable --now certbot-renew.timer'));

  const changed = runDeploy({
    candidateHealthy: true,
    certificate: true,
    installedSite,
    repositorySite: repositorySite.replace('210m', '300m'),
  });
  assert.match(changed.stdout, /NGINX_SITE_DRIFT: not in the installed site: client_max_body_size 300m;/);
});

test('the deployed containers do not migrate again; the one migration runs before the swap', () => {
  const dockerfile = readFileSync('./Dockerfile', 'utf8');
  const start = dockerfile.split('\n').find((line) => line.startsWith('CMD '));
  assert.ok(start);
  // Candidate branch: starts the server with no migration.
  assert.match(start, /if \[ -n \\"\$ALCANTARA_DEPLOY_CANDIDATE\\" \]; then exec node dist\/src\/main;/);
  // Anywhere else the image still migrates, then starts; Node is exec'd so SIGTERM reaches it (#873).
  assert.match(start, /else pnpm run db:migrate:deploy && exec node dist\/src\/main; fi/);
  // The deploy step that proves the image can migrate stays.
  const migrate = deployScript.indexOf('pnpm run db:migrate:deploy');
  const candidate = deployScript.indexOf('docker run -d --name alcantara-backend-candidate');
  assert.ok(migrate >= 0 && migrate < candidate);
  assert.equal(deployScript.match(/db:migrate:deploy/g).length, 1);
  // The live container is told to start the server only.
  const { log } = runDeploy({ candidateHealthy: true });
  const live = log.find((line) => line.startsWith('docker run -d --name alcantara-backend '));
  assert.match(live, /ghcr\.io\/example\/alcantara:fictional pnpm start:prod$/);
});

test('a candidate that stayed up but did not answer says so instead of claiming an exit', () => {
  assert.match(deployScript, /did not answer its health check in time/);
});
