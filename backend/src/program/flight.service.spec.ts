import { FlightService } from './flight.service';

describe('FlightService song cues', () => {
  it('takes the catalog song on air after persisting the manual cue sequence', async () => {
    const song = {
      id: 101,
      audioUrl: 'https://example.test/song.mp3',
      title: 'Fictional song',
      artist: 'Fictional artist',
      coverUrl: 'https://example.test/cover.jpg',
      durationMs: 180_000,
    };
    const prisma = {
      song: { findUnique: jest.fn().mockResolvedValue(song) },
    };
    const programService = {
      updateProgramAudioBus: jest.fn().mockResolvedValue(undefined),
      takeCatalogSongOnAir: jest.fn(),
    };
    const service = new FlightService(prisma as any, programService as any);

    await (service as any).executePlaySongCue('radio-1', {
      id: 'cue-1',
      kind: 'playSong',
      songId: 101,
    });

    expect(programService.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        songSequence: expect.objectContaining({
          mode: 'manual',
          activeItemId: expect.any(String),
          items: [expect.objectContaining({ songId: 101 })],
        }),
      },
      'radio-1',
    );
    expect(programService.takeCatalogSongOnAir).toHaveBeenCalledWith(
      'radio-1',
      song,
    );
    expect(
      programService.updateProgramAudioBus.mock.invocationCallOrder[0],
    ).toBeLessThan(
      programService.takeCatalogSongOnAir.mock.invocationCallOrder[0],
    );
  });
});
