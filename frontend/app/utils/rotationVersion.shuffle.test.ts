import { expect, it } from 'vitest';
import { createRotationVersion } from './rotationVersion';

// gaulatti/alcantara#834: the console learns from the load whether the backend plays a shuffle order of its own.
it('is told by a load, keeps it through answers that do not say, and forgets it with the rotation', () => {
  const version = createRotationVersion();
  expect(version.shuffleKeepsRows()).toBe(false);
  version.read({ songSequence: {}, shuffleKeepsRows: true });
  version.read({ songSequence: {}, sequenceVersion: 'v2' });
  expect(version.shuffleKeepsRows()).toBe(true);
  version.forget();
  expect(version.shuffleKeepsRows()).toBe(false);
  version.read({ songSequence: {} });
  expect(version.shuffleKeepsRows()).toBe(false);
});
