import { Logger } from '@nestjs/common';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { hoursStartingWithin } from './radio-daypart-hours';
import {
  DAYPART_PLAN_EVERY_MS,
  RadioDaypartPlanner,
} from './radio-daypart-planner.service';

// gaulatti/alcantara#124: the coming hours of the grid become ordinary published logs; people's logs win.
const at = (iso: string) => Date.parse(iso);
/** Monday 2026-12-07 05:30 UTC: the 06:00 and 07:00 hours are inside the look-ahead. */
const NOW = at('2026-12-07T05:30:00Z');
const SIX = at('2026-12-07T06:00:00Z');

interface Row {
  id: number;
  programStateId: number;
  name: string;
  scheduledAt: Date;
  items: unknown[];
  revision: number;
  publishedAt: Date | null;
  lastStartedAt: Date | null;
  isRunning: boolean;
  clockId: number | null;
  daypartStart: string | null;
  daypartOutcome: string | null;
  daypartRevision: number | null;
}

const row = (data: Partial<Row>): Row => ({
  id: 100,
  programStateId: 3,
  name: 'mine',
  scheduledAt: new Date(SIX),
  items: [],
  revision: 0,
  publishedAt: null,
  lastStartedAt: null,
  isRunning: false,
  clockId: null,
  daypartStart: null,
  daypartOutcome: null,
  daypartRevision: null,
  ...data,
});

const clock = { id: 5, name: 'Morning', rules: { slots: [] } };
const monday = {
  dayOfWeek: 1,
  startHour: 6,
  endHour: 7,
  start: 'soft',
  clock,
};

function setup(
  options: {
    dayparts?: unknown[];
    rows?: Row[];
    type?: string;
    active?: number | null;
  } = {},
) {
  const rows = [...(options.rows ?? [])];
  const matches = (candidate: Row, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = candidate[key as keyof Row];
      if (key === 'scheduledAt')
        return value instanceof Date
          ? candidate.scheduledAt.getTime() === value.getTime()
          : candidate.scheduledAt > value.gt;
      if (value && typeof value === 'object') return actual !== value.not;
      return actual === value;
    });
  const grid = {
    programStateId: 3,
    timeZone: 'UTC',
    programState: {
      programId: 'fm',
      type: options.type ?? 'radio',
      activeFlightSequenceId: options.active ?? null,
    },
    dayparts: options.dayparts ?? [monday],
  };
  const prisma = {
    radioDaypartGrid: { findMany: jest.fn().mockResolvedValue([grid]) },
    flightSequence: {
      findMany: jest.fn(async ({ where }) =>
        rows.filter((candidate) => matches(candidate, where)),
      ),
      findFirst: jest.fn(
        async ({ where }) =>
          rows.find((candidate) => matches(candidate, where)) ?? null,
      ),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(
          rows.find((candidate) => candidate.id === where.id)!,
          data,
        ),
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = rows.filter((candidate) => matches(candidate, where));
        found.forEach((candidate) => Object.assign(candidate, data));
        return { count: found.length };
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const index = rows.findIndex((candidate) => matches(candidate, where));
        if (index >= 0) rows.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      }),
    },
  };
  let nextId = 1;
  const flights = {
    createFlightSequence: jest.fn(async (_programId, data) => {
      const created = row({
        id: nextId++,
        name: data.name,
        scheduledAt: new Date(data.scheduledAt),
      });
      rows.push(created);
      return created;
    }),
    generateTaggedLog: jest.fn().mockResolvedValue({ items: ['a song'] }),
    updateFlightSequence: jest.fn(async (_programId, id, data) => {
      const found = rows.find((candidate) => candidate.id === id)!;
      Object.assign(found, { items: data.items, revision: found.revision + 1 });
      return { ...found };
    }),
    publishFlightSequence: jest.fn(async (_programId, id) => {
      const found = rows.find((candidate) => candidate.id === id)!;
      Object.assign(found, {
        publishedAt: new Date(NOW),
        revision: found.revision + 1,
      });
      return { ...found };
    }),
  };
  const metrics = { recordDaypartBlock: jest.fn() };
  const planner = new RadioDaypartPlanner(
    prisma as never,
    flights as never,
    metrics as never,
  );
  const counted = () => metrics.recordDaypartBlock.mock.calls.map((c) => c[0]);
  return { planner, prisma, flights, rows, grid, counted };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('whole hours of a zone', () => {
  const labels = (from: string, to: string, zone: string) =>
    hoursStartingWithin(at(from), at(to), zone).map((hour) => hour.label);

  it('gives each local hour with its weekday', () => {
    expect(
      hoursStartingWithin(
        at('2026-12-06T22:59:30Z'),
        at('2026-12-07T00:00:00Z'),
        'Europe/Rome',
      ),
    ).toEqual([
      {
        at: new Date('2026-12-06T23:00:00Z'),
        dayOfWeek: 1,
        hour: 0,
        label: '2026-12-07 00:00 +01:00',
      },
      {
        at: new Date('2026-12-07T00:00:00Z'),
        dayOfWeek: 1,
        hour: 1,
        label: '2026-12-07 01:00 +01:00',
      },
    ]);
    expect(
      labels('2026-12-07T00:00:00Z', '2026-12-07T01:00:00Z', 'Asia/Kolkata'),
    ).toEqual(['2026-12-07 06:00 +05:30']);
    expect(
      labels('2026-12-07T00:00:00Z', '2026-12-07T01:00:00Z', 'UTC'),
    ).toEqual(['2026-12-07 01:00 +00:00']);
  });

  it('skips the hour a clock change drops and names a repeated one twice', () => {
    expect(
      labels('2027-03-28T00:00:00Z', '2027-03-28T01:00:00Z', 'Europe/Rome'),
    ).toEqual(['2027-03-28 03:00 +02:00']);
    expect(
      labels('2026-10-24T23:30:00Z', '2026-10-25T01:00:00Z', 'Europe/Rome'),
    ).toEqual(['2026-10-25 02:00 +02:00', '2026-10-25 02:00 +01:00']);
  });
});

