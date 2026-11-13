import { normalizeProgramSongQueue } from './song-queue.utils';

describe('persisted song queue malformed-entry boundaries', () => {
  const entry = { id: 'queue', itemId: 'song', enqueuedAt: 1 };
  it.each([null, [], false, 'entry', 4].map((value) => [value]))(
    'discards a non-record entry %j without losing a valid following entry',
    (value) => {
      expect(normalizeProgramSongQueue([value, entry])).toEqual([entry]);
    },
  );
  it.each([
    { id: 4 },
    { id: ' ' },
    { itemId: 4 },
    { itemId: ' ' },
    { enqueuedAt: '1' },
    { enqueuedAt: NaN },
    { enqueuedAt: Infinity },
    { enqueuedAt: 0 },
    { enqueuedAt: 0.1 },
  ])(
    'does not restore an incomplete or untimeable queue record %j',
    (override) => {
      expect(normalizeProgramSongQueue([{ ...entry, ...override }])).toEqual(
        [],
      );
    },
  );
  it('retains one canonical entry per queue identity and trims persisted identifiers', () => {
    expect(
      normalizeProgramSongQueue([
        { ...entry, id: ' queue ', itemId: ' song ', enqueuedAt: 1.4 },
        entry,
      ]),
    ).toEqual([entry]);
  });
});
