// gaulatti/alcantara#741: the frontend's images and its deploy install from the workspace lockfile, pnpm-lock.yaml,
// with --frozen-lockfile, as the backend does (#581, #590). frontend/package-lock.json (npm) is gone, so no image or
// workflow can read it. These tests guard the file contents; the image builds are verified separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const dev = read('frontend/Dockerfile.dev');
const prod = read('frontend/Dockerfile');
const devIgnore = read('frontend/Dockerfile.dev.dockerignore').split('\n').map((line) => line.trim());
const prodIgnore = read('frontend/Dockerfile.dockerignore').split('\n').map((line) => line.trim());
const compose = read('compose.yml');
const deploy = read('.github/workflows/frontend-deploy.yml');
const readme = read('frontend/README.md');

const installs = (dockerfile) => dockerfile.match(/^RUN pnpm install\b.*$/gm) ?? [];
const WORKSPACE_COPY = [
  'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
  'COPY frontend/package.json frontend/',
  'COPY backend/package.json backend/',
  'COPY infra/aws/package.json infra/aws/',
  'COPY e2e/package.json e2e/',
];

test('the npm lockfile is gone, so no image or workflow can read or regenerate it', () => {
  assert.equal(existsSync(resolve(root, 'frontend/package-lock.json')), false);
});

test('the development image installs with the frozen workspace lockfile, never npm', () => {
  // The only npm command allowed is the global install of pnpm itself (as in backend/Dockerfile.dev).
  const npmRuns = dev.match(/^RUN npm\b.*$/gm) ?? [];
  assert.deepEqual(npmRuns, ['RUN npm install -g pnpm@9']);
  assert.deepEqual(installs(dev), ['RUN pnpm install --frozen-lockfile --ignore-scripts --filter frontend']);
  assert.doesNotMatch(dev, /--no-frozen-lockfile|package-lock/);
  const install = dev.indexOf('RUN pnpm install');
  for (const copy of WORKSPACE_COPY) assert.ok(dev.indexOf(copy) >= 0 && dev.indexOf(copy) < install, copy);
});

test('the production image installs with the frozen workspace lockfile, never npm', () => {
  for (const line of prod.match(/^RUN .*$/gm) ?? []) {
    assert.doesNotMatch(line, /\bnpm (ci|install)\b(?! -g pnpm@)/, line);
  }
  for (const line of installs(prod)) assert.match(line, /--frozen-lockfile/, line);
  assert.doesNotMatch(prod, /--no-frozen-lockfile|package-lock/);
  assert.ok(installs(prod).length >= 2, 'the dependencies stage and the build stage each install');
  const install = prod.indexOf('RUN pnpm install');
  for (const copy of WORKSPACE_COPY) assert.ok(prod.indexOf(copy) >= 0 && prod.indexOf(copy) < install, copy);
});

test('the image build contexts keep the lockfile and leave local dependencies, secrets and build output out', () => {
  for (const [name, ignore] of [['development', devIgnore], ['production', prodIgnore]]) {
    for (const kept of ['!package.json', '!pnpm-lock.yaml', '!pnpm-workspace.yaml', '!frontend/']) assert.ok(ignore.includes(kept), `${name} ${kept}`);
    for (const left of ['*', 'frontend/node_modules', 'frontend/build', 'frontend/.env']) assert.ok(ignore.includes(left), `${name} ${left}`);
  }
});

test('the development image is built from the repository root, where the lockfile is', () => {
  const builds = [...compose.matchAll(/build:\n\s+context: (\S+)\n\s+dockerfile: (\S+)/g)].filter(
    (match) => match[2] === 'frontend/Dockerfile.dev',
  );
  assert.equal(builds.length, 1);
  assert.deepEqual([builds[0][1], builds[0][2]], ['.', 'frontend/Dockerfile.dev']);
  assert.doesNotMatch(compose, /context: \.\/frontend\b/);
});

test('the Compose frontend runs pnpm and rebuilds on the workspace lockfile', () => {
  assert.match(compose, /command: sh -c "pnpm run dev"/);
  assert.doesNotMatch(compose, /\bnpm run dev/);
  assert.match(compose, /path: \.\/pnpm-lock\.yaml/);
});

test('the frontend deploy installs from the workspace lockfile, never npm', () => {
  assert.doesNotMatch(deploy, /\bnpm (ci|install|run|test)\b/);
  assert.doesNotMatch(deploy, /package-lock/);
  assert.match(deploy, /pnpm install --frozen-lockfile --filter frontend/);
  assert.match(deploy, /pnpm run build/);
});

test('the frontend README documents the workspace install, not npm', () => {
  assert.doesNotMatch(readme, /\bnpm (install|run)\b/);
  assert.match(readme, /pnpm install --frozen-lockfile/);
});

// gaulatti/alcantara#741 follow-up: the production image starts the static client build. The app is built with
// ssr: false, so the build writes build/client and no server bundle. The start command must serve exactly that.
const frontendPackage = JSON.parse(read('frontend/package.json'));
const serveSource = read('frontend/serve.mjs');
const routerConfig = read('frontend/react-router.config.ts');

test('the production start command serves the client build that the build writes', () => {
  assert.match(routerConfig, /ssr:\s*false/, 'the build writes only build/client when ssr is off');
  assert.equal(frontendPackage.scripts.start, 'node serve.mjs');
  assert.ok(existsSync(resolve(root, 'frontend/serve.mjs')), 'the start target exists in the repository');
  const served = serveSource.match(/resolve\('([^']+)'\)/);
  assert.deepEqual(served && [served[1]], ['build/client'], 'the server serves the directory the build writes');
  assert.doesNotMatch(prod, /react-router-serve|build\/server\//, 'no server bundle is expected');
});

test('the production image runs the start command and carries the file it names', () => {
  assert.match(prod, /^CMD \["npm", "run", "start"\]$/m);
  assert.match(prod, /COPY frontend\/package\.json frontend\/serve\.mjs \.\//);
  assert.match(prod, /COPY --from=build-env \/app\/frontend\/build \/app\/frontend\/build/);
});
