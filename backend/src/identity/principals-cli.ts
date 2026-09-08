import { readFileSync, writeFileSync } from 'node:fs';
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
import { loadDatabaseSecret } from '../config/database-secrets';

type CollectedIdentityRow = IdentityRow & {
  deviceClass?: string;
  details?: Record<string, Prisma.JsonValue>;
  sourceId: string;
};

type ConsumerReference = {
  consumer: 'alcantara';
  reference: string;
  subject: string;
};

type ResolvedConsumerReference = ConsumerReference & {
  principalId: string | null;
};

type ProducerCollision = {
  consumer: string;
  principalIds: string[];
  reference: string;
};

export type PompeiiMigrationReport = {
  collisions: ProducerCollision[];
  missing: ResolvedConsumerReference[];
  references: ResolvedConsumerReference[];
};

type IdentityStore = Pick<
  Prisma.TransactionClient,
  | 'guestEvent'
  | 'guestInvitation'
  | 'operatorPreference'
  | 'sharedConsoleLayout'
>;

type CliDependencies = {
  bootstrapDatabase: () => Promise<void>;
  createPrisma: () => PrismaClient;
  error: (message: string) => void;
  log: (message: string) => void;
  writeReferences: (path: string, references: ConsumerReference[]) => void;
};

/**
 * Reports and applies the migration of pool-local subject references to
 * canonical Pompeii principals.
 *
 *   pnpm principals:export ./references.json
 *   pnpm principals:report ./pompeii-report.json
 *   pnpm principals:apply  ./pompeii-report.json
 *
 * `export` writes Pompeii's consumer-reference input contract. `report` and
 * `apply` consume Pompeii's complete migration report without manual reshaping.
 * Nothing here can derive an identity — identities are never joined by email.
 *
 * `report` changes nothing. `apply` writes only rows the report classified
 * `mapped`, sets each canonical reference only while it is absent, and never
 * touches a subject value. It is therefore safe to re-run: a crash part-way
 * through resumes, and a completed run is a no-op.
 */

function requiredString(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} needs a non-empty ${field}.`);
  }
  return value.trim();
}

function resolvedReference(
  entry: unknown,
  context: string,
): ResolvedConsumerReference {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${context} is not an object.`);
  }
  const record = entry as Record<string, unknown>;
  if ('email' in record) {
    throw new Error(
      `${context} contains an email. Identity links come from Pompeii, never from an email address.`,
    );
  }
  const principalId = record.principal_id;
  if (
    principalId !== undefined &&
    (typeof principalId !== 'string' || !principalId.trim())
  ) {
    throw new Error(`${context} has an invalid principal_id.`);
  }
  return {
    consumer: requiredString(record, 'consumer', context) as 'alcantara',
    reference: requiredString(record, 'reference', context),
    subject: requiredString(record, 'subject', context),
    principalId: typeof principalId === 'string' ? principalId.trim() : null,
  };
}

function producerCollision(entry: unknown, index: number): ProducerCollision {
  const context = `Pompeii collision ${index}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${context} is not an object.`);
  }
  const record = entry as Record<string, unknown>;
  if (
    !Array.isArray(record.principal_ids) ||
    record.principal_ids.length < 2 ||
    record.principal_ids.some(
      (value) => typeof value !== 'string' || !value.trim(),
    )
  ) {
    throw new Error(`${context} needs at least two principal_ids.`);
  }
  return {
    consumer: requiredString(record, 'consumer', context),
    reference: requiredString(record, 'reference', context),
    principalIds: record.principal_ids.map((value) => (value as string).trim()),
  };
}

export function readMigrationReportFile(path: string): PompeiiMigrationReport {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'The input must be a Pompeii principal-migration report object.',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.references) ||
    !Array.isArray(record.collisions) ||
    !Array.isArray(record.missing)
  ) {
    throw new Error(
      'The Pompeii report needs references, collisions, and missing arrays.',
    );
  }
  return {
    references: record.references.map((entry, index) =>
      resolvedReference(entry, `Pompeii reference ${index}`),
    ),
    collisions: record.collisions.map(producerCollision),
    missing: record.missing.map((entry, index) =>
      resolvedReference(entry, `Pompeii missing reference ${index}`),
    ),
  };
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

function migrationReference(row: IdentityRow): string {
  return `${row.model}:${row.id}`;
}

