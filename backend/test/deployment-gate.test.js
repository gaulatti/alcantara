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
  assert.match(deployScript, /-p "127\.0\.0\.1:\$port:\$port"/);
  assert.match(deployScript, /start_backend alcantara-backend 3006 node dist\/src\/main/);
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
    // The replacement is created after the previous container is set aside (the deploy script also defines its
    // start helper, which carries the same flags, above that point).
    const createReplacement =
      deployment === deployScript
        ? deployment.indexOf('start_backend alcantara-backend 3006', retainPrevious)
        : deployment.indexOf('--log-driver=local', retainPrevious);
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
  // gaulatti/alcantara#873: an image that answers /health/ready, the running backend's port, whether the new one
  // reports standby, whether it takes the lease once the old one stops, and whether nginx accepts the switch.
  // Every image holds the lease since the closer; false is an image from before it, which is refused. Left unset, the
  // running backend reports nothing on /health/ready, so the deploy stops it, then starts the new one (the path a
  // new host or a skipped handover takes); true makes it the active owner, so the deploy hands over.
  leaseImage,
  livePort = '3006',
  // The running backend's own /health/ready: 'active' for one that holds the lease, '' for one from before it.
  liveState = leaseImage === true ? 'active' : '',
  standbyReady = true,
  standbyState = 'standby',
  activates = true,
  oldRestores = true,
  stopFails = false,
  nginxValid = true,
  reloadFails = false,
  memAvailableKb = null,
  publicStatus = '200',
  // A full disk: the new site cannot be written beside the old one.
  fullDisk = false,
  // A handover container left running without a live backend, and a host with no live backend.
  leftoverNext = false,
  noLiveBackend = false,
  // How many checks after the reload still find a worker from before it accepting (Infinity: it never stops).
  nginxWorkersLinger = 0,
  // The old backend takes this long to exit after it frees the lease (held connections), in seconds.
  slowStop = 0,
  // The host nginx master's pid as systemd reports it ('' or '0' when unknown).
  nginxMaster = '4242',
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
  "inspect alcantara-backend-next") exit ${leftoverNext ? 0 : 1} ;;
  "inspect alcantara-backend") exit ${noLiveBackend ? 1 : 0} ;;
  *login*) cat >/dev/null ;;
  "inspect alcantara-backend-previous") exit 1 ;;
  "run --rm"*print-metrics-token*) ${tokenFails ? 'exit 1' : 'echo fictional-scrape-token'} ;;
  *"State.Running"*) echo ${candidateHealthy ? 'true' : 'false'} ;;
  *"State.ExitCode"*) echo 3 ;;
  "exec alcantara-backend-candidate"*health/ready*) exit ${leaseImage === false ? 3 : 0} ;;
  "exec alcantara-backend-candidate"*) exit ${candidateHealthy ? 0 : 1} ;;
  *"Config.Env"*) echo "NODE_ENV=production"; echo "PORT=${livePort}" ;;
  "stop -t 15 alcantara-backend") ${stopFails ? 'exit 1' : `: > "${'$'}{PLAYOUT_DIR}/${livePort}"; ${activates ? `echo active > "${'$'}{PLAYOUT_DIR}/${livePort === '3006' ? '3007' : '3006'}"` : ':'}; ${slowStop ? `command -p sleep ${slowStop}; echo stop-finished >> "${calls}"` : ':'}`} ;;
  "start alcantara-backend") ${oldRestores ? `echo active > "${'$'}{PLAYOUT_DIR}/${livePort}"` : ':'} ;;
  "logs alcantara-backend-candidate") echo 'Error: fictional start-up failure' ;;
  "logs alcantara-backend")
    echo '[Nest] 1  - 11/27/2026, 8:15:53 AM     LOG [Bootstrap] PLAYOUT_SIGTERM 2026-11-27T08:15:53.320Z'
    echo '[Nest] 1  - 11/27/2026, 8:15:53 AM     LOG [PlayoutLease] PLAYOUT_STOPPING 2026-11-27T08:15:53.401Z'
    echo '[Nest] 1  - 11/27/2026, 8:15:54 AM     LOG [PlayoutLease] PLAYOUT_UNLOCKED 2026-11-27T08:15:54.650Z (1249 ms after the writers began stopping)' ;;
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
  if (fullDisk) require('node:fs').mkdirSync(`${site}.next`);
  const meminfo = join(bin, 'meminfo');
  if (memAvailableKb !== null) writeFileSync(meminfo, `MemTotal: 4000000 kB\nMemAvailable: ${memAvailableKb} kB\n`);
  const script = join(bin, 'cumulus.sh');
  writeFileSync(
    script,
    deployScript
      .replace('/etc/nginx/conf.d/cumulus-alcantara.conf', site)
      .replace(
        '/etc/letsencrypt/live/api.alcantara.gaulatti.com/fullchain.pem',
        certificateFile,
      )
      .replace('/proc/meminfo', meminfo),
  );
  // Each loopback port's /health/ready answer: the running backend's, and the new one's once it is started.
  const playout = join(bin, 'playout');
  require('node:fs').mkdirSync(playout);
  const otherPort = livePort === '3006' ? '3007' : '3006';
  writeFileSync(join(playout, livePort), liveState);
  writeFileSync(join(playout, otherPort), standbyReady ? standbyState : 'starting');
  stub(
    'curl',
    `case "$*" in
  *write-out*) printf ${publicStatus} ;;
  *health/ready*)
    port="$(printf '%s' "$*" | sed -n 's#.*127\\.0\\.0\\.1:\\([0-9]*\\)/health.*#\\1#p')"
    state="$(cat "${playout}/$port" 2>/dev/null)"
    [ -n "$state" ] || exit 22
    if [ "$state" = active ]; then printf '{"state":"%s","build":"fictional","grantedAt":"2026-11-27T08:15:54.700Z"}' "$state"
    else printf '{"state":"%s","build":"fictional","grantedAt":null}' "$state"; fi ;;
esac
exit 0`,
  );

  // The deploy writes the token to a temp file by redirection (no pipe, so no
  // SIGPIPE under pipefail). mktemp is the one command that must hand back a real,
  // writable path; install and mv are recorded.
  stub('mktemp', `command -p mktemp "${bin}/token.XXXXXX"`);
  for (const name of ['install', 'sleep', 'certbot'])
    stub(name, 'exit 0');
  stub('nginx', `case "$*" in -t) exit ${nginxValid ? 0 : 1} ;; esac\nexit 0`);
  stub(
    'systemctl',
    `case "$*" in
  "reload nginx") ${reloadFails ? 'exit 1' : `touch "${bin}/reloaded"; exit 0`} ;;
  "show --property MainPID --value nginx") echo '${nginxMaster}' ;;
esac
exit 0`,
  );
  // nginx's accepting workers: 101 before the reload; after it, 101 lingers for nginxWorkersLinger checks beside the
  // new 202, then only 202 accepts.
  const linger = Number.isFinite(nginxWorkersLinger) ? nginxWorkersLinger : 1_000_000;
  // A worker of an nginx inside a container (999) matches the same name and never stops: only the host master's
  // children (-P) may count.
  stub(
    'pgrep',
    `case "$*" in "-P 4242 "*) ;; *) echo 999 ;; esac
[ -f "${bin}/reloaded" ] || { echo 101; exit 0; }
n=$(( $(cat "${bin}/pgrep-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${bin}/pgrep-count"
if [ "$n" -le ${linger} ]; then printf '101\\n202\\n'; else echo 202; fi
exit 0`,
  );
  // mv restores the site when nginx refuses the switch: a real move inside the sandbox, recorded otherwise.
  stub('mv', `case "$*" in *"${bin}"*) command -p mv "$@" ;; esac\nexit 0`);
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLAYOUT_DIR: playout },
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
  const run = deployScript.indexOf('start_backend alcantara-backend 3006');

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
  const live = deployScript.indexOf('start_backend alcantara-backend 3006');
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
  // The site is neither rewritten nor reinstalled, and no certificate is asked for. nginx is only checked and
  // reloaded on the site as it is (#873: the port it already points at).
  for (const line of same.log) {
    assert.doesNotMatch(line, /^certbot |^install -m 0644/);
    if (line.startsWith('nginx ')) assert.equal(line, 'nginx -t');
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
  assert.match(live, /ghcr\.io\/example\/alcantara:fictional node dist\/src\/main$/);
  // Node as the first process ignores SIGTERM, so Docker's init stands in front of it.
  assert.match(live, / --init /);
  const scripts = JSON.parse(readFileSync('./package.json', 'utf8')).scripts;
  assert.equal(scripts['start:prod'], 'node dist/src/main', 'the deploy starts what start:prod starts');
});

