/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/no-unnecessary-type-assertion -- jest mocks are matched by reference; the casts name the mock types. */
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  MCP_REQUEST_RESULTS,
  McpToolError,
  type McpAttribution,
  type McpContext,
  type McpToolSpec,
  type McpTier,
} from './contract';
import { McpActionExecutor } from './mcp-action.executor';
import { MCP_ACTION_LIMITS } from './mcp.constants';

const START = 1_700_000_000_000;
const KEY = 'key-aaaaaaaa';

const principal = (id: string | null = 'principal-1', subject = 'subject-1') =>
  ({
    subject,
    principalId: id,
    permissions: new Set([ALCANTARA_PERMISSIONS.access]),
    client: 'test-client',
  }) as McpContext['principal'];
const ctxFor = (id: string | null = 'principal-1', subject?: string) =>
  ({ principal: principal(id, subject) }) as McpContext;

interface Fake {
  spec: McpToolSpec;
  runs: Array<Record<string, unknown>>;
  events: string[];
}

/** A fake spec of one tier; A and D have a dry run and a confirm target. */
function fake(
  tier: Exclude<McpTier, 'R'>,
  options: {
    name?: string;
    dryRun?: boolean;
    confirm?: boolean;
    run?: () => Promise<unknown>;
  } = {},
): Fake {
  const runs: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const withTarget = options.confirm ?? tier !== 'W';
  const spec: McpToolSpec = {
    name: options.name ?? `fake_${tier.toLowerCase()}`,
    title: 'Fake',
    description: 'A fake action.',
    permission: ALCANTARA_PERMISSIONS.access,
    tier,
    firstClass: true,
    shape: {
      program_id: z.string().optional(),
      title: z.string().optional(),
      n: z.number().optional(),
      tags: z.array(z.string()).optional(),
      meta: z
        .object({
          a: z.number().optional(),
          b: z.string().nullable().optional(),
        })
        .optional(),
    },
    ...(options.dryRun === false
      ? {}
      : {
          dryRun: (args) => {
            events.push('dryRun');
            return Promise.resolve({
              summary: 'plan',
              affects: [{ kind: 'song', id: 's1', name: String(args.title) }],
              recoverable: true,
              onAir: tier === 'A',
            });
          },
        }),
    ...(withTarget
      ? {
          confirmTarget: (args) => {
            events.push('confirmTarget');
            return Promise.resolve({
              id: 'target-1',
              name: `Name of ${String(args.title)}`,
            });
          },
        }
      : {}),
    run: async (args) => {
      events.push('run');
      runs.push(args);
      if (options.run) await options.run();
      return {
        result: { done: runs.length, title: args.title },
        audit: { target: 'target-1', fields: ['title'], count: 1 },
      };
    },
  };
  return { spec, runs, events };
}

const confirmFor = (title: unknown) => `target-1 Name of ${String(title)}`;

