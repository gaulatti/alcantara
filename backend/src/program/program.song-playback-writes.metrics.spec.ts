import { BadRequestException } from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from './program.service';

// gaulatti/alcantara#612: authorized song-playback writes are counted by result, exposed from 0, so a window
// of zero shows that nothing still calls the route.

const base = {
  token: 'song-1:https://media.test/1.mp3',
  audioUrl: 'https://media.test/1.mp3',
  progress: 0.1,
  currentTimeMs: 1000,
  durationMs: 10_000,
  isPlaying: false,
};

async function count(metrics: ManagedMetricsService, result: string) {
  const text = await metrics.registry.metrics();
  const line = text
    .split('\n')
    .find((row) =>
      row.startsWith(
        `alcantara_program_song_playback_writes_total{result="${result}"} `,
      ),
    );
  return line === undefined ? null : Number(line.split(' ')[1]);
}

function build() {
  const metrics = new ManagedMetricsService();
  const prisma = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, programId: 'main', type: 'tv' }),
    },
  };
  const service = new ProgramService(
    prisma as never,
    {} as never,
    {} as never,
    metrics,
  );
  jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined as never);
  return { service, metrics };
}

afterEach(() => jest.restoreAllMocks());

it('exposes both results from zero before any write', async () => {
  const { metrics } = build();
  expect(await count(metrics, 'accepted')).toBe(0);
  expect(await count(metrics, 'failed')).toBe(0);
});

it('counts an accepted write and a refused one', async () => {
  const { service, metrics } = build();
  await service.updateProgramSongPlayback(base, 'main');
  expect(await count(metrics, 'accepted')).toBe(1);
  await expect(
    service.updateProgramSongPlayback(null, 'main'),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(await count(metrics, 'failed')).toBe(1);
  expect(await count(metrics, 'accepted')).toBe(1);
});

it('keeps the result label bounded', async () => {
  const { metrics } = build();
  metrics.recordSongPlaybackWrite('anything');
  expect(await count(metrics, 'unknown')).toBe(1);
  expect(await count(metrics, 'anything')).toBeNull();
});
