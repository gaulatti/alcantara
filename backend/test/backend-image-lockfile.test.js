// gaulatti/alcantara#581: the production image installs the workspace lockfile's versions, so it runs what
// CI tested. A floating install put prisma 7.10.1 in production while the lockfile pinned 7.5.0.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const dockerfile = read('backend/Dockerfile');
const ignore = read('backend/Dockerfile.dockerignore').split('\n').map((line) => line.trim());
const deploy = read('.github/workflows/backend-deploy.yml');

test('the production image installs with the frozen lockfile, never a floating install', () => {
  const installs = dockerfile.match(/^RUN pnpm install\b.*$/gm) ?? [];
  assert.deepEqual(installs, ['RUN pnpm install --frozen-lockfile --filter backend']);
  assert.doesNotMatch(dockerfile, /--no-frozen-lockfile/);
});

test('the image copies the workspace lockfile and manifests before installing', () => {
  const install = dockerfile.indexOf('RUN pnpm install');
  const lockfile = dockerfile.indexOf('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./');
  assert.ok(lockfile >= 0 && lockfile < install);
  for (const manifest of ['backend/package.json', 'frontend/package.json', 'infra/aws/package.json'])
    assert.ok(dockerfile.indexOf(`COPY ${manifest} `) >= 0 && dockerfile.indexOf(`COPY ${manifest} `) < install, manifest);
});

test('the build context keeps the lockfile and leaves local secrets and installs out', () => {
  for (const kept of ['!package.json', '!pnpm-lock.yaml', '!pnpm-workspace.yaml', '!backend/']) assert.ok(ignore.includes(kept), kept);
  for (const left of ['*', 'backend/.env', 'backend/node_modules']) assert.ok(ignore.includes(left), left);
});

test('the deploy builds the backend image from the repository root, where the lockfile is', () => {
  assert.match(deploy, /-f backend\/Dockerfile \\\n(?:\s+-t [^\n]+\\\n)+\s+\.\n/);
});

// gaulatti/alcantara#590: the development image (Compose) installs the same lockfile, so local runs use the
// versions CI and production use.
const devDockerfile = read('backend/Dockerfile.dev');
const devIgnore = read('backend/Dockerfile.dev.dockerignore').split('\n').map((line) => line.trim());

test('the development image installs with the frozen lockfile, never a floating install', () => {
  const installs = devDockerfile.match(/^RUN pnpm install\b.*$/gm) ?? [];
  assert.deepEqual(installs, ['RUN pnpm install --frozen-lockfile --ignore-scripts --filter backend']);
  assert.doesNotMatch(devDockerfile, /--no-frozen-lockfile/);
  const install = devDockerfile.indexOf('RUN pnpm install');
  for (const copy of ['COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./', 'COPY backend/package.json backend/', 'COPY frontend/package.json frontend/', 'COPY infra/aws/package.json infra/aws/'])
    assert.ok(devDockerfile.indexOf(copy) >= 0 && devDockerfile.indexOf(copy) < install, copy);
});

test('the development build context keeps the lockfile and leaves local secrets and installs out', () => {
  for (const kept of ['!package.json', '!pnpm-lock.yaml', '!pnpm-workspace.yaml', '!backend/']) assert.ok(devIgnore.includes(kept), kept);
  for (const left of ['*', 'backend/.env', 'backend/node_modules']) assert.ok(devIgnore.includes(left), left);
});

test('every Compose build of the development image uses the repository root', () => {
  // compose.yml builds it for backend and alana-recording-fixture; the access fake builds it once.
  for (const [file, expected] of [['compose.yml', 2], ['scripts/access-fake/compose.yml', 1]]) {
    const compose = read(file);
    const builds = [...compose.matchAll(/context: (\S+)\n\s+dockerfile: (\S+)/g)].filter(
      (match) => match[2] === 'backend/Dockerfile.dev' || match[1] === './backend',
    );
    assert.equal(builds.length, expected, file);
    for (const [, context, dockerfile] of builds) assert.deepEqual([context, dockerfile], ['.', 'backend/Dockerfile.dev'], file);
    assert.doesNotMatch(compose, /context: \.\/backend\b/, file);
  }
});
