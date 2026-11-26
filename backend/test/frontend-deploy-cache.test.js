// The frontend deploy's cache contract. It reads a repository-level workflow, so it runs with the other
// deployment tests rather than in the frontend suite, which runs inside the frontend image without the
// repository root (gaulatti/alcantara#200).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/frontend-deploy.yml'), 'utf8');

test('the frontend deploy keeps hashed assets immutable but forces the SPA shell to revalidate', () => {
  assert.ok(workflow.includes('--cache-control "public,max-age=31536000,immutable"'));
  assert.ok(workflow.includes('--cache-control "no-cache,no-store,must-revalidate"'));
});

test('the frontend deploy invalidates every cached SPA route', () => {
  assert.ok(workflow.includes('--paths "/*"'));
  assert.ok(!workflow.includes('--paths "/index.html"'));
});
