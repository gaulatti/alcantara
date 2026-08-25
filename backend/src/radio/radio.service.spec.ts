import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';

describe('RadioService settings', () => {
  it('persists every bumper field exposed by the radio console', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: {
        upsert: jest.fn().mockImplementation(({ update }) => update),
      },
    } as any;
    const service = new RadioService(prisma, {} as any);

    const result = await service.updateRadioSettings('palazzo', {
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4, 8],
      bumperMode: 'random',
    });

    expect(result).toMatchObject({
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4],
      bumperMode: 'random',
    });
  });

  it('routes every radio operation through the shared machine client', async () => {
    const prisma = {
      programState: {
        findUnique: jest.fn().mockResolvedValue({
          radioSettings: { palazzoUrl: 'http://palazzo:3100' },
        }),
      },
    } as any;
    const palazzo = {
      playSong: jest.fn().mockResolvedValue({ playbackRequestId: 'song-1' }),
      stopSong: jest.fn().mockResolvedValue(undefined),
      playInstant: jest
        .fn()
        .mockResolvedValue({ playbackRequestId: 'instant-1' }),
      stopInstants: jest.fn().mockResolvedValue(undefined),
      updateMixer: jest.fn().mockResolvedValue({}),
      getPlaybackState: jest.fn().mockResolvedValue({
        liquidsoap: { running: true, connected: true },
        icecast: { connected: true },
      }),
    } as any;
    const service = new RadioService(prisma, palazzo);

    await expect(
      service.playSong(
        'radio-1',
        'https://media.example/song.mp3',
        'Song',
        'Artist',
        'song-1',
      ),
    ).resolves.toMatchObject({ ok: true, playbackRequestId: 'song-1' });
    await service.stopSong('radio-1');
    await service.playInstant(
      'radio-1',
      'https://media.example/instant.mp3',
      0.5,
      'instant-1',
    );
    await service.stopAllInstants('radio-1');
    await service.updateMixer('radio-1', {
      mainVolume: 1,
      songVolume: 0.8,
      instantVolume: 0.7,
      songMuted: false,
      instantMuted: false,
    });
    await expect(service.getPalazzoStatus('radio-1')).resolves.toEqual({
      running: true,
      uptime: null,
    });

    expect(palazzo.playSong).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
      expect.objectContaining({ playbackId: 'song-1' }),
    );
    expect(palazzo.stopSong).toHaveBeenCalled();
    expect(palazzo.playInstant).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
      expect.objectContaining({ playbackId: 'instant-1' }),
    );
    expect(palazzo.stopInstants).toHaveBeenCalled();
    expect(palazzo.updateMixer).toHaveBeenCalled();
    expect(palazzo.getPlaybackState).toHaveBeenCalled();
  });

  it('rejects an invalid bumper interval', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: { upsert: jest.fn() },
    } as any;
    const service = new RadioService(prisma, {} as any);
    await expect(
      service.updateRadioSettings('palazzo', { bumperInterval: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
