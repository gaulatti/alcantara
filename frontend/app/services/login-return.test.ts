import assert from 'node:assert/strict';
import test from 'node:test';

import { loginPathForLocation } from './login-return';

test('builds a same-app login redirect that preserves the complete return location', () => {
  assert.equal(
    loginPathForLocation('/program/42', '?panel=scenes', '#mixer'),
    '/login?returnTo=%2Fprogram%2F42%3Fpanel%3Dscenes%23mixer',
  );
});

test('builds the root login redirect without browser side effects', () => {
  assert.equal(loginPathForLocation('/', '', ''), '/login?returnTo=%2F');
});
