/**
 * Migrating pool-local subject references to canonical Pompeii principals.
 *
 * A Cognito pool subject is not portable: the same operator signing in through
 * a different pool gets a different subject, so their preferences, their shared
 * layouts, and their audit trail all fragment. Pompeii issues a canonical
 * `principal_id` that is stable for that person across pools.
 *
 * Three rules shape this module:
 *
 * 1. **Never join identities by email.** The only accepted input is a
 *    subject-to-principal mapping Pompeii has verified. Nothing here can derive
 *    one, deliberately.
 * 2. **No ownership row changes without a verified mapping.** An unmapped row
 *    stays exactly as it is and stays usable.
 * 3. **Audit attribution is never rewritten.** `GuestInvitation.createdByIdentity`
 *    keeps its original value forever; the canonical principal is recorded
 *    beside it, so a historical actor still displays even when no mapping
 *    exists and no link is fabricated.
 *
 * Everything is pure; the caller owns the database.
 */

/** A subject-to-principal pair Pompeii has verified. */
export type SubjectMapping = {
  subject: string;
  principalId: string;
};

/** Every table and column in Alcantara that carries a pool-local subject. */
export const SUBJECT_BEARING_FIELDS = [
  {
    canonicalColumn: 'principalId',
    kind: 'ownership',
    model: 'OperatorPreference',
    subjectColumn: 'subject',
  },
  {
    canonicalColumn: 'ownerPrincipalId',
    kind: 'ownership',
    model: 'SharedConsoleLayout',
    subjectColumn: 'ownerSubject',
  },
  {
    canonicalColumn: 'createdByPrincipalId',
    kind: 'audit',
    model: 'GuestInvitation',
    subjectColumn: 'createdByIdentity',
  },
] as const;

export type SubjectBearingField = (typeof SUBJECT_BEARING_FIELDS)[number];

export type RowClassification =
  /** A verified mapping exists and the row can move. */
  | 'mapped'
  /** Already carries the canonical principal the mapping names. */
  | 'already-migrated'
  /** No mapping was supplied for this subject. The row stays usable as-is. */
  | 'missing'
  /** The row already names a *different* principal. Never overwritten. */
  | 'conflicting'
  /** The subject appears in the mapping more than once, with different principals. */
  | 'ambiguous'
  /** The row carries no subject at all. */
  | 'orphan';

/** One row of any subject-bearing model, reduced to what the plan needs. */
export type IdentityRow = {
  /** Opaque row identity for the report. Never an operator identifier. */
  id: string;
  model: SubjectBearingField['model'];
  principalId: string | null;
  subject: string | null;
};

export type PlanRow = {
  classification: RowClassification;
  id: string;
  model: SubjectBearingField['model'];
  principalId: string | null;
};

export type MigrationPlan = {
  ambiguousSubjects: number;
  rows: PlanRow[];
  summary: Record<RowClassification, number>;
};

const CLASSIFICATIONS: readonly RowClassification[] = [
  'mapped',
  'already-migrated',
  'missing',
  'conflicting',
  'ambiguous',
  'orphan',
];

/**
 * Collapses a mapping list, reporting any subject claimed by more than one
 * principal. An ambiguous subject is never applied: choosing between two
 * candidate principals is a human decision.
 */
export function indexMappings(mappings: readonly SubjectMapping[]): {
  ambiguous: Set<string>;
  bySubject: Map<string, string>;
} {
  const bySubject = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const mapping of mappings) {
    const subject = mapping.subject?.trim();
    const principalId = mapping.principalId?.trim();
    if (!subject || !principalId) continue;
    const existing = bySubject.get(subject);
    if (existing && existing !== principalId) {
      ambiguous.add(subject);
      continue;
    }
    bySubject.set(subject, principalId);
  }
  for (const subject of ambiguous) bySubject.delete(subject);
  return { ambiguous, bySubject };
}

