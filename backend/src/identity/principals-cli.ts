import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  applicableChanges,
  formatPlan,
  hasConflicts,
  planMigration,
  type IdentityRow,
  type SubjectMapping,
} from './principals';

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
 * `mapped`, sets each canonical column conditionally on it still being null, and
 * never touches a subject column. It is therefore safe to re-run: a crash
 * part-way through resumes, and a completed run is a no-op.
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

async function collectRows(prisma: PrismaClient): Promise<IdentityRow[]> {
  const [preferences, layouts, invitations] = await Promise.all([
    prisma.operatorPreference.findMany({
      select: { deviceClass: true, principalId: true, subject: true },
    }),
    prisma.sharedConsoleLayout.findMany({
      select: { id: true, ownerPrincipalId: true, ownerSubject: true },
    }),
    prisma.guestInvitation.findMany({
      select: { createdByIdentity: true, createdByPrincipalId: true, id: true },
    }),
  ]);

  return [
    ...preferences.map((row) => ({
      id: `${row.subject}::${row.deviceClass}`,
      model: 'OperatorPreference' as const,
      principalId: row.principalId,
      subject: row.subject,
    })),
    ...layouts.map((row) => ({
      id: row.id,
      model: 'SharedConsoleLayout' as const,
      principalId: row.ownerPrincipalId,
      subject: row.ownerSubject,
    })),
    ...invitations.map((row) => ({
      id: row.id,
      model: 'GuestInvitation' as const,
      principalId: row.createdByPrincipalId,
      subject: row.createdByIdentity,
    })),
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
    console.error(
      'A verified subject-to-principal mapping file is required.',
    );
    process.exitCode = 2;
    return;
  }

  const mappings = readMappingFile(mappingPath);
  const prisma = new PrismaClient();
  try {
    const plan = planMigration(await collectRows(prisma), mappings);
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
        if (row.model === 'OperatorPreference') {
          const [subject, deviceClass] = row.id.split('::');
          await transaction.operatorPreference.updateMany({
            data: { principalId: row.principalId },
            where: { deviceClass, principalId: null, subject },
          });
        } else if (row.model === 'SharedConsoleLayout') {
          await transaction.sharedConsoleLayout.updateMany({
            data: { ownerPrincipalId: row.principalId },
            where: { id: row.id, ownerPrincipalId: null },
          });
        } else {
          // Audit only: createdByIdentity is never rewritten, so the historical
          // actor still displays exactly as it always did.
          await transaction.guestInvitation.updateMany({
            data: { createdByPrincipalId: row.principalId },
            where: { createdByPrincipalId: null, id: row.id },
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
