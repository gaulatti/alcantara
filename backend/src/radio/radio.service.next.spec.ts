/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
import { RadioService } from './radio.service';
import { PalazzoMachineError } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';

// RadioService side of the next-song announcement (gaulatti/palazzo#40).

const ANALYSIS = {
  status: 'success',
  cueInSeconds: 0.5,
  cueOutSeconds: 199,
  fadeInSeconds: 0.1,
  fadeOutSeconds: 1.5,
  overlapSeconds: 2,
  integratedLufs: -14,
  truePeakDbtp: -1,
};

function build(settings: Record<string, unknown> | null) {
  const prisma: any = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 10, radioSettings: settings }),
    },
    song: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ assetId: 'asset-1', durationMs: 200_000 }]),
      findUnique: jest.fn(),
    },
    mediaAssetAnalysis: { findUnique: jest.fn().mockResolvedValue(ANALYSIS) },
  };
  const palazzo: any = {
    playSong: jest.fn().mockResolvedValue({ playbackRequestId: 'song-1' }),
    announceNext: jest
      .fn()
      .mockResolvedValue({ result: 'accepted', duplicate: false }),
    withdrawNext: jest.fn().mockResolvedValue({ withdrawn: true }),
  };
  const metrics = new RadioMetricsService();
  const service = new RadioService(
    prisma,
    palazzo,
    { get: jest.fn() } as any,
    metrics,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation();
  return { service, prisma, palazzo, metrics };
}

const SONG = {
  playbackId: 'next-1',
  url: 'https://media.example/next.mp3',
  title: 'Harbor Light',
  artist: 'The Lighthouse Keepers',
  coverUrl: 'https://media.example/next.jpg',
};

describe('RadioService.announceNext', () => {
  it('carries the segue and loudness the song command would carry, with segue on', async () => {
    const { service, palazzo } = build({
      palazzoUrl: 'http://palazzo:3100',
      segueMode: 'on',
    });

    await expect(service.announceNext('radio-1', SONG)).resolves.toBe(
      'accepted',
    );
    // The song command the engine would otherwise send for the same song.
    await service.playSong(
      'radio-1',
      SONG.url,
      SONG.title,
      SONG.artist,
      SONG.playbackId,
      SONG.coverUrl,
      undefined,
    );

    const announced = palazzo.announceNext.mock.calls[0][2];
    const commanded = palazzo.playSong.mock.calls[0][2];
    expect(palazzo.announceNext.mock.calls[0].slice(0, 2)).toEqual([
      'http://palazzo:3100',
      'radio-1',
    ]);
    expect(announced).toEqual({
      playbackId: commanded.playbackId,
      url: commanded.url,
      title: commanded.title,
      artist: commanded.artist,
      coverUrl: commanded.coverUrl,
      segue: commanded.segue,
      loudness: commanded.loudness,
    });
    expect(announced.segue).toEqual({
      cueInSeconds: 0.5,
      cueOutSeconds: 199,
      fadeInSeconds: 0.1,
      fadeOutSeconds: 1.5,
      overlapSeconds: 2,
    });
  });

  it('carries neither segue nor loudness with segue off', async () => {
    const { service, palazzo, prisma } = build({
      palazzoUrl: 'http://palazzo:3100',
      segueMode: 'off',
    });
    await service.announceNext('radio-1', SONG);
    expect(palazzo.announceNext.mock.calls[0][2]).toEqual(SONG);
    expect(prisma.mediaAssetAnalysis.findUnique).not.toHaveBeenCalled();
  });

  it.each(['not_ready', 'rejected', 'unsupported'] as const)(
    'returns and counts %s',
    async (result) => {
      const { service, palazzo, metrics } = build({
        palazzoUrl: 'http://palazzo:3100',
        segueMode: 'off',
      });
      palazzo.announceNext.mockResolvedValue({ result });
      await expect(service.announceNext('radio-1', SONG)).resolves.toBe(result);
      expect(metrics.snapshot().nextAnnouncements).toEqual({ [result]: 1 });
    },
  );

  it('treats a failed request or missing settings as not announced', async () => {
    const failing = build({ palazzoUrl: 'http://palazzo:3100' });
    failing.palazzo.announceNext.mockRejectedValue(
      new PalazzoMachineError('unavailable'),
    );
    await expect(failing.service.announceNext('radio-1', SONG)).resolves.toBe(
      'rejected',
    );
    expect(failing.metrics.snapshot().nextAnnouncements).toEqual({
      rejected: 1,
    });

    const unconfigured = build(null);
    await expect(
      unconfigured.service.announceNext('radio-1', SONG),
    ).resolves.toBe('rejected');
    expect(unconfigured.palazzo.announceNext).not.toHaveBeenCalled();
  });
});

describe('RadioService.withdrawNext', () => {
  it('withdraws and counts it', async () => {
    const { service, palazzo, metrics } = build({
      palazzoUrl: 'http://palazzo:3100',
    });
    await service.withdrawNext('radio-1');
    expect(palazzo.withdrawNext).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
    );
    expect(metrics.snapshot().nextAnnouncements).toEqual({ withdrawn: 1 });
  });

  it('logs a failure and does nothing without settings', async () => {
    const failing = build({ palazzoUrl: 'http://palazzo:3100' });
    failing.palazzo.withdrawNext.mockRejectedValue(
      new PalazzoMachineError('unavailable'),
    );
    await expect(failing.service.withdrawNext('radio-1')).resolves.toBe(
      undefined,
    );
    expect(failing.metrics.snapshot().nextAnnouncements).toEqual({});

    const unconfigured = build(null);
    await unconfigured.service.withdrawNext('radio-1');
    expect(unconfigured.palazzo.withdrawNext).not.toHaveBeenCalled();
  });
});
