// gaulatti/alcantara#600: on Colima a host edit reaches the Compose backend through its bind mount without a
// file event, so TypeScript's watcher (nest start --watch) polls there. Polling is a local-development
// setting only; the production image, the deploy script and the deploy workflow never
// carry it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('the Compose backend polls for source changes', () => {
  const compose = read('compose.yml');
  const backend = compose.slice(compose.indexOf('\n  backend:\n'), compose.indexOf('\n    volumes:\n', compose.indexOf('\n  backend:\n')));
  assert.match(backend, /\n {6}TSC_WATCHFILE: DynamicPriorityPolling\n/);
  assert.match(backend, /\n {6}TSC_WATCHDIRECTORY: RecursiveDirectoryUsingDynamicPriorityPolling\n/);
});

test('nothing on the production path sets the watcher to poll', () => {
  for (const file of ['backend/Dockerfile', 'deploy/cumulus.sh', '.github/workflows/backend-deploy.yml'])
    assert.doesNotMatch(read(file), /TSC_WATCH(FILE|DIRECTORY)/, file);
});
