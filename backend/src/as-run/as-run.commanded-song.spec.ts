import { AsRunService } from './as-run.service';

// Two songs can share one audio address. The engine knows which one it commanded for a playback, so the
// as-run log asks it first and looks the address up only when the engine has no record.
const url = 'https://media.example.test/shared.ogg';
const songs = [
  { id: 9101, assetId: 'song:9101' },
  { id: 9102, assetId: 'song:9102' },
];

function build(commanded: number | null, deleted: number[] = []) {
  const prisma = {
    song: {
      findUnique: jest.fn(async ({ where }: { where: { id: number } }) =>
        deleted.includes(where.id)
          ? null
          : (songs.find((song) => song.id === where.id) ?? null),
      ),
      // The address lookup finds the first song that has it.
      findFirst: jest.fn(async () => songs[0]),
    },
    mediaAsset: { findFirst: jest.fn(async () => null) },
  };
  const engine = { songIdForPlayback: jest.fn(() => commanded) };
  const service = new AsRunService(prisma as never, engine as never);
  const resolve = (playbackRequestId: string | null) =>
    service.resolveSongAndAsset({
      programId: 'radio-demo',
      playbackRequestId,
      url,
    } as never);
  return { prisma, engine, resolve };
}

describe('as-run attribution of a shared audio address', () => {
  it('records the song the engine commanded, not the first with the address', async () => {
    const { engine, prisma, resolve } = build(9102);
    await expect(resolve('play-1')).resolves.toEqual({
      songId: 9102,
      assetId: 'song:9102',
    });
    expect(engine.songIdForPlayback).toHaveBeenCalledWith(
      'radio-demo',
      'play-1',
    );
    expect(prisma.song.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['the engine has no record of the playback', null, [], 'play-1'],
    ['the commanded song no longer exists', 9102, [9102], 'play-1'],
    ['the event names no playback', 9102, [], null],
  ])(
    'looks the address up when %s',
    async (_why, commanded, gone, playback) => {
      const { resolve } = build(commanded, gone);
      await expect(resolve(playback)).resolves.toEqual({
        songId: 9101,
        assetId: 'song:9101',
      });
    },
  );
});