test('a candidate that stayed up but did not answer says so instead of claiming an exit', () => {
  assert.match(deployScript, /did not answer its health check in time/);
});

// gaulatti/alcantara#873: an image that holds the playout lease starts beside the running backend, nginx moves to it,
// the old one stops, and the new one must take the lease. Before the old one stops, any failure leaves it serving.
const site3006 =
  'server {\n  location / {\n    proxy_pass http://127.0.0.1:3006;\n    proxy_read_timeout 24h;\n  }\n  ssl_certificate /etc/fictional;\n}\n';
// The repository's HTTP half, with a setting the installed site already has.
const repositoryHalf = 'server {\n  location / {\n    proxy_read_timeout 24h;\n  }\n}\n';

test('a lease image takes over beside the running backend: standby, nginx, stop, active, then the radio check', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const at = (prefix) => run.log.findIndex((line) => line.startsWith(prefix));
  const standby = at('docker run -d --name alcantara-backend-next');
  assert.ok(standby >= 0);
  assert.match(run.log[standby], /-p 127\.0\.0\.1:3007:3007 .*-e HTTP_PORT=3007 -e PORT=3007/);
  assert.match(run.log[standby], /node dist\/src\/main$/);
  const reload = run.log.indexOf('systemctl reload nginx');
  const stop = at('docker stop -t 15 alcantara-backend');
  const promote = run.log.indexOf('docker rename alcantara-backend-next alcantara-backend');
  assert.ok(standby < reload && reload < stop && stop < promote, run.log.join('\n'));
  // Fix forward: the stopped backend is removed, not kept as a rollback container that would stop later deploys.
  assert.equal(run.log.indexOf('docker rename alcantara-backend alcantara-backend-previous'), -1);
  assert.ok(run.log.lastIndexOf('docker rm -f alcantara-backend') > stop);
  // The installed site keeps its TLS half; only the port moved.
  const after = require('node:fs').readFileSync(run.site, 'utf8');
  assert.match(after, /proxy_pass http:\/\/127\.0\.0\.1:3007;/);
  assert.match(after, /ssl_certificate \/etc\/fictional;/);
  for (const marker of ['BACKEND_SWITCH', 'OWNER_RELEASED', 'OWNER_ACQUIRED', 'ALCANTARA_HEALTHY', 'RADIO_PLAYING'])
    assert.match(run.stdout, new RegExp(marker));
  // Today's path (stop first, then start in its place) is not taken.
  assert.equal(at('docker stop alcantara-backend'), -1);
  assert.equal(at('docker run -d --name alcantara-backend '), -1);
});

