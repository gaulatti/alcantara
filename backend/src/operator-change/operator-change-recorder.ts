import { Injectable, Logger } from '@nestjs/common';
import { Actor, ActorContext } from '../auth/actor-context';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';

/** What an operator change record is about; bounded, so it can label a metric. */
export const OPERATOR_CHANGE_TARGETS = [
  'scene',
  'layout',
  'flight_sequence',
  'program',
] as const;
export type OperatorChangeTarget = (typeof OPERATOR_CHANGE_TARGETS)[number];

type Scalar = string | number | boolean | null;

export type OperatorChangeSummary = {
  changed: string[];
  before: Record<string, Scalar>;
  after: Record<string, Scalar>;
};

/** How one kind of change may be described: which fields are named, which may carry their value. */
export interface OperatorChangeFields {
  /** Fields that are named when given, never valued: free text, JSON, URLs, anything that could hold a secret. */
  named: readonly string[];
  /** Fields whose value before and after may appear: ids, names, enums, booleans, numbers, dates. */
  valued: readonly string[];
}

const scalar = (value: unknown): Scalar => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : null;
};

/**
 * The summary of a change: the names of the fields given and, for the valued ones, their value before and after.
 * `given` is what the caller sent; `previous` and `current` are the row before and after the write. A field outside
 * both lists is never named, and a named field is never valued.
 */
export function summarizeChange(
  fields: OperatorChangeFields,
  given: Record<string, unknown>,
  previous: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): OperatorChangeSummary {
  const changed: string[] = [];
  const before: Record<string, Scalar> = {};
  const after: Record<string, Scalar> = {};
  for (const field of [...fields.named, ...fields.valued]) {
    if (given[field] === undefined) continue;
    changed.push(field);
    if (!fields.valued.includes(field)) continue;
    before[field] = scalar(previous?.[field]);
    after[field] = scalar(current?.[field]);
  }
  return { changed, before, after };
}

export interface OperatorChangeInput {
  /** The actor, read at command time with `recorder.actor()`; null records nothing (an automatic change). */
  actor: Actor | null;
  target: OperatorChangeTarget;
  targetId: string;
  /** The program the change was made in; null for a scene or layout. */
  programId: string | null;
  /** The capability name when the change came through MCP and the route name when it came through the console. */
  capability: { mcp: string; console: string };
  summary: OperatorChangeSummary;
}

/**
 * Stores who changed what is on air (gaulatti/alcantara#236). It runs after the change and never fails it: a record
 * that cannot be stored is logged and counted, and the change stands.
 */
@Injectable()
export class OperatorChangeRecorder {
  private readonly logger = new Logger(OperatorChangeRecorder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  /** The acting identity of the command being handled; read it synchronously when the command arrives. */
  actor(): Actor | null {
    return ActorContext.current();
  }

  async record(input: OperatorChangeInput): Promise<void> {
    if (!input.actor) return;
    try {
      await this.prisma.operatorChangeRecord.create({
        data: {
          teamId: null,
          programId: input.programId,
          targetKind: input.target,
          targetId: input.targetId,
          principal: input.actor.principalId,
          via: input.actor.via,
          client: input.actor.client,
          capability:
            input.actor.via === 'mcp'
              ? input.capability.mcp
              : input.capability.console,
          summary: input.summary,
        },
      });
      this.metrics.recordOperatorChangeRecord(input.target, 'recorded');
    } catch (error) {
      this.metrics.recordOperatorChangeRecord(input.target, 'failed');
      this.logger.warn(
        `Operator change record for ${input.target} ${input.targetId} was not stored; the change stands: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
