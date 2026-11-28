import { describe, expect, it } from 'vitest';
import { normalizeProgramSongSequence } from '@modoitaliano/giorgia/scenes';

const song = (overrides: Record<string, unknown> = {}) => ({
  title: 'Fictional song',
  artist: 'Fictional artist',
  audioUrl: 'https://media.example.test/song.mp3',
  durationMs: 120000,
  ...overrides,
});

const idsOf = (items: unknown[]) =>
  (normalizeProgramSongSequence({ mode: 'manual', items }) ?? { items: [] }).items.map((item) => item.id);

describe('song ids in a sequence', () => {
  it('keeps the first occurrence of a song without a string id on its content-derived id', () => {
    const alone = idsOf([song()]);
    const twice = idsOf([song(), song()]);
    expect(twice[0]).toBe(alone[0]);
  });

  it('gives a repeat of the same id-less song its own id', () => {
    const [first, repeat, third] = idsOf([song(), song(), song()]);
    expect(new Set([first, repeat, third]).size).toBe(3);
    expect(repeat).toBe(`${first}_2`);
    expect(third).toBe(`${first}_3`);
  });

  it('leaves songs with a string id exactly as they are, repeats included', () => {
    expect(idsOf([song({ id: 'song-1' }), song({ id: 'song-1' })])).toEqual(['song-1', 'song-1']);
  });

  it('keeps the ids stable when the same sequence is normalised again', () => {
    const items = [song(), song()];
    expect(idsOf(items)).toEqual(idsOf(items));
  });
});
