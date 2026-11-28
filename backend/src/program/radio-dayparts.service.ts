import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface RadioDaypartInput {
  timeZone?: unknown;
  dayparts?: unknown;
  revision?: unknown;
}

export interface RadioDaypartView {
  /** 0 = Sunday. */
  dayOfWeek: number;
  /** The daypart covers [startHour, endHour) of that day, in the grid's time zone. */
  startHour: number;
  endHour: number;
  clockId: number;
  start: 'soft' | 'hard';
}

export interface RadioDaypartGridView {
  /** Null until a grid is first saved. */
  timeZone: string | null;
  /** 0 until a grid is first saved. */
  revision: number;
  dayparts: RadioDaypartView[];
}

const within = (value: unknown, low: number, high: number): value is number =>
  Number.isInteger(value) &&
  (value as number) >= low &&
  (value as number) <= high;

/** An IANA zone name the runtime knows, as it spells it. */
export function timeZoneOf(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: value.trim(),
      }).resolvedOptions().timeZone;
    } catch {
      // Not a zone; refused below.
    }
  }
  throw new BadRequestException(
    'timeZone must be an IANA time zone, such as Europe/Rome',
  );
}

/** The grid's rows, checked: real days and hours, a start rule, and no two over the same hour. */
export function daypartsOf(value: unknown): RadioDaypartView[] {
  if (!Array.isArray(value) || value.length > 168)
    throw new BadRequestException('dayparts must be a list of at most 168');
  const taken = new Set<number>();
  return value.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const { dayOfWeek, startHour, endHour, clockId } = entry;
    const start = entry.start ?? 'soft';
    if (
      !within(dayOfWeek, 0, 6) ||
      !within(startHour, 0, 23) ||
      !within(endHour, 1, 24) ||
      startHour >= endHour ||
      !within(clockId, 1, 2_147_483_647) ||
      (start !== 'soft' && start !== 'hard')
    )
      throw new BadRequestException(
        `Daypart ${index + 1}: give a day 0-6, hours from 0 to 24 with the end after the start, a clock and a start of soft or hard`,
      );
    for (let hour = startHour; hour < endHour; hour++) {
      const slot = dayOfWeek * 24 + hour;
      if (taken.has(slot))
        throw new BadRequestException(
          `Daypart ${index + 1} overlaps another one`,
        );
      taken.add(slot);
    }
    return { dayOfWeek, startHour, endHour, clockId, start };
  });
}

const ordered = (rows: RadioDaypartView[]) =>
  [...rows].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startHour - b.startHour,
  );

/**
 * gaulatti/alcantara#124: a radio program's weekly grid of dayparts. It is saved whole. An empty grid, or none,
 * means nothing is generated and the station plays as it does without one.
 */
@Injectable()
export class RadioDaypartsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(programId: string): Promise<RadioDaypartGridView> {
    const state = await this.program(programId);
    return this.read(state.id);
  }

  /** What saving would store, with nothing written: the checks of `save`, for a dry run. */
  async check(
    programId: string,
    input: RadioDaypartInput,
  ): Promise<RadioDaypartGridView & { programStateId: number }> {
    const state = await this.program(programId);
    const current = await this.read(state.id);
    if (input.revision !== current.revision)
      throw new ConflictException('The grid changed. Reload before saving.');
    const timeZone = timeZoneOf(input.timeZone);
    const dayparts = daypartsOf(input.dayparts);
    const wanted = [...new Set(dayparts.map((daypart) => daypart.clockId))];
    if (wanted.length) {
      const known = await this.prisma.radioClock.count({
        where: { id: { in: wanted }, programStateId: state.id },
      });
      if (known !== wanted.length)
        throw new BadRequestException(
          'a daypart names a clock this program does not have',
        );
    }
    return {
      programStateId: state.id,
      timeZone,
      revision: current.revision,
      dayparts: ordered(dayparts),
    };
  }

  async save(
    programId: string,
    input: RadioDaypartInput,
  ): Promise<RadioDaypartGridView> {
    const { programStateId, timeZone, revision, dayparts } = await this.check(
      programId,
      input,
    );
    const changed = () =>
      new ConflictException('The grid changed. Reload before saving.');
    try {
      await this.prisma.$transaction(async (tx) => {
        if (revision === 0)
          await tx.radioDaypartGrid.create({
            data: { programStateId, timeZone: timeZone as string },
          });
        else {
          const result = await tx.radioDaypartGrid.updateMany({
            where: { programStateId, revision },
            data: {
              timeZone: timeZone as string,
              revision: { increment: 1 },
            },
          });
          if (result.count !== 1) throw changed();
        }
        await tx.radioDaypart.deleteMany({ where: { programStateId } });
        if (dayparts.length)
          await tx.radioDaypart.createMany({
            data: dayparts.map((daypart) => ({ programStateId, ...daypart })),
          });
      });
    } catch (error) {
      // Two first saves at once: the second finds the grid made.
      if ((error as { code?: string }).code === 'P2002') throw changed();
      throw error;
    }
    return this.read(programStateId);
  }

  private async read(programStateId: number): Promise<RadioDaypartGridView> {
    const grid = await this.prisma.radioDaypartGrid.findUnique({
      where: { programStateId },
      include: { dayparts: true },
    });
    if (!grid) return { timeZone: null, revision: 0, dayparts: [] };
    return {
      timeZone: grid.timeZone,
      revision: grid.revision,
      dayparts: ordered(
        grid.dayparts.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          startHour: row.startHour,
          endHour: row.endHour,
          clockId: row.clockId,
          start: row.start === 'hard' ? 'hard' : 'soft',
        })),
      ),
    };
  }

  private async program(programId: string): Promise<{ id: number }> {
    const state = await this.prisma.programState.findUnique({
      where: { programId: programId.trim() },
      select: { id: true, type: true },
    });
    if (!state) throw new NotFoundException('program not found');
    if (state.type !== 'radio' && state.type !== 'both')
      throw new BadRequestException('program has no radio leg');
    return state;
  }
}
