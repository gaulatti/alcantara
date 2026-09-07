import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  applicableChanges,
  formatPlan,
  hasConflicts,
  planMigration,
  type IdentityRow,
  type SubjectMapping,
} from './principals';
import { createPostgresAdapter } from '../prisma-adapter';

type CollectedIdentityRow = IdentityRow & {
  deviceClass?: string;
  details?: Record<string, Prisma.JsonValue>;
  sourceId: string;
};

/**
 * Reports and applies the migration of pool-local subject references to
 * canonical Pompeii principals.
 *
 *   pnpm principals:report ./mapping.json
 *   pnpm principals:apply  ./mapping.json
 *
 * The mapping file is a JSON array of `{ "subject": "...", "principalId": "..." }`
 * pairs obtained from Pompeii. Nothing here can derive one — identities are
 * never joined by email — and an entry that even contains an email is refused.
 *
 * `report` changes nothing. `apply` writes only rows the report classified
 * `mapped`, sets each canonical reference only while it is absent, and never
 * touches a subject value. It is therefore safe to re-run: a crash part-way
 * through resumes, and a completed run is a no-op.
 */

export function readMappingFile(path: string): SubjectMapping[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(
      'The mapping file must be a JSON array of {subject, principalId} pairs.',
    );
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Mapping entry ${index} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.subject !== 'string' ||
      typeof record.principalId !== 'string'
    ) {
      throw new Error(
        `Mapping entry ${index} needs a string subject and principalId.`,
      );
    }
    if ('email' in record) {
      throw new Error(
        `Mapping entry ${index} contains an email. Identity links come from Pompeii, never from an email address.`,
      );
    }
    return { principalId: record.principalId, subject: record.subject };
  });
}

function jsonObject(
  value: Prisma.JsonValue | null,
): Record<string, Prisma.JsonValue> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, Prisma.JsonValue>;
}

function preferenceReportId(subject: string, deviceClass: string): string {
  return `preference-${createHash('sha256')
    .update(subject)
    .update('\0')
    .update(deviceClass)
    .digest('hex')
    .slice(0, 16)}`;
}

async function collectRows(
  prisma: PrismaClient,
): Promise<CollectedIdentityRow[]> {
  const [preferences, layouts, invitations, events] = await Promise.all([
    prisma.operatorPreference.findMany({
      select: { deviceClass: true, principalId: true, subject: true },
    }),
    prisma.sharedConsoleLayout.findMany({
      select: { id: true, ownerPrincipalId: true, ownerSubject: true },
    }),
    prisma.guestInvitation.findMany({
      select: { createdByIdentity: true, createdByPrincipalId: true, id: true },
    }),
    prisma.guestEvent.findMany({
      select: { details: true, id: true },
    }),
  ]);

  return [
    ...preferences.map((row) => ({
      collisionScope: row.deviceClass,
      deviceClass: row.deviceClass,
      id: preferenceReportId(row.subject, row.deviceClass),
      model: 'OperatorPreference' as const,
      principalId: row.principalId,
      sourceId: row.subject,
      subject: row.subject,
    })),
    ...layouts.map((row) => ({
      id: row.id,
      model: 'SharedConsoleLayout' as const,
      principalId: row.ownerPrincipalId,
      sourceId: row.id,
      subject: row.ownerSubject,
    })),
    ...invitations.map((row) => ({
      id: row.id,
      model: 'GuestInvitation' as const,
      principalId: row.createdByPrincipalId,
      sourceId: row.id,
      subject: row.createdByIdentity,
    })),
    ...events.flatMap((row): CollectedIdentityRow[] => {
      const details = jsonObject(row.details);
      if (!details) return [];
      const subject = details.operatorIdentity;
      if (typeof subject !== 'string' || !subject.trim()) return [];
      const storedPrincipal = details.operatorPrincipalId;
      return [
        {
          details,
          id: row.id,
          model: 'GuestEvent',
          principalId:
            typeof storedPrincipal === 'string' && storedPrincipal.trim()
              ? storedPrincipal.trim()
              : null,
          sourceId: row.id,
          subject,
        },
      ];
    }),
  ];
}

async function main(): Promise<void> {
  const [mode, mappingPath, ...flags] = process.argv.slice(2);
  if (mode !== 'report' && mode !== 'apply') {
    console.error(
      'Usage: principals-cli <report|apply> <mapping.json> [--allow-conflicts]',
    );
    process.exitCode = 2;
    return;
  }
  if (!mappingPath) {
    console.error('A verified subject-to-principal mapping file is required.');
    process.exitCode = 2;
    return;
  }

  const mappings = readMappingFile(mappingPath);
  const prisma = new PrismaClient({
    adapter: createPostgresAdapter(process.env.DATABASE_URL),
  });
  try {
    const rows = await collectRows(prisma);
    const rowsByPlanId = new Map(
      rows.map((row) => [`${row.model}:${row.id}`, row]),
    );
    const plan = planMigration(rows, mappings);
    console.log(formatPlan(plan));

    if (mode === 'report') return;

    if (hasConflicts(plan) && !flags.includes('--allow-conflicts')) {
      console.error(
        '\nRefusing to apply while conflicts remain. Resolve them, or pass --allow-conflicts to migrate only the clean rows.',
      );
      process.exitCode = 1;
      return;
    }

    const changes = applicableChanges(plan);
    await prisma.$transaction(async (transaction) => {
      for (const row of changes) {
        if (row.principalId === null) continue;
        const source = rowsByPlanId.get(`${row.model}:${row.id}`);
        if (!source)
          throw new Error(`Migration source vanished for ${row.id}.`);
        if (row.model === 'OperatorPreference') {
          await transaction.operatorPreference.updateMany({
            data: { principalId: row.principalId },
            where: {
              deviceClass: source.deviceClass,
              principalId: null,
              subject: source.sourceId,
            },
          });
        } else if (row.model === 'SharedConsoleLayout') {
          await transaction.sharedConsoleLayout.updateMany({
            data: { ownerPrincipalId: row.principalId },
            where: { id: source.sourceId, ownerPrincipalId: null },
          });
        } else if (row.model === 'GuestInvitation') {
          // Audit only: createdByIdentity is never rewritten, so the historical
          // actor still displays exactly as it always did.
          await transaction.guestInvitation.updateMany({
            data: { createdByPrincipalId: row.principalId },
            where: { createdByPrincipalId: null, id: source.sourceId },
          });
        } else {
          const stored = await transaction.guestEvent.findUnique({
            select: { details: true },
            where: { id: source.sourceId },
          });
          const details = jsonObject(stored?.details ?? null);
          if (!details || details.operatorIdentity !== source.subject) {
            throw new Error(
              `GuestEvent ${row.id} changed after the dry run; retry the migration.`,
            );
          }
          const currentPrincipal = details.operatorPrincipalId;
          if (typeof currentPrincipal === 'string' && currentPrincipal.trim()) {
            continue;
          }
          await transaction.guestEvent.update({
            data: {
              details: {
                ...details,
                operatorPrincipalId: row.principalId,
              } as Prisma.InputJsonValue,
            },
            where: { id: source.sourceId },
          });
        }
      }
    });

    console.log(`\nApplied ${changes.length} canonical principal references.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