test('a backend on 3007 is followed by one on 3006', () => {
  const run = runDeploy({
    candidateHealthy: true,
    leaseImage: true,
    livePort: '3007',
    certificate: true,
    installedSite: site3006, repositorySite: repositoryHalf.replace('3006', '3007'),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.log.find((line) => line.startsWith('docker run -d --name alcantara-backend-next')), /-p 127\.0\.0\.1:3006:3006/);
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3006;/);
});

test('a standby that never reports ready is removed and the running backend is never stopped', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, standbyReady: false, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Alcantara standby did not report ready; the running backend is untouched/);
  assert.ok(run.log.includes('docker rm -f alcantara-backend-next'));
  for (const line of run.log) assert.doesNotMatch(line, /^docker (stop|rename|start) /);
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /127\.0\.0\.1:3006;/);
});

test('a switch nginx refuses puts the site back and leaves the running backend serving', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, nginxValid: false, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /nginx would not take the new port; the running backend is untouched/);
  assert.equal(require('node:fs').readFileSync(run.site, 'utf8'), site3006);
  for (const line of run.log) assert.doesNotMatch(line, /^docker (stop|rename|start) /);
});

test('a standby that never takes the lease is removed, nginx goes back, and the previous backend starts again', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, activates: false, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Alcantara standby did not take the playout lease; restoring the previous backend/);
  const removed = run.log.lastIndexOf('docker rm -f alcantara-backend-next');
  const restarted = run.log.indexOf('docker start alcantara-backend');
  assert.ok(removed >= 0 && restarted > removed);
  // The previous backend is confirmed back, the radio is still checked, and the deploy ends as failed.
  assert.match(run.stdout, /OWNER_RESTORED/);
  assert.match(run.stdout, /RADIO_PLAYING/);
  assert.match(run.stdout, /ALCANTARA_DEPLOY_FAILED: the new backend never took the playout lease/);
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3006;/);
  assert.equal(run.log.indexOf('docker rename alcantara-backend-next alcantara-backend'), -1);
});

