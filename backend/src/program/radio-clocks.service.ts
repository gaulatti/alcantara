import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { parseRadioLogRules, type RadioLogRules } from './radio-log-generator';

export interface RadioClockInput {
  name?: unknown;
  rules?: unknown;
  revision?: unknown;
}

export interface RadioClockView {
  id: number;
  name: string;
  rules: RadioLogRules;
  revision: number;
}

interface ClockRow {
  id: number;
  name: string;
  rules: unknown;
  revision: number;
}

const view = (row: ClockRow): RadioClockView => ({
  id: row.id,
  name: row.name,
  rules: row.rules as RadioLogRules,
  revision: row.revision,
});

function nameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100)
    throw new BadRequestException('a clock needs a name of 1-100 characters');
  return name;
}

/** Only the fields the generator reads are stored, so a clock never carries anything it would ignore. */
function rulesOf(value: unknown): RadioLogRules {
  const rules = parseRadioLogRules(value);
  return {
    artistSeparation: rules.artistSeparation,
    slots: rules.slots.map((slot) => ({
      labelId: slot.labelId.trim(),
      count: slot.count,
      ...(slot.clockOffsetSeconds !== undefined
        ? { clockOffsetSeconds: slot.clockOffsetSeconds }
        : {}),
    })),
  };
}

/**
 * gaulatti/alcantara#124: a radio program's clocks. A clock is only a stored set of radio log rules; nothing airs
 * because one exists. The daypart grid says which hours one fills.
 */
@Injectable()
export class RadioClocksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(programId: string): Promise<RadioClockView[]> {
    const state = await this.program(programId);
    const rows = await this.prisma.radioClock.findMany({
      where: { programStateId: state.id },
      orderBy: { id: 'asc' },
    });
    return rows.map(view);
  }

  async create(
    programId: string,
    input: RadioClockInput,
  ): Promise<RadioClockView> {
    const state = await this.program(programId);
    const name = nameOf(input.name);
    const rules = rulesOf(input.rules);
    try {
      return view(
        await this.prisma.radioClock.create({
          data: { programStateId: state.id, name, rules: rules as object },
        }),
      );
    } catch (error) {
      throw this.duplicate(error, name);
    }
  }

  /** Changes a clock when `revision` is the one stored. Hours already generated keep what they were given. */
  async update(
    programId: string,
    clockId: number,
    input: RadioClockInput,
  ): Promise<RadioClockView> {
    const state = await this.program(programId);
    const existing = await this.clock(state.id, clockId);
    if (input.revision !== existing.revision)
      throw new ConflictException('The clock changed. Reload before saving.');
    const name = input.name === undefined ? undefined : nameOf(input.name);
    const rules = input.rules === undefined ? undefined : rulesOf(input.rules);
    try {
      const result = await this.prisma.radioClock.updateMany({
        where: {
          id: clockId,
          programStateId: state.id,
          revision: existing.revision,
        },
        data: {
          ...(name === undefined ? {} : { name }),
          ...(rules === undefined ? {} : { rules: rules as object }),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1)
        throw new ConflictException('The clock changed. Reload before saving.');
    } catch (error) {
      throw this.duplicate(error, name ?? existing.name);
    }
    return view(await this.clock(state.id, clockId));
  }

  /** Deletes a clock no daypart uses. */
  async delete(
    programId: string,
    clockId: number,
    revision: number,
  ): Promise<{ deleted: true }> {
    const state = await this.program(programId);
    const existing = await this.clock(state.id, clockId);
    if (revision !== existing.revision)
      throw new ConflictException('The clock changed. Reload before deleting.');
    const used = await this.prisma.radioDaypart.count({ where: { clockId } });
    if (used)
      throw new ConflictException(
        `The clock fills ${used} daypart${used === 1 ? '' : 's'}. Take it out of the grid first.`,
      );
    const result = await this.prisma.radioClock.deleteMany({
      where: { id: clockId, programStateId: state.id, revision },
    });
    if (result.count !== 1)
      throw new ConflictException('The clock changed. Reload before deleting.');
    return { deleted: true };
  }

  private async clock(
    programStateId: number,
    clockId: number,
  ): Promise<ClockRow> {
    const row = await this.prisma.radioClock.findFirst({
      where: { id: clockId, programStateId },
    });
    if (!row) throw new NotFoundException('clock not found');
    return row;
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

  private duplicate(error: unknown, name: string): unknown {
    if ((error as { code?: string }).code === 'P2002')
      return new ConflictException(`a clock named "${name}" already exists`);
    return error;
  }
}
