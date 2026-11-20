import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  McpToolError,
  UNTRUSTED_NOTE,
  type ConfirmTarget,
  type DryRunResult,
  type McpErrorCode,
  type McpOutcome,
  type McpToolSpec,
} from '../contract';

/**
 * Shared pieces of the capability providers of gaulatti/alcantara#216:
 * argument types, the split of user-entered text under `untrusted`, the
 * credential tripwire and the mapping of a service refusal to a closed MCP
 * error code.
 */

/** A program id as the console sends it (the service trims and requires it). */
export const programIdArg = z.string().trim().min(1).max(128);
/** A numeric row id (scene, layout, media group, stinger). */
export const rowIdArg = z.number().int().positive();

/**
 * Keys whose values were typed by people or fetched from outside: names,
 * descriptions, chyron text, scene and layout settings, template manifests,
 * media addresses and flight items. They move, whole and unread, under an
 * `untrusted` key beside the fields they came from.
 */
const UNTRUSTED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'chyronText',
  'metadata',
  'settings',
  'templateUrl',
  'templateManifest',
  'imageUrl',
  'videoUrl',
  'items',
  'songSequence',
]);

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Moves every user-entered field of a service answer under `untrusted`. */
export function isolateUntrusted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(isolateUntrusted);
  if (!isPlain(value)) return value;
  const safe: Record<string, unknown> = {};
  const untrusted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    if (UNTRUSTED_KEYS.has(key)) untrusted[key] = item;
    else safe[key] = isolateUntrusted(item);
  return Object.keys(untrusted).length > 0 ? { ...safe, untrusted } : safe;
}

const CREDENTIAL_KEY =
  /^(token|secret|ticket|password|authorization|signature|credentials?|apikey)$/i;
const SIGNED_LINK =
  /X-Amz-(Signature|Credential)|[?&](token|ticket|signature|sig|access_token)=/i;

/**
 * A tripwire, not a filter: no capability of this area returns a ticket,
 * token, secret or signed link, so one found in an answer stops the answer.
 */
export function assertNoCredential(value: unknown): void {
  if (typeof value === 'string') {
    if (SIGNED_LINK.test(value))
      throw new McpToolError(
        'unavailable',
        'The answer was withheld: it carried a signed link.',
      );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key))
      throw new McpToolError(
        'unavailable',
        'The answer was withheld: it carried a credential field.',
      );
    assertNoCredential(item);
  }
}

/** The answer of every capability here: user text isolated, credentials refused. */
export function answer(raw: unknown): unknown {
  const result = isolateUntrusted(raw);
  assertNoCredential(result);
  return result;
}

const STATUS_CODES: Record<number, McpErrorCode> = {
  400: 'invalid',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

// A database refusal the console reports as a plain 500: a row that is not
// there, or one that something still points at.
const PRISMA_CODES: Record<string, [McpErrorCode, string]> = {
  P2025: ['not_found', 'The record is not there.'],
  P2003: ['conflict', 'Something still refers to this record.'],
  P2002: ['conflict', 'A record with that name already exists.'],
};

// Messages of the plain Errors the services throw; none carries user text.
const PLAIN_ERRORS: ReadonlyArray<[RegExp, McpErrorCode]> = [
  [/ not found$/, 'not_found'],
  [/ already exists$/, 'conflict'],
  [
    /^(Scene is not assigned to this program|programId is required)$/,
    'invalid',
  ],
];

/** The console's own refusal, as the closed MCP code; anything else is rethrown. */
export function refusal(error: unknown): never {
  if (error instanceof McpToolError) throw error;
  if (error instanceof HttpException) {
    const code = STATUS_CODES[error.getStatus()];
    if (code) throw new McpToolError(code, error.message);
  } else if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    PRISMA_CODES[error.code]
  ) {
    throw new McpToolError(...PRISMA_CODES[error.code]);
  } else if (error instanceof Error) {
    const known = PLAIN_ERRORS.find(([pattern]) => pattern.test(error.message));
    if (known) throw new McpToolError(known[1], error.message);
  }
  throw error;
}

