import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { FlightService } from './flight.service';
import {
  FIXED_START_MAX_HOURS,
  fixedStartWindowRefusal,
} from './fixed-start-window';

// #788 (MCP parity, item 4): the desk's fixed-start window (D3) on the save path the console and MCP share.

describe('fixedStartWindowRefusal', () => {
  const start = new Date('2099-01-01T07:10:00.000Z');
  const next = new Date('2099-01-01T07:30:00.000Z');

  it('accepts fixed starts inside the block, before the next one and within the bound', () => {
    expect(FIXED_START_MAX_HOURS).toBe(6);
    expect(
      fixedStartWindowRefusal(
        [{ clockOffsetSeconds: 0 }, {}, { clockOffsetSeconds: 1199 }],
        start,
        next,
      ),
    ).toBeNull();
    expect(
      fixedStartWindowRefusal([{ clockOffsetSeconds: 21_599 }], start, null),
    ).toBeNull();
  });

  it('refuses a fixed start 6 hours or more after the block start, and one at or after the next block', () => {
    expect(
      fixedStartWindowRefusal([{ clockOffsetSeconds: 21_600 }], start, null),
    ).toBe(
      'A fixed start at +360:00 is more than 6 hours after this block starts at 2099-01-01T07:10:00.000Z.',
    );
    expect(
      fixedStartWindowRefusal([{ clockOffsetSeconds: 1200 }], start, next),
    ).toBe(
      'A fixed start at +20:00 is after the next block starts at 2099-01-01T07:30:00.000Z.',
    );
  });
});

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

describe('the fixed-start window on the flight save path, against Postgres', () => {
  const programId = `window-${randomUUID()}`;
  let prisma: PrismaService;
  let service: FlightService;
  const at = (time: string) => `2099-03-04T${time}:00.000Z`;
  const song = (id: string, clockOffsetSeconds?: number) => ({
    id,
    kind: 'stopSong',
    ...(clockOffsetSeconds === undefined ? {} : { clockOffsetSeconds }),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.programState.create({ data: { programId, type: 'radio' } });
    service = new FlightService(
      prisma,
      { broadcastUpdate: jest.fn() } as never,
      new RadioMetricsService(),
      noRecorder(),
      { teamId: 0 } as never,
    );
  });

  afterAll(async () => {
    const state = await prisma?.programState.findUnique({
      where: { programId },
    });
    if (state)
      await prisma.flightSequence.deleteMany({
        where: { programStateId: state.id },
      });
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.$disconnect();
  });

  it('refuses to create or edit a block with a fixed start past the next block or the bound, as the desk does', async () => {
    await service.createFlightSequence(programId, {
      name: 'Next',
      scheduledAt: at('07:30'),
      items: [song('n', 0)],
    });
    await expect(
      service.createFlightSequence(programId, {
        name: 'Morning',
        scheduledAt: at('07:10'),
        items: [song('a', 0), song('b', 1200)],
      }),
    ).rejects.toThrow(
      new BadRequestException(
        `A fixed start at +20:00 is after the next block starts at ${at('07:30')}.`,
      ),
    );
    const morning = await service.createFlightSequence(programId, {
      name: 'Morning',
      scheduledAt: at('07:10'),
      items: [song('a', 0), song('b', 1199)],
    });
    await expect(
      service.updateFlightSequence(programId, morning.id, {
        revision: morning.revision,
        items: [song('a', 0), song('b', 1300)],
      }),
    ).rejects.toThrow(/is after the next block starts/);
    // The next block itself is not limited by an earlier one, only by the bound.
    const next = (await service.listFlightSequences(programId)).find(
      (one) => one.name === 'Next',
    )!;
    await expect(
      service.updateFlightSequence(programId, next.id, {
        revision: next.revision,
        items: [song('n', 0), song('m', 21_600)],
      }),
    ).rejects.toThrow(/is more than 6 hours after this block starts/);
  });

  it('still loads and renames a block saved before the window rule, checking only what is written', async () => {
    const state = await prisma.programState.findUniqueOrThrow({
      where: { programId },
    });
    const older = await prisma.flightSequence.create({
      data: {
        programStateId: state.id,
        name: 'Older',
        scheduledAt: new Date(at('12:00')),
        items: [song('o', 0), song('p', 30_000)],
      },
    });
    expect(
      (await service.listFlightSequences(programId)).some(
        (one) => one.id === older.id,
      ),
    ).toBe(true);
    const renamed = await service.updateFlightSequence(programId, older.id, {
      revision: older.revision,
      name: 'Older, renamed',
    });
    expect(renamed.name).toBe('Older, renamed');
    await expect(
      service.updateFlightSequence(programId, older.id, {
        revision: renamed.revision,
        items: [song('o', 0), song('p', 30_000)],
      }),
    ).rejects.toThrow(/is more than 6 hours after this block starts/);
  });
});
