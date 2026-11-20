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
  assert.match(workflow, /build:\n    needs: production-config-preflight/);
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
function runDeploy({ candidateHealthy, tokenFails = false }) {
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
  "exec alcantara-backend-candidate"*) exit ${candidateHealthy ? 0 : 1} ;;
  "logs alcantara-backend-candidate") echo 'Error: fictional start-up failure' ;;
esac
exit 0`,
  );
  stub('curl', 'case "$*" in *write-out*) printf 200 ;; esac\nexit 0');
  for (const name of [
    'sleep',
    'install',
    'mv',
    'nginx',
    'systemctl',
    'certbot',
  ])
    stub(name, 'exit 0');
  const result = spawnSync(
    'bash',
    [
      '../deploy/cumulus.sh',
      'fictional-user',
      Buffer.from('fictional-registry-token').toString('base64'),
      'fictional/broadcast',
      'fictional/database',
      'ghcr.io/example/alcantara:fictional',
      Buffer.from('# nginx').toString('base64'),
      'fictional-bucket',
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
  const log = read(calls, 'utf8').split('\n').filter(Boolean);
  return { ...result, log };
}

test('a candidate that fails its health check leaves the running backend untouched', () => {
  const { status, stdout, stderr, log } = runDeploy({
    candidateHealthy: false,
  });
  assert.equal(status, 1);
  assert.match(
    stdout,
    /Alcantara candidate failed its health check; the running backend is untouched/,
  );
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
    /\| install -m 0400 -o root -g root \/dev\/stdin "\$metrics_token_file\.new"/,
  );
  assert.doesNotMatch(deployScript, /node scripts\/print-metrics-token\.mjs >/);
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
