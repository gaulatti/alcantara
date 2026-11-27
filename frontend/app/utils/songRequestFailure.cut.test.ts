import { expect, it } from 'vitest';
import { playoutCutNotice } from './songRequestFailure';

// A Palazzo restart cut a song and the desk said nothing.
it('says where a playout restart cut the song', () => {
  expect(playoutCutNotice({ type: 'playout_restart_cut', title: 'Ancora tu', cutAtMs: 214_300 })).toBe(
    'Playout restarted: song cut at 3:34. “Ancora tu” was not resumed.',
  );
  expect(playoutCutNotice({ type: 'playout_restart_cut', title: ' ', cutAtMs: 5_000 })).toBe('Playout restarted: song cut at 0:05. “A song” was not resumed.');
  for (const other of [null, {}, { type: 'song_request_failed' }, { type: 'playout_restart_cut', cutAtMs: 'x' }]) expect(playoutCutNotice(other)).toBeNull();
});