export function buildConsumerReferences(
  rows: readonly IdentityRow[],
): ConsumerReference[] {
  return rows.flatMap((row) => {
    const subject = row.subject?.trim();
    if (!subject) return [];
    return [
      {
        consumer: 'alcantara' as const,
        reference: migrationReference(row),
        subject,
      },
    ];
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    left.length === leftSet.size &&
    right.length === rightSet.size &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

/**
 * Verifies that a Pompeii report describes exactly the current Alcantara
 * inventory. This prevents a report for another consumer, a manually reshaped
 * mapping, or a stale partial export from reaching the apply path.
 */
export function mappingsFromMigrationReport(
  report: PompeiiMigrationReport,
  rows: readonly IdentityRow[],
): SubjectMapping[] {
  const expectedReferences = buildConsumerReferences(rows);
  const expectedByReference = new Map(
    expectedReferences.map((reference) => [reference.reference, reference]),
  );
  if (expectedByReference.size !== expectedReferences.length) {
    throw new Error(
      'The Alcantara migration inventory has duplicate references.',
    );
  }

  const seenReferences = new Set<string>();
  const seenEntries = new Set<string>();
  const resolvedByReference = new Map<string, ResolvedConsumerReference[]>();
  for (const reference of report.references) {
    if (reference.consumer !== 'alcantara') {
      throw new Error('The Pompeii report contains a non-Alcantara consumer.');
    }
    const expected = expectedByReference.get(reference.reference);
    if (!expected) {
      throw new Error(
        'The Pompeii report contains an unknown Alcantara reference.',
      );
    }
    if (reference.subject !== expected.subject) {
      throw new Error(
        'The Pompeii report subject does not match the current Alcantara reference.',
      );
    }
    const fingerprint = `${reference.reference}\0${reference.subject}\0${reference.principalId ?? ''}`;
    if (seenEntries.has(fingerprint)) {
      throw new Error(
        'The Pompeii report contains a duplicate reference result.',
      );
    }
    seenEntries.add(fingerprint);
    seenReferences.add(reference.reference);
    const group = resolvedByReference.get(reference.reference) ?? [];
    group.push(reference);
    resolvedByReference.set(reference.reference, group);
  }
  if (
    expectedReferences.some(
      (reference) => !seenReferences.has(reference.reference),
    )
  ) {
    throw new Error(
      'The Pompeii report does not cover the current Alcantara inventory.',
    );
  }

  const actualMissing = report.references
    .filter((reference) => reference.principalId === null)
    .map((reference) => `${reference.reference}\0${reference.subject}`);
  const declaredMissing = report.missing.map((reference) => {
    if (
      reference.consumer !== 'alcantara' ||
      reference.principalId !== null ||
      expectedByReference.get(reference.reference)?.subject !==
        reference.subject
    ) {
      throw new Error('The Pompeii missing-reference report is inconsistent.');
    }
    return `${reference.reference}\0${reference.subject}`;
  });
  if (!sameStringSet(actualMissing, declaredMissing)) {
    throw new Error('The Pompeii missing-reference report is inconsistent.');
  }

  const actualCollisions = new Map<string, string[]>();
  for (const [reference, group] of resolvedByReference) {
    const principalIds = [
      ...new Set(
        group.flatMap((entry) =>
          entry.principalId === null ? [] : [entry.principalId],
        ),
      ),
    ];
    if (principalIds.length > 1) actualCollisions.set(reference, principalIds);
  }
  if (actualCollisions.size !== report.collisions.length) {
    throw new Error('The Pompeii collision report is inconsistent.');
  }
  for (const collision of report.collisions) {
    if (collision.consumer !== 'alcantara') {
      throw new Error('The Pompeii collision report is inconsistent.');
    }
    const actual = actualCollisions.get(collision.reference);
    if (!actual || !sameStringSet(actual, collision.principalIds)) {
      throw new Error('The Pompeii collision report is inconsistent.');
    }
  }

  return report.references.flatMap((reference) =>
    reference.principalId
      ? [{ principalId: reference.principalId, subject: reference.subject }]
      : [],
  );
}

async function collectRows(
  prisma: IdentityStore,
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

function assertOneCanonicalUpdate(
  model: IdentityRow['model'],
  count: number,
): void {
  if (count === 1) return;
  throw new Error(
    `${model} changed concurrently; no canonical principal changes were committed. Retry the migration.`,
  );
}

const transactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

async function applyMigration(
  transaction: Prisma.TransactionClient,
  producerReport: PompeiiMigrationReport,
  allowConflicts: boolean,
) {
  // Collection, producer-contract validation, planning, and every write share
  // one serializable snapshot. A concurrent owner/audit change either misses a
  // compare-and-set below or forces PostgreSQL to abort this whole transaction.
  const rows = await collectRows(transaction);
  const mappings = mappingsFromMigrationReport(producerReport, rows);
  const plan = planMigration(rows, mappings);
  if (
    producerReport.collisions.length > 0 ||
    producerReport.missing.length > 0
  ) {
    return { applied: 0, plan, refusal: 'producer' as const };
  }
  if (hasConflicts(plan) && !allowConflicts) {
    return { applied: 0, plan, refusal: 'consumer' as const };
  }

  const rowsByPlanId = new Map(
    rows.map((row) => [`${row.model}:${row.id}`, row]),
  );
  let applied = 0;
  for (const row of applicableChanges(plan)) {
    if (row.principalId === null) continue;
    const source = rowsByPlanId.get(`${row.model}:${row.id}`);
    if (!source || !source.subject) {
      throw new Error(
        'The current Alcantara migration inventory changed unexpectedly.',
      );
    }

    let count: number;
    if (row.model === 'OperatorPreference') {
      const result = await transaction.operatorPreference.updateMany({
        data: { principalId: row.principalId },
        where: {
          deviceClass: source.deviceClass,
          principalId: null,
          subject: source.sourceId,
        },
      });
      count = result.count;
    } else if (row.model === 'SharedConsoleLayout') {
      const result = await transaction.sharedConsoleLayout.updateMany({
        data: { ownerPrincipalId: row.principalId },
        where: {
          id: source.sourceId,
          ownerPrincipalId: null,
          ownerSubject: source.subject,
        },
      });
      count = result.count;
    } else if (row.model === 'GuestInvitation') {
      // Audit only: createdByIdentity is never rewritten, so the historical
      // actor still displays exactly as it always did.
      const result = await transaction.guestInvitation.updateMany({
        data: { createdByPrincipalId: row.principalId },
        where: {
          createdByIdentity: source.subject,
          createdByPrincipalId: null,
          id: source.sourceId,
        },
      });
      count = result.count;
    } else {
      if (!source.details) {
        throw new Error(
          'The current Alcantara migration inventory changed unexpectedly.',
        );
      }
      const result = await transaction.guestEvent.updateMany({
        data: {
          details: {
            ...source.details,
            operatorPrincipalId: row.principalId,
          } as Prisma.InputJsonValue,
        },
        where: {
          details: { equals: source.details as Prisma.InputJsonValue },
          id: source.sourceId,
        },
      });
      count = result.count;
    }
    assertOneCanonicalUpdate(row.model, count);
    applied += count;
  }

  return { applied, plan, refusal: null };
}

function defaultDependencies(): CliDependencies {
  return {
    bootstrapDatabase: () => loadDatabaseSecret(),
    createPrisma: () =>
      new PrismaClient({
        adapter: createPostgresAdapter(process.env.DATABASE_URL),
      }),
    error: (message) => console.error(message),
    log: (message) => console.log(message),
    writeReferences: (path, references) =>
      writeFileSync(path, `${JSON.stringify(references, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
  };
}

export async function runPrincipalMigrationCli(
  args: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const [mode, inputPath, ...flags] = args;
  if (mode !== 'export' && mode !== 'report' && mode !== 'apply') {
    dependencies.error(
      'Usage: principals-cli <export|report|apply> <path> [--allow-conflicts]',
    );
    return 2;
  }
  if (!inputPath) {
    dependencies.error('A references or Pompeii report path is required.');
    return 2;
  }

  // Production supplies ARAUCO_SECRET_ID, not DATABASE_URL. This canonical
  // bootstrap must finish before Prisma or its Postgres adapter is constructed.
  await dependencies.bootstrapDatabase();
  const prisma = dependencies.createPrisma();
  try {
    if (mode === 'export') {
      const rows = await prisma.$transaction(
        (transaction) => collectRows(transaction),
        transactionOptions,
      );
      const references = buildConsumerReferences(rows);
      dependencies.writeReferences(inputPath, references);
      dependencies.log(
        `Wrote ${references.length} Alcantara references for Pompeii.`,
      );
      return 0;
    }

    const producerReport = readMigrationReportFile(inputPath);
    if (mode === 'report') {
      const rows = await collectRows(prisma);
      const mappings = mappingsFromMigrationReport(producerReport, rows);
      dependencies.log(formatPlan(planMigration(rows, mappings)));
      dependencies.log(
        `\nPompeii blockers: ${producerReport.collisions.length} collision(s), ${producerReport.missing.length} missing reference(s).`,
      );
      return 0;
    }

    const outcome = await prisma.$transaction(
      (transaction) =>
        applyMigration(
          transaction,
          producerReport,
          flags.includes('--allow-conflicts'),
        ),
      transactionOptions,
    );
    dependencies.log(formatPlan(outcome.plan));
    if (outcome.refusal === 'producer') {
      dependencies.error(
        `\nRefusing to apply: Pompeii reported ${producerReport.collisions.length} collision(s) and ${producerReport.missing.length} missing reference(s).`,
      );
      return 1;
    }
    if (outcome.refusal === 'consumer') {
      dependencies.error(
        '\nRefusing to apply while Alcantara conflicts remain. Resolve them, or pass --allow-conflicts to migrate only the clean rows.',
      );
      return 1;
    }
    dependencies.log(
      `\nApplied ${outcome.applied} canonical principal references.`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runPrincipalMigrationCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