/** Runs a service call and reports its refusals as MCP codes. */
export async function viaService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return refusal(error);
  }
}

export interface ReadDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  permission: McpToolSpec['permission'];
  shape: S;
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

/** A read capability: the service's answer, user text isolated, never a ticket. */
export function readSpec<S extends z.ZodRawShape>(
  def: ReadDef<S>,
): McpToolSpec {
  return {
    name: def.name,
    title: def.title,
    description: `${def.description} ${UNTRUSTED_NOTE}`,
    permission: def.permission,
    tier: 'R',
    firstClass: false,
    shape: def.shape,
    run: async (args): Promise<McpOutcome> => ({
      result: answer(await viaService(() => def.run(args as never))),
      audit: {},
    }),
  } as McpToolSpec;
}

export type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export interface Plan {
  summary: string;
  affects: DryRunResult['affects'];
  recoverable: boolean;
}

export interface ActionDef<S extends z.ZodRawShape, L> {
  name: string;
  title: string;
  description: string;
  permission: McpToolSpec['permission'];
  tier: 'W' | 'A' | 'D';
  shape: S;
  /** What the plan, the confirm target and the refusal are decided from. */
  load?: (args: Args<S>) => Promise<L>;
  /** The target id the audit and the confirm string carry. */
  id: (args: Args<S>, loaded: L) => string;
  /** The confirm name (A and D): it changes when the target changes. */
  label?: (args: Args<S>, loaded: L) => string;
  plan: (args: Args<S>, loaded: L) => Plan;
  /** D: why the target is on air, queued or in use; refused as `on_air`. */
  refuse?: (args: Args<S>, loaded: L) => string | null;
  /** W: the change shows on air at once. */
  onAir?: (args: Args<S>, loaded: L) => boolean;
  run: (args: Args<S>, loaded: L) => Promise<unknown>;
  /** The answer to return instead of the service's (when that is large). */
  result?: (raw: unknown, args: Args<S>) => unknown;
}

/**
 * A write capability. It loads what it decides from, plans (the dry run),
 * confirms against the target as it is now, refuses `on_air` when `refuse`
 * says so (checked again at run time, so a stale plan cannot cut a live
 * target), then calls the service.
 */
export function actionSpec<S extends z.ZodRawShape, L>(
  def: ActionDef<S, L>,
): McpToolSpec {
  const load = (args: Args<S>): Promise<L> =>
    viaService(() =>
      def.load ? def.load(args) : Promise.resolve(undefined as L),
    );
  const blocked = (args: Args<S>, loaded: L): string | null =>
    def.refuse ? def.refuse(args, loaded) : null;
  const spec = {
    name: def.name,
    title: def.title,
    description: `${def.description} ${UNTRUSTED_NOTE}`,
    permission: def.permission,
    tier: def.tier,
    firstClass: false,
    shape: def.shape,
    dryRun: async (args: Args<S>): Promise<DryRunResult> => {
      const loaded = await load(args);
      const plan = def.plan(args, loaded);
      const why = blocked(args, loaded);
      return {
        ...plan,
        summary:
          why === null
            ? plan.summary
            : `REFUSED (on_air): ${why}. ${plan.summary}`,
        onAir:
          def.tier === 'A' ||
          why !== null ||
          (def.onAir ? def.onAir(args, loaded) : false),
      };
    },
    run: async (args: Args<S>): Promise<McpOutcome> => {
      const loaded = await load(args);
      const why = blocked(args, loaded);
      if (why !== null) throw new McpToolError('on_air', why);
      const raw = await viaService(() => def.run(args, loaded));
      return {
        result: answer(def.result ? def.result(raw, args) : raw),
        audit: { target: def.id(args, loaded) },
      };
    },
  } as McpToolSpec;
  if (def.tier !== 'W')
    spec.confirmTarget = async (args): Promise<ConfirmTarget> => {
      const loaded = await load(args as Args<S>);
      return {
        id: def.id(args as Args<S>, loaded),
        name: def.label!(args as Args<S>, loaded),
      };
    };
  return spec;
}

/** The entries of a record whose value was given (an absent key is not a null one). */
export function present(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
