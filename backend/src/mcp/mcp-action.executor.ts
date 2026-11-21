import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  MCP_ATTRIBUTION,
  McpToolError,
  type ConfirmTarget,
  type McpActionExecutor as McpActionExecutorContract,
  type McpAttribution,
  type McpAuditDetails,
  type McpContext,
  type McpToolSpec,
} from './contract';
import { actionShape } from './mcp-action.shape';
import { MCP_ACTION_LIMITS } from './mcp.constants';

type ActionTier = 'W' | 'A' | 'D';

/** Sorted-key JSON, so equal arguments always serialize equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** Per-identity call limits. check() is read-only; consume() checks and records. */
class ActionLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly lastOnAir = new Map<string, number>();

  /** Milliseconds until the call would be allowed; 0 when it is allowed now. */
  private wait(
    identity: string,
    tier: ActionTier,
    program: string,
    spacing: boolean,
    now: number,
  ): number {
    const key = `${identity}\u0000${tier}`;
    const recent = (this.windows.get(key) ?? []).filter(
      (at) => at > now - MCP_ACTION_LIMITS.windowMs,
    );
    if (recent.length > 0) this.windows.set(key, recent);
    else this.windows.delete(key);
    let wait = 0;
    if (recent.length >= MCP_ACTION_LIMITS.perWindow[tier])
      wait = recent[0] + MCP_ACTION_LIMITS.windowMs - now;
    if (spacing && tier === 'A') {
      const last = this.lastOnAir.get(`${identity}\u0000${program}`);
      if (last !== undefined)
        wait = Math.max(wait, last + MCP_ACTION_LIMITS.onAirSpacingMs - now);
    }
    return Math.max(wait, 0);
  }

  private refuse(wait: number): void {
    if (wait > 0)
      throw new McpToolError(
        'rate_limited',
        'Too many actions; wait before trying again.',
        Math.max(1, Math.ceil(wait / 1000)),
      );
  }

  /** A dry run is held to the per-minute window only, and never recorded. */
  check(
    identity: string,
    tier: ActionTier,
    program: string,
    dryRun: boolean,
    now: number,
  ): void {
    this.refuse(this.wait(identity, tier, program, !dryRun, now));
  }

  /** Checks again and records the run, in one synchronous step. */
  consume(
    identity: string,
    tier: ActionTier,
    program: string,
    now: number,
  ): void {
    this.refuse(this.wait(identity, tier, program, true, now));
    const key = `${identity}\u0000${tier}`;
    this.windows.set(key, [...(this.windows.get(key) ?? []), now]);
    if (tier === 'A') {
      for (const [key, at] of this.lastOnAir)
        if (at <= now - MCP_ACTION_LIMITS.onAirSpacingMs)
          this.lastOnAir.delete(key);
      this.lastOnAir.set(`${identity}\u0000${program}`, now);
    }
  }
}

interface Stored {
  hash: string;
  value: unknown;
  at: number;
}

/** Outcomes by identity, tool and key: in memory, bounded, expiring. */
class IdempotencyStore {
  // Insertion order is time order, so the oldest entry is always first.
  private readonly entries = new Map<string, Stored>();

  private sweep(now: number): void {
    for (const [slot, entry] of this.entries) {
      if (entry.at > now - MCP_ACTION_LIMITS.idempotencyTtlMs) break;
      this.entries.delete(slot);
    }
  }

  get(slot: string, now: number): Stored | undefined {
    this.sweep(now);
    return this.entries.get(slot);
  }

  set(slot: string, hash: string, value: unknown, now: number): void {
    this.sweep(now);
    while (this.entries.size >= MCP_ACTION_LIMITS.idempotencyEntries)
      this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(slot, { hash, value, at: now });
  }
}

interface Done {
  value: unknown;
  result: 'ok' | 'dry_run';
  details: McpAuditDetails;
  replayed: boolean;
}

/**
 * gaulatti/alcantara#212: runs every W, A and D spec in the pinned order:
 * parse, rate limit, dry run, confirm, idempotency, attribution, run, audit.
 * The registry has already checked the permission and, for A and D, asked
 * Pompeii again; neither is repeated here. A call that is refused, or that
 * only plans (dry run), uses up no key, no allowance and no on-air spacing.
 */
@Injectable()
export class McpActionExecutor implements McpActionExecutorContract {
  private readonly audit = new Logger('McpAudit');
  private readonly limiter = new ActionLimiter();
  private readonly store = new IdempotencyStore();
  private readonly inFlight = new Map<
    string,
    { hash: string; settled: Promise<void> }
  >();

  constructor(
    private readonly metrics: ManagedMetricsService,
    @Optional()
    @Inject(MCP_ATTRIBUTION)
    private readonly attribution?: McpAttribution,
  ) {}

