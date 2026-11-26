import type { PrismaClient } from '@prisma/client';
import { TENANCY_CLASSIFICATION } from './tenancy-classification';

/**
 * A database client confined to one tenant (a Pompeii team), for gaulatti/alcantara#150.
 * Nothing calls it yet: using it in a service or guard is a later step of #122.
 *
 * The tenant models are every model the tenancy classification of #149 calls `tenant`, which the ratchet requires to
 * have `teamId` (#148, #548), so a new tenant model is scoped without a second list. Rows written before #148 have no
 * `teamId` and are therefore no team's: nothing reads through this client until they are assigned.
 *
 * On a tenant model:
 * - reads, counts, updates and deletes keep the caller's `where` and add
 *   `teamId` to it with AND, so a caller cannot widen the scope;
 * - creates, and the create and update of an upsert, store this team's `teamId`
 *   whatever the caller supplied, and an update cannot move a row to another team;
 * - an upsert's `where` is scoped too, so an upsert aimed at another team's row
 *   finds nothing and creates a new row for this team, leaving the other team's
 *   row untouched. A caller that means "update or fail" should use update, which
 *   fails (P2025) on another team's row;
 * - nested relation reads and writes inside a call are not scoped;
 * - any other operation (aggregate, groupBy, the *OrThrow and *AndReturn forms)
 *   is refused rather than run unscoped.
 * Every other model passes through untouched. Raw SQL is not scoped.
 */
export const SCOPED_TENANT_MODELS: readonly string[] = Object.entries(
  TENANCY_CLASSIFICATION,
)
  .filter(([, tenancy]) => tenancy.kind === 'tenant')
  .map(([model]) => model);

type Args = Record<string, unknown>;

function scopedWhere(where: unknown, teamId: number): Args {
  const callerWhere = (where ?? {}) as Args;
  const callerAnd: unknown = callerWhere.AND;
  const and: unknown[] =
    callerAnd === undefined
      ? []
      : Array.isArray(callerAnd)
        ? (callerAnd as unknown[])
        : [callerAnd];
  return { ...callerWhere, AND: [...and, { teamId }] };
}

function ownedData(data: unknown, teamId: number): Args {
  return { ...(data as Args), teamId };
}

/** The arguments of one tenant-model operation, confined to the team. */
function scopeTenantArgs(operation: string, args: Args, teamId: number): Args {
  switch (operation) {
    case 'findMany':
    case 'findFirst':
    case 'findUnique':
    case 'count':
    case 'delete':
    case 'deleteMany':
      return { ...args, where: scopedWhere(args.where, teamId) };
    case 'update':
    case 'updateMany':
      return {
        ...args,
        where: scopedWhere(args.where, teamId),
        data: ownedData(args.data, teamId),
      };
    case 'create':
      return { ...args, data: ownedData(args.data, teamId) };
    case 'createMany': {
      const data = args.data;
      return {
        ...args,
        data: Array.isArray(data)
          ? data.map((row) => ownedData(row, teamId))
          : ownedData(data, teamId),
      };
    }
    case 'upsert':
      return {
        ...args,
        where: scopedWhere(args.where, teamId),
        create: ownedData(args.create, teamId),
        update: ownedData(args.update, teamId),
      };
    default:
      throw new Error(
        `Operation ${operation} is not scoped to a team and is refused on a tenant model.`,
      );
  }
}

/** The client confined to `teamId`; it rejects a team id that is not a positive integer. */
export function forTeam(prisma: PrismaClient, teamId: number) {
  if (!Number.isSafeInteger(teamId) || teamId <= 0) {
    throw new Error('A team id must be a positive integer.');
  }
  return prisma.$extends({
    name: `team-${teamId}`,
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!SCOPED_TENANT_MODELS.includes(model)) {
            return query(args);
          }
          return query(scopeTenantArgs(operation, args as Args, teamId));
        },
      },
    },
  });
}