// The closer of gaulatti/alcantara#873: an image from before the lease is no longer replaced the old way. It is
// refused before the running backend or nginx is touched (the expand-only migrations ran first, as for any candidate).
test('an image without the lease is refused, and nothing running is touched', () => {
  for (const noLiveBackend of [false, true]) {
    const run = runDeploy({ candidateHealthy: true, leaseImage: false, noLiveBackend, installedSite: site3006, repositorySite: repositoryHalf, certificate: true });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^ALCANTARA_DEPLOY_REFUSED: the image does not answer \/health\/ready, so it does not hold the playout lease; the running backend is untouched$/m);
    assert.ok(run.log.includes('docker rm -f alcantara-backend-candidate'));
    for (const line of run.log) {
      assert.doesNotMatch(line, /^docker (stop|rename|start) /);
      assert.doesNotMatch(line, /^docker run -d --name alcantara-backend(-next)? /);
      assert.doesNotMatch(line, /^systemctl reload nginx/);
    }
    assert.doesNotMatch(run.stdout, /HANDOVER_SKIPPED|BACKEND_SWITCH|ALCANTARA_HEALTHY/);
  }
});

// Review of the handover (Yakko, #873): each case below was a way to two engines, an empty nginx site, or a locked deploy.
test('a running backend from before the lease is replaced as before, never with a standby beside it', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, liveState: '', certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /HANDOVER_SKIPPED: the running backend does not hold the playout lease \(state: none\)/);
  assert.equal(run.log.findIndex((line) => line.startsWith('docker run -d --name alcantara-backend-next')), -1);
  assert.ok(run.log.includes('docker stop alcantara-backend'));
});

test('a standby that reports active while the running backend is up is removed at once', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, standbyState: 'active', certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Alcantara standby took the playout lease while the running backend was up; removing it/);
  assert.ok(run.log.includes('docker rm -f alcantara-backend-next'));
  for (const line of run.log) assert.doesNotMatch(line, /^docker (stop|rename|start) /);
});

test('today\'s path after a handover to 3007 serves on 3006 and points nginx back at it', () => {
  const run = runDeploy({
    candidateHealthy: true,
    livePort: '3007',
    certificate: true,
    installedSite: site3006.replace('3006', '3007'),
    repositorySite: repositoryHalf,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.log.find((line) => line.startsWith('docker run -d --name alcantara-backend ')), /-p 127\.0\.0\.1:3006:3006/);
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3006;/);
});

test('a full disk during the switch never empties the site, and a failed reload puts the previous site back', () => {
  for (const failure of [{ fullDisk: true }, { reloadFails: true }]) {
    const run = runDeploy({ candidateHealthy: true, leaseImage: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf, ...failure });
    assert.equal(run.status, 1, JSON.stringify(failure));
    assert.match(run.stdout, /nginx would not take the new port; the running backend is untouched/);
    assert.equal(require('node:fs').readFileSync(run.site, 'utf8'), site3006);
    assert.ok(run.log.includes('docker rm -f alcantara-backend-next'));
    for (const line of run.log) assert.doesNotMatch(line, /^docker (stop|rename|start) /);
  }
});

test('an exit between the switch and the lease puts the previous backend back', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, stopFails: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /BACKEND_SWITCH/);
  assert.match(run.stdout, /OWNER_RESTORED/);
  assert.ok(run.log.lastIndexOf('docker rm -f alcantara-backend-next') > run.log.indexOf('docker stop -t 15 alcantara-backend'));
  assert.ok(run.log.includes('docker start alcantara-backend'));
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3006;/);
});

