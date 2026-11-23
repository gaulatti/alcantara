// gaulatti/alcantara#200: one Node version everywhere. `.nvmrc` states it; every Dockerfile and the
// CI and deploy workflows must match, so a test cannot pass locally on one Node and fail on another.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const pinned = read('.nvmrc').trim();

test('the pinned Node version is a full major.minor.patch version', () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

for (const file of ['frontend/Dockerfile', 'frontend/Dockerfile.dev', 'backend/Dockerfile', 'backend/Dockerfile.dev']) {
  test(`every Node image stage in ${file} is the pinned version`, () => {
    const images = [...read(file).matchAll(/^FROM\s+node:(\S+)/gim)].map((match) => match[1]);
    assert.ok(images.length > 0);
    for (const image of images) assert.equal(image, `${pinned}-alpine`);
  });
}

for (const file of [
  '.github/workflows/ci.yml',
  '.github/workflows/frontend-deploy.yml',
  '.github/workflows/backend-deploy.yml',
]) {
  test(`every node-version in ${file} is the pinned version`, () => {
    const versions = [...read(file).matchAll(/node-version:\s*["']?([\d.]+)["']?/g)].map((match) => match[1]);
    assert.ok(versions.length > 0);
    for (const version of versions) assert.equal(version, pinned);
  });
}
