import {
  applicableChanges,
  formatPlan,
  hasConflicts,
  indexMappings,
  ownsRow,
  planMigration,
  SUBJECT_BEARING_FIELDS,
  type IdentityRow,
} from './principals';

const row = (overrides: Partial<IdentityRow> = {}): IdentityRow => ({
  id: 'row-1',
  model: 'SharedConsoleLayout',
  principalId: null,
  subject: 'subject-a',
  ...overrides,
});

const mapping = [{ principalId: 'principal-a', subject: 'subject-a' }];

describe('subject inventory', () => {
  it('accounts for every subject-bearing field in the schema', () => {
    // Kept in step with prisma/schema.prisma by hand; a new subject column that
    // is not listed here would silently escape both the report and the apply.
    expect(SUBJECT_BEARING_FIELDS.map((field) => `${field.model}.${field.subjectColumn}`)).toEqual([
      'OperatorPreference.subject',
      'SharedConsoleLayout.ownerSubject',
      'GuestInvitation.createdByIdentity',
    ]);
    expect(SUBJECT_BEARING_FIELDS.filter((field) => field.kind === 'audit')).toHaveLength(1);
  });
});

describe('dry run', () => {
  it('reports mapped, already-migrated, missing, and orphan rows', () => {
    const plan = planMigration(
      [
        row({ id: 'mapped' }),
        row({ id: 'done', principalId: 'principal-a' }),
        row({ id: 'unmapped', subject: 'subject-unknown' }),
        row({ id: 'orphan', subject: null }),
      ],
      mapping,
    );

    expect(plan.summary).toEqual({
      mapped: 1,
      'already-migrated': 1,
      missing: 1,
      conflicting: 0,
      ambiguous: 0,
      orphan: 1,
    });
    expect(plan.rows).toHaveLength(4);
    expect(hasConflicts(plan)).toBe(false);
  });

  it('reports a row that already names a different principal and never overwrites it', () => {
    const plan = planMigration([row({ principalId: 'principal-other' })], mapping);

    expect(plan.rows[0].classification).toBe('conflicting');
    expect(plan.rows[0].principalId).toBe('principal-other');
    expect(applicableChanges(plan)).toEqual([]);
    expect(hasConflicts(plan)).toBe(true);
  });

  it('refuses a subject that maps to more than one principal', () => {
    const ambiguousMapping = [
      { principalId: 'principal-a', subject: 'subject-a' },
      { principalId: 'principal-b', subject: 'subject-a' },
    ];
    const { ambiguous, bySubject } = indexMappings(ambiguousMapping);
    expect(ambiguous.has('subject-a')).toBe(true);
    expect(bySubject.has('subject-a')).toBe(false);

    const plan = planMigration([row()], ambiguousMapping);
    expect(plan.rows[0].classification).toBe('ambiguous');
    expect(plan.ambiguousSubjects).toBe(1);
    expect(applicableChanges(plan)).toEqual([]);
    expect(hasConflicts(plan)).toBe(true);
  });

  it('ignores blank mapping entries rather than treating them as identities', () => {
    const { bySubject } = indexMappings([
      { principalId: '', subject: 'subject-a' },
      { principalId: 'principal-b', subject: '   ' },
      { principalId: ' principal-c ', subject: ' subject-c ' },
    ]);

    expect(bySubject.get('subject-a')).toBeUndefined();
    expect(bySubject.get('subject-c')).toBe('principal-c');
  });

  it('leaves an unmapped row usable rather than orphaning it', () => {
    const plan = planMigration([row({ subject: 'subject-unknown' })], mapping);

    expect(plan.rows[0].classification).toBe('missing');
    expect(plan.rows[0].principalId).toBeNull();
    expect(applicableChanges(plan)).toEqual([]);
  });
});

describe('idempotence', () => {
  it('has nothing left to do on a second run', () => {
    const first = planMigration([row()], mapping);
    expect(applicableChanges(first)).toHaveLength(1);

    const applied = row({ principalId: first.rows[0].principalId });
    const second = planMigration([applied], mapping);

    expect(second.rows[0].classification).toBe('already-migrated');
    expect(applicableChanges(second)).toEqual([]);
  });

  it('resumes a partially applied run without redoing finished rows', () => {
    const plan = planMigration(
      [row({ id: 'done', principalId: 'principal-a' }), row({ id: 'pending' })],
      mapping,
    );

    expect(applicableChanges(plan).map((item) => item.id)).toEqual(['pending']);
  });
});

describe('the report', () => {
  it('names no subject, principal, or email', () => {
    const report = formatPlan(
      planMigration(
        [row({ principalId: 'principal-other' }), row({ id: 'row-2', model: 'GuestInvitation' })],
        mapping,
      ),
    );

    expect(report).not.toContain('subject-a');
    expect(report).not.toContain('principal-a');
    expect(report).not.toContain('principal-other');
    expect(report).not.toMatch(/@/);
    expect(report).toContain('conflicting: 1');
    expect(report).toContain('GuestInvitation.createdByIdentity');
  });
});

describe('reads during the migration window', () => {
  it('matches a migrated row by canonical principal, across pools', () => {
    const migrated = { principalId: 'principal-a', subject: 'subject-a' };

    expect(ownsRow(migrated, { principalId: 'principal-a', subject: 'subject-b' })).toBe(true);
    expect(ownsRow(migrated, { principalId: 'principal-b', subject: 'subject-a' })).toBe(false);
    // The pool subject alone no longer opens a migrated row.
    expect(ownsRow(migrated, { principalId: null, subject: 'subject-a' })).toBe(false);
  });

  it('matches an unmigrated row by its pool subject', () => {
    const legacy = { principalId: null, subject: 'subject-a' };

    expect(ownsRow(legacy, { principalId: 'principal-a', subject: 'subject-a' })).toBe(true);
    expect(ownsRow(legacy, { principalId: null, subject: 'subject-a' })).toBe(true);
    expect(ownsRow(legacy, { principalId: 'principal-a', subject: 'subject-z' })).toBe(false);
  });

  it('never falls through to another person when no principal is resolved', () => {
    expect(ownsRow({ principalId: null, subject: 'subject-a' }, { principalId: null, subject: 'subject-z' })).toBe(false);
    expect(ownsRow({ principalId: null, subject: null }, { principalId: null, subject: 'subject-a' })).toBe(false);
  });
});

describe('the mapping file', () => {
  const { readMappingFile } = require('./principals-cli') as typeof import('./principals-cli');
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');

  const write = (contents: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'principals-')), 'mapping.json');
    writeFileSync(path, JSON.stringify(contents));
    return path;
  };

  it('accepts verified subject-to-principal pairs', () => {
    expect(readMappingFile(write([{ principalId: 'principal-a', subject: 'subject-a' }]))).toEqual([
      { principalId: 'principal-a', subject: 'subject-a' },
    ]);
  });

  it('refuses an entry carrying an email, so identities cannot be joined by one', () => {
    expect(() =>
      readMappingFile(write([
        { email: 'person@example.com', principalId: 'principal-a', subject: 'subject-a' },
      ])),
    ).toThrow(/never from an email address/);
  });

  it('refuses a malformed file rather than importing a partial mapping', () => {
    expect(() => readMappingFile(write({ subject: 'subject-a' }))).toThrow(/JSON array/);
    expect(() => readMappingFile(write([{ subject: 'subject-a' }]))).toThrow(/principalId/);
    expect(() => readMappingFile(write(['subject-a']))).toThrow(/not an object/);
  });
});