describe('daypart planner', () => {
  it('does nothing for an empty grid', async () => {
    const { planner, flights, prisma, counted } = setup({ dayparts: [] });
    await planner.tick(NOW);
    expect(flights.createFlightSequence).not.toHaveBeenCalled();
    expect(prisma.flightSequence.deleteMany).not.toHaveBeenCalled();
    expect(counted()).toEqual([]);
  });

  it('leaves a program without a radio leg alone', async () => {
    const { planner, prisma } = setup({ type: 'tv' });
    await planner.tick(NOW);
    expect(prisma.flightSequence.findMany).not.toHaveBeenCalled();
  });

  it('publishes each hour of a daypart once, through the log service', async () => {
    const { planner, flights, rows, counted } = setup({
      dayparts: [{ ...monday, endHour: 9 }],
    });
    await planner.tick(NOW);
    await planner.tick(NOW + DAYPART_PLAN_EVERY_MS);
    expect(rows.map((made) => made.name)).toEqual([
      'Morning 2026-12-07 06:00 +00:00',
      'Morning 2026-12-07 07:00 +00:00',
    ]);
    expect(rows[0]).toMatchObject({
      items: ['a song'],
      clockId: 5,
      daypartStart: 'soft',
      daypartOutcome: null,
      revision: 2,
      daypartRevision: 2,
    });
    expect(flights.generateTaggedLog).toHaveBeenNthCalledWith(1, 'fm', 1, {
      revision: 0,
      rules: clock.rules,
    });
    expect(flights.publishFlightSequence).toHaveBeenNthCalledWith(
      1,
      'fm',
      1,
      1,
    );
    expect(counted()).toEqual(['generated', 'generated']);
  });

  it('never touches a log a person made for the hour', async () => {
    const mine = row({ publishedAt: new Date(NOW) });
    const { planner, flights, rows } = setup({ rows: [mine] });
    await planner.tick(NOW);
    expect(flights.createFlightSequence).not.toHaveBeenCalled();
    expect(rows).toEqual([mine]);
  });

  it('keeps a failed hour as a draft, counts it once and retries it', async () => {
    const { planner, flights, rows, counted } = setup();
    flights.generateTaggedLog
      .mockRejectedValueOnce(new Error('no song has this tag'))
      .mockRejectedValueOnce('again');
    await planner.tick(NOW);
    expect(rows[0]).toMatchObject({
      publishedAt: null,
      clockId: 5,
      daypartOutcome: 'failed',
    });
    await planner.tick(NOW + DAYPART_PLAN_EVERY_MS);
    expect(counted()).toEqual(['failed']);
    await planner.tick(NOW + 2 * DAYPART_PLAN_EVERY_MS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ daypartOutcome: null });
    expect(rows[0].publishedAt).not.toBeNull();
    expect(counted()).toEqual(['failed', 'generated']);
  });

  it('says why when a clock cannot fill an hour, whatever was thrown', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { planner, flights } = setup();
    flights.generateTaggedLog.mockRejectedValue('not an error');
    await planner.tick(NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
  });

  it('counts an hour it could not even create', async () => {
    const { planner, flights, prisma, counted } = setup();
    flights.createFlightSequence.mockRejectedValue(new Error('taken'));
    await planner.tick(NOW);
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
    expect(counted()).toEqual(['failed']);
  });

  it('takes back its own untouched hours when the grid no longer asks for them', async () => {
    const published = row({
      id: 7,
      clockId: 9,
      revision: 2,
      daypartRevision: 2,
      publishedAt: new Date(NOW),
    });
    const failed = row({
      id: 8,
      scheduledAt: new Date(SIX + 3_600_000),
      clockId: 5,
      daypartOutcome: 'failed',
    });
    const { planner, rows, counted } = setup({
      dayparts: [{ ...monday, startHour: 20, endHour: 21 }],
      rows: [published, failed],
    });
    await planner.tick(NOW);
    expect(rows).toEqual([]);
    expect(counted()).toEqual(['removed', 'removed']);
  });

  it('replaces an hour whose clock changed', async () => {
    const old = row({
      id: 7,
      clockId: 9,
      revision: 2,
      daypartRevision: 2,
      publishedAt: new Date(NOW),
    });
    const { planner, rows, counted } = setup({ rows: [old] });
    await planner.tick(NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clockId: 5 });
    expect(counted()).toEqual(['removed', 'generated']);
  });

  it('keeps a block a person edited, loaded or drafted over', async () => {
    const made = { clockId: 9, revision: 2, daypartRevision: 2 };
    for (const [kept, active] of [
      [row({ ...made, publishedAt: new Date(NOW), revision: 3 }), null],
      [row({ ...made, publishedAt: new Date(NOW) }), 100],
      [row({ clockId: 9 }), null],
    ] as const) {
      const { planner, rows } = setup({ rows: [kept], active });
      await planner.tick(NOW);
      expect(rows).toEqual([kept]);
      expect(kept.clockId).toBe(9);
    }
  });

  it('does not count a removal that lost the race with an edit', async () => {
    const { planner, prisma, counted } = setup({
      dayparts: [],
      rows: [
        row({
          clockId: 9,
          revision: 2,
          daypartRevision: 2,
          publishedAt: new Date(NOW),
        }),
      ],
    });
    prisma.flightSequence.deleteMany.mockResolvedValue({ count: 0 });
    await planner.tick(NOW);
    expect(counted()).toEqual([]);
  });

  it('survives an unreadable grid and does not overlap itself', async () => {
    const { planner, prisma, counted } = setup();
    let fail!: (reason: Error) => void;
    prisma.radioDaypartGrid.findMany.mockReturnValue(
      new Promise((_resolve, reject) => (fail = reject)) as never,
    );
    const first = planner.tick(NOW);
    await planner.tick(NOW);
    expect(prisma.radioDaypartGrid.findMany).toHaveBeenCalledTimes(1);
    fail(new Error('down'));
    await first;
    expect(counted()).toEqual(['failed']);
  });

  it('plans at start and every minute, but not in a deploy candidate', async () => {
    jest.useFakeTimers({ now: NOW });
    const { planner, prisma } = setup({ dayparts: [] });
    process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
    await planner.onModuleInit();
    planner.onModuleDestroy();
    delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
    expect(prisma.radioDaypartGrid.findMany).not.toHaveBeenCalled();
    await planner.onModuleInit();
    await jest.advanceTimersByTimeAsync(DAYPART_PLAN_EVERY_MS);
    planner.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(DAYPART_PLAN_EVERY_MS);
    expect(prisma.radioDaypartGrid.findMany).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});

describe('daypart block metric', () => {
  it('exposes each bounded result', () => {
    const metrics = new RadioMetricsService();
    metrics.recordDaypartBlock('generated');
    metrics.recordDaypartBlock('generated');
    const text = metrics.render();
    expect(text).toContain(
      'alcantara_radio_daypart_blocks_total{result="generated"} 2',
    );
    for (const result of ['failed', 'removed', 'started', 'skipped'])
      expect(text).toContain(
        `alcantara_radio_daypart_blocks_total{result="${result}"} 0`,
      );
  });
});

describe('planner decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    jest.isolateModules(() => {
      for (const path of [
        '../playout/playout-lease.service',
        '../prisma.service',
        '../radio/radio-metrics.service',
        './flight.service',
      ])
        jest.doMock(path, () => ({}));
      const {
        RadioDaypartPlanner: Isolated,
      } = require('./radio-daypart-planner.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
    });
    for (const path of [
      '../playout/playout-lease.service',
      '../prisma.service',
      '../radio/radio-metrics.service',
      './flight.service',
    ])
      jest.dontMock(path);
  });
});
