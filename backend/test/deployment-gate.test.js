const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('../.github/workflows/backend-deploy.yml', 'utf8');
const deployScript = readFileSync('../deploy/cumulus.sh', 'utf8');
const nginx = readFileSync('../deploy/cumulus.nginx.conf', 'utf8');

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
  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}:\$\{\{ github\.sha \}\}/);
});

test('fails closed until Arauco contains restored Alcantara production data', () => {
  assert.match(deployScript, /ProgramState is absent/);
  assert.match(deployScript, /ProgramState is empty/);
  assert.match(deployScript, /pnpm run db:migrate:deploy/);
  assert.ok(
    deployScript.indexOf('ProgramState is absent') <
      deployScript.indexOf('pnpm run db:migrate:deploy'),
  );
});

test('keeps the backend private to nginx and preserves realtime proxy behavior', () => {
  assert.match(deployScript, /127\.0\.0\.1:3006:3006/);
  assert.match(nginx, /proxy_buffering off/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(nginx, /proxy_read_timeout 24h/);
});
