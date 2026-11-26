import { radioEngineReadiness } from './engine-availability';
import { FlightService } from '../program/flight.service';
import { RadioMetricsService } from './radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// The rundown-building walk (GM's decision D1): a block for a show whose radio is not set up, or is off, would air
// nothing, yet Check said "ready for air". The preflight now says so as a warning, never as a blocking issue.

const prismaWith = (state: unknown) =>
  ({
    programState: { findUnique: jest.fn().mockResolvedValue(state) },
  }) as never;

describe('radioEngineReadiness', () => {
  const ready = { enabled: true, palazzoUrl: 'http://palazzo:3100' };
  const rows: [string, string, unknown][] = [
    ['a show it does not know', 'not-radio', null],
    ['a TV show', 'not-radio', { type: 'tv', radioSettings: null }],
    [
      'a radio show with no radio settings',
      'not-configured',
      { type: 'radio', radioSettings: null },
    ],
    [
      'a radio show with no Palazzo URL',
      'not-configured',
      { type: 'radio', radioSettings: { ...ready, palazzoUrl: '  ' } },
    ],
    [
      'a radio show whose radio is off',
      'disabled',
      { type: 'radio', radioSettings: { ...ready, enabled: false } },
    ],
    [
      'a simulcast show whose radio is set up and on',
      'ready',
      { type: 'both', radioSettings: ready },
    ],
  ];
  it.each(rows)('reads %s as %s', async (_name, expected, state) => {
    await expect(radioEngineReadiness(prismaWith(state), 'show')).resolves.toBe(
      expected,
    );
  });
});

describe('clock preflight and the show radio', () => {
  const preflight = (radioSettings: unknown) => {
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, type: 'radio', radioSettings }),
      },
      song: { findMany: jest.fn().mockResolvedValue([]) },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new FlightService(
      prisma as never,
      { broadcastUpdate: jest.fn() } as never,
      new RadioMetricsService(),
      noRecorder(),
      { teamId: 0 } as never,
    );
    return (
      service as never as {
        preflightClockItems: (
          programId: string,
          items: unknown[],
        ) => Promise<unknown>;
      }
    ).preflightClockItems('show', [
      { id: 'a', kind: 'stopSong', clockOffsetSeconds: 0 },
    ]);
  };

  it.each([
    [
      'not set up',
      null,
      'not-configured',
      "Radio isn't set up for this show: set it up in Radio distribution before the block starts",
    ],
    [
      'off',
      { enabled: false, palazzoUrl: 'http://palazzo:3100' },
      'disabled',
      'Radio is off for this show: turn it on in Radio distribution before the block starts',
    ],
  ])(
    'warns, without blocking, when the radio is %s',
    async (_name, settings, engine, warning) => {
      await expect(preflight(settings)).resolves.toEqual({
        programId: 'show',
        ready: true,
        issues: [],
        warnings: [warning],
        engine,
      });
    },
  );

  it('says nothing more when the radio is set up and on', async () => {
    await expect(
      preflight({ enabled: true, palazzoUrl: 'http://palazzo:3100' }),
    ).resolves.toEqual({
      programId: 'show',
      ready: true,
      issues: [],
      warnings: [],
      engine: 'ready',
    });
  });
});