  async execute(
    spec: McpToolSpec,
    rawArgs: Record<string, unknown>,
    ctx: McpContext,
  ): Promise<unknown> {
    if (spec.tier === 'R')
      throw new Error('The action executor runs W, A and D specs only.');
    const identity = ctx.principal.principalId ?? ctx.principal.subject;
    const key = rawArgs.idempotency_key;
    const keyHash =
      typeof key === 'string' ? sha256(key).slice(0, 12) : undefined;
    const dry = rawArgs.dry_run === true;
    try {
      const done = await this.process(spec, spec.tier, rawArgs, ctx, identity);
      this.finish(spec, identity, keyHash, dry, done.result, done);
      return done.value;
    } catch (error) {
      this.finish(
        spec,
        identity,
        keyHash,
        dry,
        error instanceof McpToolError ? error.code : 'unavailable',
        undefined,
      );
      throw error;
    }
  }

  private finish(
    spec: McpToolSpec,
    identity: string,
    keyHash: string | undefined,
    dry: boolean,
    result: string,
    done: Done | undefined,
  ): void {
    this.metrics.recordMcpRequest(spec.name, spec.tier, result);
    // Ids, field names and counts only: never arguments, titles, confirm
    // strings or key values.
    this.audit.log(
      `mcp.action ${JSON.stringify({
        identity,
        tool: spec.name,
        tier: spec.tier,
        result,
        dry_run: dry,
        key: keyHash,
        replayed: done?.replayed ? true : undefined,
        target: done?.details.target,
        fields: done?.details.fields,
        count: done?.details.count,
      })}`,
    );
  }

  private async process(
    spec: McpToolSpec,
    tier: ActionTier,
    rawArgs: Record<string, unknown>,
    ctx: McpContext,
    identity: string,
  ): Promise<Done> {
    // 1. parse
    const parsed = z.object(actionShape(spec)).strict().safeParse(rawArgs);
    if (!parsed.success)
      throw new McpToolError('invalid', parsed.error.issues[0].message);
    const {
      dry_run: dryRunFlag,
      confirm,
      idempotency_key: key,
      ...args
    } = parsed.data as Record<string, unknown>;
    const dry = dryRunFlag === true;
    const hash = sha256(canonical(args));
    const slot = `${identity}\u0000${spec.name}\u0000${key as string}`;
    const program = typeof args.program_id === 'string' ? args.program_id : '';

    // 2. rate limit (check only; a stored outcome is replayed without it)
    const stored = dry ? undefined : this.store.get(slot, Date.now());
    if (!(stored && stored.hash === hash))
      this.limiter.check(identity, tier, program, dry, Date.now());

    // 3. dry run
    if (dry) {
      const plan = await spec.dryRun!(args, ctx);
      const target = spec.confirmTarget
        ? await spec.confirmTarget(args, ctx)
        : undefined;
      return {
        value: {
          dry_run: true,
          ...plan,
          ...(target ? { confirm: this.confirmString(target) } : {}),
        },
        result: 'dry_run',
        details: {
          ...(target ? { target: target.id } : {}),
          count: plan.affects.length,
        },
        replayed: false,
      };
    }

    // 4. confirm
    if (spec.confirmTarget) {
      const expected = this.confirmString(await spec.confirmTarget(args, ctx));
      if (confirm === undefined)
        throw new McpToolError(
          'confirm_required',
          'confirm is required: run with dry_run and echo the confirm string it returns.',
        );
      if (confirm !== expected)
        throw new McpToolError(
          'confirm_mismatch',
          'confirm does not match the target; run with dry_run again.',
        );
    }

    // 5. idempotency
    for (;;) {
      const hit = this.store.get(slot, Date.now());
      if (hit) {
        if (hit.hash !== hash) throw this.reuse();
        return {
          value: hit.value,
          result: 'ok',
          details: {},
          replayed: true,
        };
      }
      const pending = this.inFlight.get(slot);
      if (!pending) break;
      if (pending.hash !== hash) throw this.reuse();
      await pending.settled;
    }

    // Record the run only now: from here nothing awaits until it is in flight.
    this.limiter.consume(identity, tier, program, Date.now());
    let release!: () => void;
    this.inFlight.set(slot, {
      hash,
      settled: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    try {
      // 6. attribution, 7. run. Every tier is wrapped (#213): the actor is
      // read by the engine at command time, so a W that changes what is queued
      // (program_remove_queued_program_song_by_id) is attributed like an A or D,
      // and a W that reaches no operator record leaves nothing to read.
      const work = () => spec.run(args, ctx);
      const outcome = this.attribution
        ? await this.attribution.run(
            {
              principalId: ctx.principal.principalId,
              via: 'mcp',
              client: ctx.principal.client,
            },
            work,
          )
        : await work();
      // 8. store, after a successful run only
      this.store.set(slot, hash, outcome.result, Date.now());
      return {
        value: outcome.result,
        result: 'ok',
        details: outcome.audit,
        replayed: false,
      };
    } finally {
      this.inFlight.delete(slot);
      release();
    }
  }

  private confirmString(target: ConfirmTarget): string {
    return `${target.id} ${target.name}`;
  }

  private reuse(): McpToolError {
    return new McpToolError(
      'idempotency_reuse',
      'This idempotency_key was already used with different arguments.',
    );
  }
}