describe('McpActionExecutor', () => {
  let metrics: ManagedMetricsService;
  let attribution: jest.Mocked<McpAttribution> | undefined;
  let lines: string[];
  let executor: McpActionExecutor;

  const make = () => {
    executor = new McpActionExecutor(metrics, attribution);
  };
  const names = [
    'fake_w',
    'fake_a',
    'fake_d',
    'fake_w2',
    'fake_a2',
    'fake_nodry',
  ];

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    lines = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    metrics = new ManagedMetricsService();
    metrics.registerMcpTools(names);
    attribution = undefined;
    make();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const advance = (ms: number) => jest.advanceTimersByTime(ms);
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as McpToolError;
    }
    throw new Error('expected a refusal');
  };
  const audits = () =>
    lines
      .filter((line) => line.startsWith('mcp.action '))
      .map(
        (line) =>
          JSON.parse(line.slice('mcp.action '.length)) as Record<
            string,
            unknown
          >,
      );

  describe('parse', () => {
    it('refuses a missing, short, long or malformed idempotency key as invalid', async () => {
      const { spec, runs } = fake('W');
      for (const bad of [
        undefined,
        'short',
        'x'.repeat(129),
        'has space 123',
        42,
      ]) {
        const error = await code(
          executor.execute(
            spec,
            bad === undefined ? {} : { idempotency_key: bad },
            ctxFor(),
          ),
        );
        expect(error.code).toBe('invalid');
      }
      expect(runs).toHaveLength(0);
    });

    it('accepts the whole key alphabet at both length bounds', async () => {
      const { spec } = fake('W');
      for (const ok of ['a.b_c:d-E1', 'A'.repeat(128)])
        await expect(
          executor.execute(spec, { idempotency_key: ok }, ctxFor()),
        ).resolves.toBeDefined();
    });

    it('refuses unknown arguments and a bad domain argument', async () => {
      const { spec } = fake('W');
      expect(
        (
          await code(
            executor.execute(
              spec,
              { idempotency_key: KEY, surprise: 1 },
              ctxFor(),
            ),
          )
        ).code,
      ).toBe('invalid');
      expect(
        (
          await code(
            executor.execute(spec, { idempotency_key: KEY, n: 'x' }, ctxFor()),
          )
        ).code,
      ).toBe('invalid');
    });

    it('accepts dry_run and confirm only where the spec has them', async () => {
      const { spec: noDry } = fake('W', { dryRun: false });
      const error = await code(
        executor.execute(
          noDry,
          { idempotency_key: KEY, dry_run: true },
          ctxFor(),
        ),
      );
      expect(error.code).toBe('invalid');
      const { spec: noConfirm } = fake('W');
      expect(
        (
          await code(
            executor.execute(
              noConfirm,
              { idempotency_key: KEY, confirm: 'x' },
              ctxFor(),
            ),
          )
        ).code,
      ).toBe('invalid');
    });

    it('is a programming error to hand it an R spec', async () => {
      const read = { ...fake('W').spec, tier: 'R' as const };
      await expect(
        executor.execute(read, { idempotency_key: KEY }, ctxFor()),
      ).rejects.toThrow('W, A and D specs only');
    });
  });

  describe('order of checks', () => {
    it('parses before the rate limit, the rate limit before confirm, and confirm before the run', async () => {
      const a = fake('A');
      for (let i = 0; i < 6; i++) {
        await executor.execute(
          a.spec,
          {
            idempotency_key: `key-0000000${i}`,
            program_id: `p${i}`,
            title: 't',
            confirm: confirmFor('t'),
          },
          ctxFor(),
        );
      }
      // The limit is spent: a call with no confirm is refused by the limit first.
      const limited = await code(
        executor.execute(
          a.spec,
          { idempotency_key: 'key-00000009', program_id: 'p9', title: 't' },
          ctxFor(),
        ),
      );
      expect(limited.code).toBe('rate_limited');
      // A malformed call is refused by parse, before the limit is consulted.
      const invalid = await code(
        executor.execute(a.spec, { program_id: 'p9' }, ctxFor()),
      );
      expect(invalid.code).toBe('invalid');
      advance(MCP_ACTION_LIMITS.windowMs);
      // Past the limit, confirm is next, and only then idempotency and the run.
      a.events.length = 0;
      const missing = await code(
        executor.execute(
          a.spec,
          { idempotency_key: 'key-00000009', title: 't' },
          ctxFor(),
        ),
      );
      expect(missing.code).toBe('confirm_required');
      expect(a.events).toEqual(['confirmTarget']);
      await executor.execute(
        a.spec,
        {
          idempotency_key: 'key-00000009',
          title: 't',
          confirm: confirmFor('t'),
        },
        ctxFor(),
      );
      expect(a.events).toEqual(['confirmTarget', 'confirmTarget', 'run']);
    });

    it('dry runs before confirm, and confirm before idempotency', async () => {
      const a = fake('A');
      const args = { idempotency_key: KEY, title: 't' };
      await executor.execute(a.spec, args, ctxFor()).catch(() => undefined);
      await executor.execute(
        a.spec,
        { ...args, confirm: confirmFor('t') },
        ctxFor(),
      );
      advance(MCP_ACTION_LIMITS.onAirSpacingMs);
      // A wrong confirm is refused even though the key is stored.
      const refused = await code(
        executor.execute(a.spec, { ...args, confirm: 'nope' }, ctxFor()),
      );
      expect(refused.code).toBe('confirm_mismatch');
      expect(a.runs).toHaveLength(1);
    });
  });

  describe('dry run', () => {
    it('writes nothing, returns the plan and the exact confirm string, and consumes nothing', async () => {
      const a = fake('A');
      const dry = (await executor.execute(
        a.spec,
        { idempotency_key: KEY, title: 'T', dry_run: true, program_id: 'p1' },
        ctxFor(),
      )) as Record<string, unknown>;
      expect(dry).toEqual({
        dry_run: true,
        summary: 'plan',
        affects: [{ kind: 'song', id: 's1', name: 'T' }],
        recoverable: true,
        onAir: true,
        confirm: 'target-1 Name of T',
      });
      expect(a.runs).toHaveLength(0);
      // Same key, straight away, on the same program: the key is unused, the
      // spacing untouched, the allowance intact.
      const real = (await executor.execute(
        a.spec,
        {
          idempotency_key: KEY,
          title: 'T',
          program_id: 'p1',
          confirm: dry.confirm,
        },
        ctxFor(),
      )) as Record<string, unknown>;
      expect(real).toEqual({ done: 1, title: 'T' });
    });

    it('does not count A dry runs against the minute or the spacing', async () => {
      const a = fake('A');
      for (let i = 0; i < 12; i++)
        await executor.execute(
          a.spec,
          { idempotency_key: `key-0000000${i}`, title: 't', dry_run: true },
          ctxFor(),
        );
      for (let i = 0; i < 6; i++) {
        await executor.execute(
          a.spec,
          {
            idempotency_key: `key-1000000${i}`,
            title: 't',
            program_id: `p${i}`,
            confirm: confirmFor('t'),
          },
          ctxFor(),
        );
      }
      expect(a.runs).toHaveLength(6);
    });

    it('lets a dry run through the on-air spacing', async () => {
      const a = fake('A');
      const base = { title: 't', program_id: 'p1' };
      await executor.execute(
        a.spec,
        { ...base, idempotency_key: 'key-20000000', confirm: confirmFor('t') },
        ctxFor(),
      );
      // Within 10 s of a real run on the program, planning is still allowed.
      await expect(
        executor.execute(
          a.spec,
          { ...base, idempotency_key: 'key-20000001', dry_run: true },
          ctxFor(),
        ),
      ).resolves.toMatchObject({ dry_run: true });
      expect(a.runs).toHaveLength(1);
    });

    it('checks the minute for a dry run too, without recording it', async () => {
      const d = fake('D');
      for (let i = 0; i < 3; i++)
        await executor.execute(
          d.spec,
          {
            idempotency_key: `key-3000000${i}`,
            title: 't',
            confirm: confirmFor('t'),
          },
          ctxFor(),
        );
      const error = await code(
        executor.execute(
          d.spec,
          { idempotency_key: 'key-30000009', title: 't', dry_run: true },
          ctxFor(),
        ),
      );
      expect(error.code).toBe('rate_limited');
    });

    it('has no confirm string when the spec has no confirm target', async () => {
      const w = fake('W');
      const dry = (await executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 'T', dry_run: true },
        ctxFor(),
      )) as Record<string, unknown>;
      expect(dry).not.toHaveProperty('confirm');
      expect(w.runs).toHaveLength(0);
    });
  });

  describe('confirm', () => {
    it('refuses a missing and a wrong confirm, and neither uses up the spacing or the minute', async () => {
      const a = fake('A');
      const base = { title: 't', program_id: 'p1' };
      for (let i = 0; i < 10; i++) {
        const missing = await code(
          executor.execute(
            a.spec,
            { ...base, idempotency_key: `key-4000000${i}` },
            ctxFor(),
          ),
        );
        expect(missing.code).toBe('confirm_required');
        const wrong = await code(
          executor.execute(
            a.spec,
            { ...base, idempotency_key: `key-4000000${i}`, confirm: 'x' },
            ctxFor(),
          ),
        );
        expect(wrong.code).toBe('confirm_mismatch');
      }
      expect(a.runs).toHaveLength(0);
      // The key was not consumed and nothing counted: a right confirm runs now.
      await executor.execute(
        a.spec,
        { ...base, idempotency_key: 'key-40000000', confirm: confirmFor('t') },
        ctxFor(),
      );
      expect(a.runs).toHaveLength(1);
    });

    it('requires the confirm of D as well as A, and none of W', async () => {
      const d = fake('D');
      const error = await code(
        executor.execute(
          d.spec,
          { idempotency_key: KEY, title: 't' },
          ctxFor(),
        ),
      );
      expect(error.code).toBe('confirm_required');
      const w = fake('W');
      await executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 't' },
        ctxFor(),
      );
      expect(w.events).not.toContain('confirmTarget');
    });
  });

  describe('idempotency', () => {
    const args = (extra: Record<string, unknown> = {}) => ({
      idempotency_key: KEY,
      title: 't',
      confirm: confirmFor('t'),
      ...extra,
    });

    it('returns the stored outcome for a retried key, without running or consuming anything', async () => {
      const a = fake('A');
      const first = await executor.execute(
        a.spec,
        args({ program_id: 'p1' }),
        ctxFor(),
      );
      const retry = await executor.execute(
        a.spec,
        // Same arguments in another order.
        {
          program_id: 'p1',
          confirm: confirmFor('t'),
          title: 't',
          idempotency_key: KEY,
        },
        ctxFor(),
      );
      expect(retry).toEqual(first);
      expect(a.runs).toHaveLength(1);
      // The retry, inside the 10 s spacing, was not refused and did not move it:
      advance(MCP_ACTION_LIMITS.onAirSpacingMs);
      await executor.execute(
        a.spec,
        args({ idempotency_key: 'key-other-1', program_id: 'p1' }),
        ctxFor(),
      );
      expect(a.runs).toHaveLength(2);
    });

    it('compares arrays, nested objects and nulls by value, whatever the key order', async () => {
      const w = fake('W');
      const first = {
        idempotency_key: KEY,
        tags: ['a', 'b'],
        meta: { a: 1, b: null },
      };
      await executor.execute(w.spec, first, ctxFor());
      await executor.execute(
        w.spec,
        { meta: { b: null, a: 1 }, tags: ['a', 'b'], idempotency_key: KEY },
        ctxFor(),
      );
      expect(w.runs).toHaveLength(1);
      for (const different of [
        { tags: ['b', 'a'], meta: { a: 1, b: null } },
        { tags: ['a', 'b'], meta: { a: 1, b: 'x' } },
        { tags: ['a', 'b'], meta: { a: 1 } },
      ])
        expect(
          (
            await code(
              executor.execute(
                w.spec,
                { idempotency_key: KEY, ...different },
                ctxFor(),
              ),
            )
          ).code,
        ).toBe('idempotency_reuse');
    });

    it('refuses the same key with different arguments as idempotency_reuse', async () => {
      const w = fake('W');
      await executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 'one' },
        ctxFor(),
      );
      const error = await code(
        executor.execute(
          w.spec,
          { idempotency_key: KEY, title: 'two' },
          ctxFor(),
        ),
      );
      expect(error.code).toBe('idempotency_reuse');
      expect(w.runs).toHaveLength(1);
    });

    it('scopes a key to its identity and to its tool', async () => {
      const w = fake('W');
      const w2 = fake('W', { name: 'fake_w2' });
      const same = { idempotency_key: KEY, title: 't' };
      await executor.execute(w.spec, same, ctxFor('principal-1'));
      // Another identity: not a hit, even with the same key and arguments.
      await executor.execute(w.spec, same, ctxFor('principal-2'));
      expect(w.runs).toHaveLength(2);
      // Another tool: not a hit either.
      await executor.execute(w2.spec, same, ctxFor('principal-1'));
      expect(w2.runs).toHaveLength(1);
      // Another identity with different arguments is not a reuse.
      await expect(
        executor.execute(
          w.spec,
          { idempotency_key: KEY, title: 'other' },
          ctxFor('principal-3'),
        ),
      ).resolves.toBeDefined();
    });

    it('keys an identity without a principal id by its subject', async () => {
      const w = fake('W');
      const same = { idempotency_key: KEY, title: 't' };
      await executor.execute(w.spec, same, ctxFor(null, 'sub-a'));
      await executor.execute(w.spec, same, ctxFor(null, 'sub-a'));
      await executor.execute(w.spec, same, ctxFor(null, 'sub-b'));
      expect(w.runs).toHaveLength(2);
      expect(audits()[0].identity).toBe('sub-a');
    });

    it('does not store a failed run: the key is free again', async () => {
      let fail = true;
      const w = fake('W', {
        run: () =>
          fail ? Promise.reject(new Error('database down')) : Promise.resolve(),
      });
      const same = { idempotency_key: KEY, title: 't' };
      await expect(executor.execute(w.spec, same, ctxFor())).rejects.toThrow(
        'database down',
      );
      fail = false;
      await expect(executor.execute(w.spec, same, ctxFor())).resolves.toEqual({
        done: 2,
        title: 't',
      });
      expect(audits().map((line) => line.result)).toEqual([
        'unavailable',
        'ok',
      ]);
    });

    it('stores nothing for a refusal thrown by the run, either', async () => {
      let fail = true;
      const w = fake('W', {
        run: () =>
          fail
            ? Promise.reject(new McpToolError('stale_target', 'changed'))
            : Promise.resolve(),
      });
      const same = { idempotency_key: KEY, title: 't' };
      expect((await code(executor.execute(w.spec, same, ctxFor()))).code).toBe(
        'stale_target',
      );
      fail = false;
      await executor.execute(w.spec, same, ctxFor());
      expect(w.runs).toHaveLength(2);
    });

    it('forgets an outcome after 10 minutes', async () => {
      const w = fake('W');
      const same = { idempotency_key: KEY, title: 't' };
      await executor.execute(w.spec, same, ctxFor());
      advance(MCP_ACTION_LIMITS.idempotencyTtlMs - 1);
      await executor.execute(w.spec, same, ctxFor());
      expect(w.runs).toHaveLength(1);
      advance(1);
      await executor.execute(w.spec, same, ctxFor());
      expect(w.runs).toHaveLength(2);
    });

    it('holds a bounded number of outcomes, evicting the oldest', async () => {
      const w = fake('W');
      const same = { idempotency_key: KEY, title: 't' };
      await executor.execute(w.spec, same, ctxFor('first'));
      for (let i = 1; i < MCP_ACTION_LIMITS.idempotencyEntries; i++)
        await executor.execute(w.spec, same, ctxFor(`who-${i}`));
      // Full, and the first is still held.
      await executor.execute(w.spec, same, ctxFor('first'));
      expect(w.runs).toHaveLength(MCP_ACTION_LIMITS.idempotencyEntries);
      // One more evicts the oldest (the first), and only that one.
      await executor.execute(w.spec, same, ctxFor('one-more'));
      await executor.execute(w.spec, same, ctxFor('who-1'));
      expect(w.runs).toHaveLength(MCP_ACTION_LIMITS.idempotencyEntries + 1);
      await executor.execute(w.spec, same, ctxFor('first'));
      expect(w.runs).toHaveLength(MCP_ACTION_LIMITS.idempotencyEntries + 2);
    });

    it('runs two simultaneous calls with one key once, and answers both alike', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const w = fake('W', { run: () => gate });
      const same = { idempotency_key: KEY, title: 't' };
      const first = executor.execute(w.spec, same, ctxFor());
      const second = executor.execute(w.spec, same, ctxFor());
      const clash = executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 'other' },
        ctxFor(),
      );
      expect((await code(clash)).code).toBe('idempotency_reuse');
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(w.runs).toHaveLength(1);
    });

    it('lets a waiting call run itself when the first one failed', async () => {
      let fail = true;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const w = fake('W', {
        run: async () => {
          await gate;
          if (fail) {
            fail = false;
            throw new Error('database down');
          }
        },
      });
      const same = { idempotency_key: KEY, title: 't' };
      const first = executor.execute(w.spec, same, ctxFor());
      const second = executor.execute(w.spec, same, ctxFor());
      release();
      await expect(first).rejects.toThrow('database down');
      await expect(second).resolves.toEqual({ done: 2, title: 't' });
    });
  });

  describe('rate limits', () => {
    const w = (i: number, extra: Record<string, unknown> = {}) => ({
      idempotency_key: `key-w-${String(i).padStart(5, '0')}`,
      title: 't',
      ...extra,
    });

    it('allows 60 writes a minute per identity, then refuses with the time to wait', async () => {
      const f = fake('W');
      for (let i = 0; i < 60; i++) {
        await executor.execute(f.spec, w(i), ctxFor());
        advance(500);
      }
      const error = await code(executor.execute(f.spec, w(99), ctxFor()));
      expect(error.code).toBe('rate_limited');
      // The first run was 30 s ago: 30 s left.
      expect(error.retryAfterSeconds).toBe(30);
      // Another identity is not affected.
      await executor.execute(f.spec, w(99), ctxFor('principal-2'));
      advance(30_000);
      await executor.execute(f.spec, w(99), ctxFor());
      // A refusal did not extend the window.
      expect(f.runs).toHaveLength(62);
    });

    it('allows 6 on-air actions a minute, 10 seconds apart per program', async () => {
      const f = fake('A');
      const a = (i: number, program: string) => ({
        idempotency_key: `key-a-${String(i).padStart(5, '0')}`,
        title: 't',
        program_id: program,
        confirm: confirmFor('t'),
      });
      await executor.execute(f.spec, a(0, 'p1'), ctxFor());
      advance(3_200);
      const tooSoon = await code(
        executor.execute(f.spec, a(1, 'p1'), ctxFor()),
      );
      expect(tooSoon.code).toBe('rate_limited');
      expect(tooSoon.retryAfterSeconds).toBe(7);
      // Another program is not held by it, nor is another identity.
      await executor.execute(f.spec, a(1, 'p2'), ctxFor());
      await executor.execute(f.spec, a(1, 'p1'), ctxFor('principal-2'));
      // No program at all is a program of its own.
      const bare = (i: number) => ({
        idempotency_key: `key-b-${String(i).padStart(5, '0')}`,
        title: 't',
        confirm: confirmFor('t'),
      });
      await executor.execute(f.spec, bare(0), ctxFor());
      expect(
        (await code(executor.execute(f.spec, bare(1), ctxFor()))).code,
      ).toBe('rate_limited');
      advance(10_000);
      await executor.execute(f.spec, a(2, 'p1'), ctxFor());
      advance(10_000);
      await executor.execute(f.spec, a(3, 'p1'), ctxFor());
      // Six runs by this identity inside the minute so far (p1, p2, bare, p1, p1) is five:
      advance(10_000);
      await executor.execute(f.spec, a(4, 'p1'), ctxFor());
      expect(f.runs).toHaveLength(7);
      advance(10_000);
      const sixth = await code(executor.execute(f.spec, a(5, 'p1'), ctxFor()));
      expect(sixth.code).toBe('rate_limited');
      // The oldest of the six is 43.2 s old: 17 s until the minute frees it.
      expect(sixth.retryAfterSeconds).toBe(17);
    });

    it('allows 3 destructive actions a minute', async () => {
      const f = fake('D');
      const d = (i: number) => ({
        idempotency_key: `key-d-${String(i).padStart(5, '0')}`,
        title: 't',
        confirm: confirmFor('t'),
      });
      for (let i = 0; i < 3; i++)
        await executor.execute(f.spec, d(i), ctxFor());
      const error = await code(executor.execute(f.spec, d(3), ctxFor()));
      expect(error.code).toBe('rate_limited');
      expect(error.retryAfterSeconds).toBe(60);
      advance(60_000);
      await executor.execute(f.spec, d(3), ctxFor());
    });

    it('keeps each tier in its own window', async () => {
      const d = fake('D');
      const a = fake('A');
      for (let i = 0; i < 3; i++)
        await executor.execute(
          d.spec,
          {
            idempotency_key: `key-e-0000${i}`,
            title: 't',
            confirm: confirmFor('t'),
          },
          ctxFor(),
        );
      await executor.execute(
        a.spec,
        {
          idempotency_key: 'key-e-0000a',
          title: 't',
          confirm: confirmFor('t'),
        },
        ctxFor(),
      );
      expect(a.runs).toHaveLength(1);
    });

    it('counts a failed run, which did act on the system', async () => {
      const f = fake('D', {
        run: () => Promise.reject(new Error('database down')),
      });
      for (let i = 0; i < 3; i++)
        await executor
          .execute(
            f.spec,
            {
              idempotency_key: `key-f-0000${i}`,
              title: 't',
              confirm: confirmFor('t'),
            },
            ctxFor(),
          )
          .catch(() => undefined);
      expect(
        (
          await code(
            executor.execute(
              f.spec,
              {
                idempotency_key: 'key-f-0000x',
                title: 't',
                confirm: confirmFor('t'),
              },
              ctxFor(),
            ),
          )
        ).code,
      ).toBe('rate_limited');
    });

    it('refuses at the moment of the run when another call spent the allowance meanwhile', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = fake('D', { run: () => gate });
      const d = (i: number) => ({
        idempotency_key: `key-g-0000${i}`,
        title: 't',
        confirm: confirmFor('t'),
      });
      // Three calls pass the early check together; only three may run.
      const calls = [0, 1, 2, 3].map((i) =>
        executor.execute(f.spec, d(i), ctxFor()),
      );
      const settled = calls.map((call) =>
        call.then(
          () => 'ran',
          (e: McpToolError) => e.code,
        ),
      );
      release();
      expect(await Promise.all(settled)).toEqual([
        'ran',
        'ran',
        'ran',
        'rate_limited',
      ]);
    });
  });

  describe('attribution', () => {
    it('wraps the run of a W, an A and a D with the actor, on the same path', async () => {
      attribution = {
        run: jest.fn(<T>(_actor: unknown, work: () => Promise<T>) => work()),
      } as unknown as jest.Mocked<McpAttribution>;
      make();
      const w = fake('W');
      const a = fake('A');
      const d = fake('D');
      await executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 't', dry_run: true },
        ctxFor(),
      );
      expect(attribution!.run).not.toHaveBeenCalled();
      await executor.execute(
        w.spec,
        { idempotency_key: KEY, title: 't' },
        ctxFor(),
      );
      expect(attribution!.run).toHaveBeenCalledTimes(1);
      for (const f of [a, d])
        await executor.execute(
          f.spec,
          { idempotency_key: KEY, title: 't', confirm: confirmFor('t') },
          ctxFor(),
        );
      expect(attribution!.run).toHaveBeenCalledTimes(3);
      expect(attribution!.run).toHaveBeenCalledWith(
        { principalId: 'principal-1', via: 'mcp', client: 'test-client' },
        expect.any(Function),
      );
      expect(w.runs).toHaveLength(1);
      expect(a.runs).toHaveLength(1);
    });

    it('passes a null principal id through, and does not attribute a dry run or a replay', async () => {
      attribution = {
        run: jest.fn(<T>(_actor: unknown, work: () => Promise<T>) => work()),
      } as unknown as jest.Mocked<McpAttribution>;
      make();
      const a = fake('A');
      const args = {
        idempotency_key: KEY,
        title: 't',
        confirm: confirmFor('t'),
      };
      await executor.execute(a.spec, { ...args, dry_run: true }, ctxFor(null));
      expect(attribution!.run).not.toHaveBeenCalled();
      await executor.execute(a.spec, args, ctxFor(null));
      await executor.execute(a.spec, args, ctxFor(null));
      expect(attribution!.run).toHaveBeenCalledTimes(1);
      expect(attribution!.run).toHaveBeenCalledWith(
        { principalId: null, via: 'mcp', client: 'test-client' },
        expect.any(Function),
      );
    });

    it('runs directly when nothing is bound', async () => {
      const a = fake('A');
      await executor.execute(
        a.spec,
        { idempotency_key: KEY, title: 't', confirm: confirmFor('t') },
        ctxFor(),
      );
      expect(a.runs).toHaveLength(1);
    });
  });

  describe('audit', () => {
    it('records identity, tool, tier, result and the spec details, never argument text', async () => {
      const a = fake('A');
      const secretTitle = 'PLANTED-TITLE-do-not-log';
      const confirm = confirmFor(secretTitle);
      const args = {
        idempotency_key: 'key-secret-value-1',
        title: secretTitle,
        program_id: 'p1',
        confirm,
      };
      await executor.execute(a.spec, { ...args, dry_run: true }, ctxFor());
      await code(
        executor.execute(a.spec, { ...args, confirm: 'wrong' }, ctxFor()),
      );
      await executor.execute(a.spec, args, ctxFor());
      await executor.execute(a.spec, args, ctxFor());
      const rows = audits();
      expect(rows).toEqual([
        {
          identity: 'principal-1',
          tool: 'fake_a',
          tier: 'A',
          result: 'dry_run',
          dry_run: true,
          key: expect.stringMatching(/^[0-9a-f]{12}$/),
          target: 'target-1',
          count: 1,
        },
        expect.objectContaining({ result: 'confirm_mismatch', dry_run: false }),
        {
          identity: 'principal-1',
          tool: 'fake_a',
          tier: 'A',
          result: 'ok',
          dry_run: false,
          key: rows[0].key,
          target: 'target-1',
          fields: ['title'],
          count: 1,
        },
        expect.objectContaining({ result: 'ok', replayed: true }),
      ]);
      for (const line of lines) {
        expect(line).not.toContain(secretTitle);
        expect(line).not.toContain('key-secret-value-1');
        expect(line).not.toContain('wrong');
        expect(line).not.toContain('Name of');
      }
      expect(lines.every((line) => line.startsWith('mcp.action '))).toBe(true);
    });

    it('logs a parse refusal with no key when there is none, and a hash when there is one', async () => {
      const w = fake('W');
      await code(executor.execute(w.spec, { title: 'PLANTED' }, ctxFor()));
      await code(
        executor.execute(
          w.spec,
          { idempotency_key: 'bad key!!', title: 'PLANTED' },
          ctxFor(),
        ),
      );
      const [none, hashed] = audits();
      expect(none).toEqual({
        identity: 'principal-1',
        tool: 'fake_w',
        tier: 'W',
        result: 'invalid',
        dry_run: false,
      });
      expect(hashed.key).toMatch(/^[0-9a-f]{12}$/);
      expect(lines.join('\n')).not.toContain('PLANTED');
      expect(lines.join('\n')).not.toContain('bad key');
    });
  });

  describe('metrics', () => {
    const samples = async () => {
      const text = await metrics.registry.metrics();
      return text
        .split('\n')
        .filter((line) => line.startsWith('alcantara_mcp_requests_total{'))
        .map((line) => {
          const match = /^alcantara_mcp_requests_total\{(.*)\} (\d+)$/.exec(
            line,
          )!;
          const labels = Object.fromEntries(
            [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
          );
          return { labels, value: Number(match[2]) };
        });
    };

    it('counts calls by registered tool, tier and closed result, with bounded labels', async () => {
      const w = fake('W');
      const a = fake('A');
      const stranger = fake('W', { name: 'planted_unregistered_tool' });
      const title = 'PLANTED-TITLE';
      await executor.execute(
        w.spec,
        { idempotency_key: 'identity-key-1', title },
        ctxFor('principal-xyz'),
      );
      await code(executor.execute(w.spec, { title }, ctxFor('principal-xyz')));
      await executor.execute(
        a.spec,
        { idempotency_key: 'identity-key-2', title, dry_run: true },
        ctxFor(),
      );
      await code(
        executor.execute(
          a.spec,
          { idempotency_key: 'identity-key-2', title },
          ctxFor(),
        ),
      );
      await executor.execute(
        stranger.spec,
        { idempotency_key: 'identity-key-3' },
        ctxFor(),
      );
      const rows = await samples();
      const text = JSON.stringify(rows);
      for (const secret of [title, 'identity-key', 'principal-xyz'])
        expect(text).not.toContain(secret);
      for (const { labels } of rows) {
        expect(Object.keys(labels).sort()).toEqual(['result', 'tier', 'tool']);
        expect([...names, 'unknown']).toContain(labels.tool);
        expect(['R', 'W', 'A', 'D']).toContain(labels.tier);
        expect(MCP_REQUEST_RESULTS as readonly string[]).toContain(
          labels.result,
        );
      }
      const count = (tool: string, tier: string, result: string) =>
        rows.find(
          (row) =>
            row.labels.tool === tool &&
            row.labels.tier === tier &&
            row.labels.result === result,
        )?.value;
      expect(count('fake_w', 'W', 'ok')).toBe(1);
      expect(count('fake_w', 'W', 'invalid')).toBe(1);
      expect(count('fake_a', 'A', 'dry_run')).toBe(1);
      expect(count('fake_a', 'A', 'confirm_required')).toBe(1);
      expect(count('unknown', 'W', 'ok')).toBe(1);
    });

    it('counts a failure that is not a refusal as unavailable', async () => {
      const f = fake('W', { run: () => Promise.reject(new Error('x')) });
      await executor
        .execute(f.spec, { idempotency_key: KEY, title: 't' }, ctxFor())
        .catch(() => undefined);
      expect(
        (await samples()).find((row) => row.labels.result === 'unavailable')
          ?.value,
      ).toBe(1);
    });

    it('ignores a tier or result outside the closed sets', async () => {
      metrics.recordMcpRequest('fake_w', 'Z', 'made-up');
      const [row] = await samples();
      expect(row.labels).toEqual({
        tool: 'fake_w',
        tier: 'unknown',
        result: 'unavailable',
      });
    });
  });
});