test('a previous backend that does not come back says so loudly and stops the deploy', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, activates: false, oldRestores: false, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /OWNER_NOT_RESTORED: the previous backend did not take the playout lease back/);
  assert.doesNotMatch(run.stdout, /ALCANTARA_HEALTHY|RADIO_/);
});

test('a public check that fails after the takeover leaves no rollback container behind', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, publicStatus: '502', certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /OWNER_ACQUIRED/);
  assert.match(run.stdout, /left in place \(fix forward\)/);
  assert.equal(run.log.indexOf('docker rename alcantara-backend alcantara-backend-previous'), -1);
});

test('a host short of memory replaces the backend as before', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, memAvailableKb: 400 * 1024, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /HANDOVER_SKIPPED: 400 MB available, under 600 MB/);
  assert.equal(run.log.findIndex((line) => line.startsWith('docker run -d --name alcantara-backend-next')), -1);
  const roomy = runDeploy({ candidateHealthy: true, leaseImage: true, memAvailableKb: 1400 * 1024, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(roomy.status, 0, roomy.stdout + roomy.stderr);
  assert.match(roomy.stdout, /OWNER_ACQUIRED/);
});

test('today\'s path whose public check fails points nginx back at the previous backend\'s port', () => {
  const run = runDeploy({
    candidateHealthy: true,
    livePort: '3007',
    publicStatus: '502',
    certificate: true,
    installedSite: site3006.replace('3006', '3007'),
    repositorySite: repositoryHalf,
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Alcantara public health check failed; rolling back/);
  assert.ok(run.log.includes('docker start alcantara-backend'));
  assert.match(require('node:fs').readFileSync(run.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3007;/);
});

test('a handover that never activated and then fails the public check has nothing more to roll back', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, activates: false, publicStatus: '502', certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /OWNER_RESTORED/);
  assert.match(run.stdout, /The previous backend is back and serving; nothing more to roll back/);
  assert.doesNotMatch(run.stderr, /command not found/);
});

test('a handover container left running with no live backend stops the deploy for an operator', () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, leftoverNext: true, noLiveBackend: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /alcantara-backend-next\) is running with no alcantara-backend: requires operator review/);
  // The throwaway candidate may have run; nothing touches a live container.
  for (const line of run.log) assert.doesNotMatch(line, /^docker (run -d --name alcantara-backend(-next)? |stop|rename|start) /);
});

