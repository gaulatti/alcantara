import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { isDeployCandidate } from '../config/deploy-candidate';
import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { FlightService } from './flight.service';
import { hoursStartingWithin, type DaypartHour } from './radio-daypart-hours';

/** How far ahead hours are made, and how often the planner looks. */
export const DAYPART_LOOK_AHEAD_MS = 2 * 60 * 60_000;
export const DAYPART_PLAN_EVERY_MS = 60_000;
/** An hour this close is left alone: it cannot be published, and a block about to start is not taken back. */
const NOT_WITHIN_MS = 30_000;

export const DAYPART_FAILED = 'failed';

interface PlannedDaypart {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  start: string;
  clock: { id: number; name: string; rules: unknown };
}

interface PlannedGrid {
  programStateId: number;
  timeZone: string;
  programState: {
    programId: string;
    type: string;
    activeFlightSequenceId: number | null;
  };
  dayparts: PlannedDaypart[];
}

const daypartAt = (dayparts: PlannedDaypart[], hour: DaypartHour) =>
  dayparts.find(
    (entry) =>
      entry.dayOfWeek === hour.dayOfWeek &&
      entry.startHour <= hour.hour &&
      hour.hour < entry.endHour,
  );

/**
 * gaulatti/alcantara#124: makes the coming hours of each daypart grid into ordinary published radio logs, from the
 * hour's clock, with the log generator and the publish checks an operator uses. A log a person made at an hour
 * wins, and one a person edited is never taken back. With no dayparts it does nothing.
 */