function classify(
  row: IdentityRow,
  bySubject: Map<string, string>,
  ambiguous: Set<string>,
): PlanRow {
  const subject = row.subject?.trim() ?? '';
  const base = { id: row.id, model: row.model };

  if (!subject) {
    return { ...base, classification: 'orphan', principalId: row.principalId };
  }
  if (ambiguous.has(subject)) {
    return { ...base, classification: 'ambiguous', principalId: row.principalId };
  }

  const mapped = bySubject.get(subject) ?? null;
  if (row.principalId) {
    if (mapped && mapped !== row.principalId) {
      return { ...base, classification: 'conflicting', principalId: row.principalId };
    }
    return { ...base, classification: 'already-migrated', principalId: row.principalId };
  }
  if (!mapped) {
    return { ...base, classification: 'missing', principalId: null };
  }
  return { ...base, classification: 'mapped', principalId: mapped };
}

/**
 * Classifies every subject-bearing row against a verified mapping without
 * changing anything. This is the dry run.
 */
export function planMigration(
  rows: readonly IdentityRow[],
  mappings: readonly SubjectMapping[],
): MigrationPlan {
  const { ambiguous, bySubject } = indexMappings(mappings);
  const planned = rows.map((row) => classify(row, bySubject, ambiguous));
  const summary = Object.fromEntries(
    CLASSIFICATIONS.map((key) => [key, 0]),
  ) as Record<RowClassification, number>;
  for (const row of planned) summary[row.classification] += 1;
  return { ambiguousSubjects: ambiguous.size, rows: planned, summary };
}

/** The rows a migration may write: only what the dry run classified `mapped`. */
export function applicableChanges(plan: MigrationPlan): PlanRow[] {
  return plan.rows.filter((row) => row.classification === 'mapped');
}

/** True when the plan contains anything a person must resolve before applying. */
export function hasConflicts(plan: MigrationPlan): boolean {
  return plan.summary.conflicting > 0 || plan.summary.ambiguous > 0;
}

/**
 * A human-readable dry-run report. It contains counts and opaque row ids only —
 * never a subject, a principal, or an email.
 */
export function formatPlan(plan: MigrationPlan): string {
  const lines = ['Canonical principal migration — dry run', ''];
  for (const field of SUBJECT_BEARING_FIELDS) {
    const rows = plan.rows.filter((row) => row.model === field.model);
    lines.push(
      `${field.model}.${field.subjectColumn} -> ${field.canonicalColumn} (${field.kind}): ${rows.length} rows`,
    );
    for (const key of CLASSIFICATIONS) {
      const count = rows.filter((row) => row.classification === key).length;
      if (count > 0) lines.push(`  ${key}: ${count}`);
    }
  }
  lines.push('', 'Totals:');
  for (const key of CLASSIFICATIONS) lines.push(`  ${key}: ${plan.summary[key]}`);
  if (plan.ambiguousSubjects > 0) {
    lines.push('', `${plan.ambiguousSubjects} subject(s) map to more than one principal and are skipped.`);
  }
  if (hasConflicts(plan)) {
    lines.push('', 'Conflicts found. Nothing is rewritten automatically; resolve them first.');
    for (const row of plan.rows.filter((item) => item.classification === 'conflicting')) {
      lines.push(`  ${row.model} ${row.id} already names a different principal`);
    }
  }
  return lines.join('\n');
}

/**
 * Resolves which identity a read should use.
 *
 * A caller with a canonical principal reads migrated rows by principal and
 * unmigrated rows by subject, so both remain reachable during the migration
 * window. A caller without one reads by subject only — it must never fall
 * through to another person's rows.
 */
export function identityFilters(identity: {
  principalId: string | null;
  subject: string;
}): { principalId: string | null; subject: string } {
  return { principalId: identity.principalId, subject: identity.subject };
}

/** Whether a stored row belongs to the caller, under either identity. */
export function ownsRow(
  row: { principalId: string | null; subject: string | null },
  identity: { principalId: string | null; subject: string },
): boolean {
  if (row.principalId) {
    return identity.principalId !== null && row.principalId === identity.principalId;
  }
  return row.subject === identity.subject;
}