// The 503 at the second handover's switch (gaulatti/alcantara#873): `systemctl reload` returns before the old nginx
// workers stop accepting, and the previous backend answered a new request with 503 once it began closing.
test('the previous backend is stopped only after the nginx workers from before the reload stop accepting', () => {
  const run = runDeploy({
    candidateHealthy: true,
    leaseImage: true,
    certificate: true,
    installedSite: site3006,
    repositorySite: repositoryHalf,
    nginxWorkersLinger: 3,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const reload = run.log.indexOf('systemctl reload nginx');
  const stop = run.log.findIndex((line) => line.startsWith('docker stop -t 15 alcantara-backend'));
  const checks = run.log
    .map((line, index) => (line.startsWith('pgrep') ? index : -1))
    .filter((index) => index > reload);
  // Three checks still find the old worker accepting, the fourth does not; only then the stop.
  assert.equal(checks.length, 4, run.log.join('\n'));
  assert.ok(checks.every((index) => index < stop));
  assert.ok(run.log.slice(reload, stop).filter((line) => line === 'sleep 0.1').length === 3);
  assert.match(run.stdout, /^NGINX_SETTLED \S+$/m);
  assert.ok(run.stdout.indexOf('NGINX_SETTLED') < run.stdout.indexOf('OWNER_RELEASED'));
});

test('a worker that never stops accepting holds the stop for 2 s at most, and says so', () => {
  const run = runDeploy({
    candidateHealthy: true,
    leaseImage: true,
    certificate: true,
    installedSite: site3006,
    repositorySite: repositoryHalf,
    nginxWorkersLinger: Infinity,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^NGINX_SETTLE_TIMEOUT \S+: workers from before the reload still accept$/m);
  const reload = run.log.indexOf('systemctl reload nginx');
  const stop = run.log.findIndex((line) => line.startsWith('docker stop -t 15 alcantara-backend'));
  assert.equal(run.log.slice(reload, stop).filter((line) => line.startsWith('pgrep')).length, 20);
  assert.match(run.stdout, /OWNER_ACQUIRED/);
});

test("a handover prints both sides' own times: the previous backend's shutdown and the new one's grant", () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const lines = run.stdout.split('\n');
  const index = (marker) => lines.findIndex((line) => line.startsWith(marker));
  assert.equal(lines[index('OWNER_GRANTED')], 'OWNER_GRANTED 2026-11-27T08:15:54.700Z');
  assert.equal(lines[index('PREVIOUS_SIGTERM')], 'PREVIOUS_SIGTERM 2026-11-27T08:15:53.320Z');
  assert.equal(lines[index('PREVIOUS_STOPPING')], 'PREVIOUS_STOPPING 2026-11-27T08:15:53.401Z');
  assert.equal(lines[index('OWNER_UNLOCKED')], 'OWNER_UNLOCKED 2026-11-27T08:15:54.650Z');
  assert.ok(index('OWNER_ACQUIRED') < index('OWNER_GRANTED') && index('OWNER_GRANTED') < index('OWNER_UNLOCKED'));
  // Read before the previous backend is removed.
  const logs = run.log.indexOf('docker logs alcantara-backend');
  assert.ok(logs >= 0 && logs < run.log.lastIndexOf('docker rm -f alcantara-backend'));
});

// A straggler held the old backend's close for 15 s, and the poll, which only began after `docker stop` returned,
// reported the takeover 15 s late though the lease moved in 0.64 s (gaulatti/alcantara#873).
test('the takeover is seen while the old backend is still stopping, and its log is read once it has exited', () => {
  const run = runDeploy({
    candidateHealthy: true,
    leaseImage: true,
    certificate: true,
    installedSite: site3006,
    repositorySite: repositoryHalf,
    slowStop: 1,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const stop = run.log.findIndex((line) => line.startsWith('docker stop -t 15 alcantara-backend'));
  const finished = run.log.indexOf('stop-finished');
  const seen = run.log.findIndex((line, index) => index > stop && /^curl .*127\.0\.0\.1:3007\/health\/ready/.test(line));
  assert.ok(stop >= 0 && seen > stop && seen < finished, run.log.join('\n'));
  assert.ok(run.log.indexOf('docker logs alcantara-backend') > finished);
  assert.ok(run.log.indexOf('docker rename alcantara-backend-next alcantara-backend') > finished);
  assert.match(run.stdout, /^OWNER_ACQUIRED \d{4}-\d\d-\d\dT\S+Z$/m);
});

// 5d0c1249's handover: the settle ran out after 6.7 s, with requests waiting on the standby meanwhile, because the
// check counted every process named like an nginx worker on the host, a container's among them (gaulatti/alcantara#873).
test("counts only the host nginx master's own workers, and settles for a fixed second when the master is unknown", () => {
  const run = runDeploy({ candidateHealthy: true, leaseImage: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const checks = run.log.filter((line) => line.startsWith('pgrep'));
  assert.ok(checks.length >= 2);
  assert.ok(checks.every((line) => line === "pgrep -P 4242 -f ^nginx: worker process$"), checks.join('\n'));
  assert.match(run.stdout, /^NGINX_SETTLED \S+$/m);

  for (const nginxMaster of ['', '0']) {
    const unknown = runDeploy({ candidateHealthy: true, leaseImage: true, certificate: true, installedSite: site3006, repositorySite: repositoryHalf, nginxMaster });
    assert.equal(unknown.status, 0, unknown.stdout + unknown.stderr);
    assert.equal(unknown.log.filter((line) => line.startsWith('pgrep')).length, 0);
    assert.match(unknown.stdout, /^NGINX_SETTLED \S+ fixed$/m);
    const reload = unknown.log.indexOf('systemctl reload nginx');
    const stop = unknown.log.findIndex((line) => line.startsWith('docker stop -t 15 alcantara-backend'));
    assert.ok(unknown.log.slice(reload, stop).includes('sleep 1'));
  }
});
