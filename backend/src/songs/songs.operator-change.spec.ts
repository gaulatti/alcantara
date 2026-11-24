import {
  mcpActor,
  noRecorder,
} from '../operator-change/operator-change-recorder.testing';
import { SongsService } from './songs.service';

// gaulatti/alcantara#236 slice 3: a song change is recorded with no program, its chart fields named by their
// generic names whichever name the caller used, and the enabled flag before and after.

function setup() {
  const row = {
    id: 9,
    artist: 'Fictional artist',
    title: 'Fictional title',
    audioUrl: 'https://media.example.test/song.mp3',
    enabled: true,
    durationMs: null,
    earoneSongId: null,
    earoneRank: null,
    earoneSpins: null,
    intro: null,
  };
  const tx = {
    song: {
      update: jest.fn(async () => ({ ...row, enabled: false })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row, enabled: false })),
    },
    mediaAsset: { upsert: jest.fn(async () => ({ id: 'asset-9' })) },
  };
  const prisma = {
    song: { findUnique: jest.fn(async () => row) },
    $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
  };
  const recorder = noRecorder();
  recorder.actor.mockReturnValue(mcpActor);
  return {
    service: new SongsService(prisma as never, recorder),
    recorder,
  };
}

jest.mock('../media-assets/media-asset-sync', () => ({
  ...jest.requireActual('../media-assets/media-asset-sync'),
  syncSongAsset: jest.fn(async () => 'asset-9'),
}));

describe('SongsService operator change records', () => {
  it('names a legacy chart field by its generic name, and keeps the enabled flag before and after', async () => {
    const { service, recorder } = setup();
    await service.update(9, { earoneRank: 3, enabled: false });
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: mcpActor,
        target: 'song',
        targetId: '9',
        programId: null,
        capability: { mcp: 'song_update', console: 'songs.update' },
        summary: {
          changed: ['externalChartRank', 'enabled'],
          before: { enabled: true },
          after: { enabled: false },
        },
      }),
    );
  });

  it('keeps the generic name when the caller used it', async () => {
    const { service, recorder } = setup();
    await service.update(9, { externalChartSpins: 12 });
    expect(recorder.record.mock.calls[0][0].summary.changed).toEqual([
      'externalChartSpins',
    ]);
  });
});