@Injectable()
export class RadioDaypartPlanner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RadioDaypartPlanner.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly flights: FlightService,
    private readonly metrics: RadioMetricsService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  async onModuleInit(): Promise<void> {
    if (isDeployCandidate()) return;
    // Only the instance that runs the rundown makes its hours.
    await startWhenActive(this.lease, () => {
      this.timer = setInterval(() => void this.tick(), DAYPART_PLAN_EVERY_MS);
      return this.tick();
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The hours of the grid that begin in the next `ahead` hours: the log already made for one, or the cues its clock
   * would give it now. Writes nothing. Each unmade hour is proposed by itself, so the picks can differ when made.
   */
  async preview(programId: string, ahead: number, now = Date.now()) {
    const grid = (await this.prisma.radioDaypartGrid.findFirst({
      where: { programState: { programId: programId.trim() } },
      include: { dayparts: { include: { clock: true } } },
    })) as unknown as Omit<PlannedGrid, 'programState'> | null;
    if (!grid) return { timeZone: null, hours: [] };
    const hours: Array<Record<string, unknown>> = [];
    for (const hour of hoursStartingWithin(
      now,
      now + ahead * 60 * 60_000,
      grid.timeZone,
    )) {
      const daypart = daypartAt(grid.dayparts, hour);
      if (!daypart) continue;
      const existing = await this.prisma.flightSequence.findFirst({
        where: { programStateId: grid.programStateId, scheduledAt: hour.at },
      });
      const entry: Record<string, unknown> = {
        startsAt: hour.at.toISOString(),
        localTime: hour.label,
        clockId: daypart.clock.id,
        name: daypart.clock.name,
        start: daypart.start,
        log: existing
          ? {
              id: existing.id,
              madeFromClock: existing.clockId !== null,
              published: existing.publishedAt !== null,
              outcome: existing.daypartOutcome,
            }
          : null,
      };
      if (!existing)
        try {
          entry.items = await this.flights.previewTaggedLog(
            programId,
            hour.at,
            daypart.clock.rules,
          );
        } catch (error) {
          entry.problem =
            error instanceof Error ? error.message : 'unknown error';
        }
      hours.push(entry);
    }
    return { timeZone: grid.timeZone, hours };
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const grids = (await this.prisma.radioDaypartGrid.findMany({
        include: {
          programState: {
            select: {
              programId: true,
              type: true,
              activeFlightSequenceId: true,
            },
          },
          dayparts: { include: { clock: true } },
        },
      })) as unknown as PlannedGrid[];
      for (const grid of grids) {
        if (
          grid.programState.type !== 'radio' &&
          grid.programState.type !== 'both'
        )
          continue;
        await this.plan(grid, now);
      }
    } catch {
      this.metrics.recordDaypartBlock('failed');
      this.logger.error('The daypart planner could not read the grids');
    } finally {
      this.running = false;
    }
  }

  private async plan(grid: PlannedGrid, now: number): Promise<void> {
    const from = now + NOT_WITHIN_MS;
    const hours = hoursStartingWithin(
      from,
      now + DAYPART_LOOK_AHEAD_MS,
      grid.timeZone,
    );
    const wanted = new Map<number, [DaypartHour, PlannedDaypart]>();
    for (const hour of hours) {
      const daypart = daypartAt(grid.dayparts, hour);
      if (daypart) wanted.set(hour.at.getTime(), [hour, daypart]);
    }
    await this.takeBack(grid, from, wanted);
    for (const [hour, daypart] of wanted.values())
      await this.make(grid, hour, daypart);
  }

  /** Removes the coming machine-made hours the grid no longer asks for, unless a person has touched them. */
  private async takeBack(
    grid: PlannedGrid,
    from: number,
    wanted: Map<number, [DaypartHour, PlannedDaypart]>,
  ): Promise<void> {
    const made = await this.prisma.flightSequence.findMany({
      where: {
        programStateId: grid.programStateId,
        clockId: { not: null },
        lastStartedAt: null,
        isRunning: false,
        scheduledAt: { gt: new Date(from) },
      },
    });
    for (const sequence of made) {
      const entry = wanted.get(sequence.scheduledAt!.getTime());
      if (entry && entry[1].clock.id === sequence.clockId) continue;
      const untouched = sequence.publishedAt
        ? sequence.revision === sequence.daypartRevision
        : sequence.daypartOutcome === DAYPART_FAILED;
      // One an operator has loaded into the rundown stays too.
      if (
        !untouched ||
        sequence.id === grid.programState.activeFlightSequenceId
      )
        continue;
      const removed = await this.prisma.flightSequence.deleteMany({
        where: {
          id: sequence.id,
          revision: sequence.revision,
          lastStartedAt: null,
        },
      });
      if (removed.count) this.metrics.recordDaypartBlock('removed');
    }
  }

  private async make(
    grid: PlannedGrid,
    hour: DaypartHour,
    daypart: PlannedDaypart,
  ): Promise<void> {
    const programId = grid.programState.programId;
    const existing = await this.prisma.flightSequence.findFirst({
      where: { programStateId: grid.programStateId, scheduledAt: hour.at },
    });
    // Anything already at the hour stays, except the planner's own failed attempt, which is tried again.
    const retry =
      existing?.clockId != null &&
      existing.publishedAt === null &&
      existing.daypartOutcome === DAYPART_FAILED;
    if (existing && !retry) return;
    let id = existing?.id;
    let revision = existing?.revision;
    try {
      if (id === undefined) {
        const draft = await this.flights.createFlightSequence(programId, {
          name: `${daypart.clock.name} ${hour.label}`,
          scheduledAt: hour.at.toISOString(),
          items: [],
        });
        id = draft.id;
        revision = draft.revision;
      }
      await this.prisma.flightSequence.update({
        where: { id },
        data: { clockId: daypart.clock.id, daypartStart: daypart.start },
      });
      const { items } = await this.flights.generateTaggedLog(programId, id, {
        revision,
        rules: daypart.clock.rules,
      });
      const saved = await this.flights.updateFlightSequence(programId, id, {
        items,
        revision,
      });
      const published = await this.flights.publishFlightSequence(
        programId,
        id,
        saved.revision,
      );
      await this.prisma.flightSequence.update({
        where: { id },
        data: { daypartOutcome: null, daypartRevision: published.revision },
      });
      this.metrics.recordDaypartBlock('generated');
    } catch (error) {
      if (id === undefined) {
        // Nothing was written: most often someone made a log for this hour between the look and the write.
        this.logger.warn(`No log was made for ${programId} at ${hour.label}`);
        this.metrics.recordDaypartBlock('failed');
        return;
      }
      await this.prisma.flightSequence.updateMany({
        where: { id, publishedAt: null },
        data: {
          clockId: daypart.clock.id,
          daypartStart: daypart.start,
          daypartOutcome: DAYPART_FAILED,
        },
      });
      // Counted when it starts failing, not on every retry.
      if (!retry) {
        this.metrics.recordDaypartBlock('failed');
        this.logger.warn(
          `The clock could not fill ${programId} at ${hour.label}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }
}
