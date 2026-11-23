import {
  applicableChanges,
  formatPlan,
  hasConflicts,
  identityFilters,
  indexMappings,
  ownsRow,
  planMigration,
  type IdentityRow,
} from './principals';

const row = (
  overrides: Partial<IdentityRow> & { id: string },
): IdentityRow => ({
  model: 'SharedConsoleLayout',
  principalId: null,
  subject: 'subject-a',
  ...overrides,
});

describe('principals coverage', () => {
  describe('indexMappings', () => {
    it('trims, skips blanks, tolerates identical repeats, and drops ambiguous subjects', () => {
      const { ambiguous, bySubject } = indexMappings([
        { subject: ' s1 ', principalId: ' p1 ' },
        { subject: 's1', principalId: 'p1' },
        { subject: 's2', principalId: 'p2' },
        { subject: 's2', principalId: 'p3' },
        { subject: '  ', principalId: 'p4' },
        { subject: 's5', principalId: '  ' },
        { subject: undefined as unknown as string, principalId: 'p6' },
        { subject: 's7', principalId: undefined as unknown as string },
      ]);
      expect([...bySubject.entries()]).toEqual([['s1', 'p1']]);
      expect([...ambiguous]).toEqual(['s2']);
    });
  });

  describe('planMigration classification', () => {
    it('classifies every state and counts them', () => {
      const plan = planMigration(
        [
          row({ id: 'mapped', subject: 'sm' }),
          row({ id: 'done', subject: 'sm', principalId: 'pm' }),
          row({ id: 'same-name-other', subject: 'sm', principalId: 'other' }),
          row({ id: 'unmapped-owned', subject: 'su', principalId: 'px' }),
          row({ id: 'missing', subject: 'su' }),
          row({ id: 'amb', subject: 'sa' }),
          row({ id: 'orphan-null', subject: null }),
          row({ id: 'orphan-blank', subject: '   ', principalId: 'po' }),
        ],
        [
          { subject: 'sm', principalId: 'pm' },
          { subject: 'sa', principalId: 'p1' },
          { subject: 'sa', principalId: 'p2' },
        ],
      );
      const byId = Object.fromEntries(plan.rows.map((r) => [r.id, r]));
      expect(byId.mapped).toMatchObject({
        classification: 'mapped',
        principalId: 'pm',
      });
      expect(byId.done).toMatchObject({
        classification: 'already-migrated',
        principalId: 'pm',
      });
      expect(byId['same-name-other']).toMatchObject({
        classification: 'conflicting',
        principalId: 'other',
      });
      expect(byId['unmapped-owned']).toMatchObject({
        classification: 'already-migrated',
        principalId: 'px',
      });
      expect(byId.missing).toMatchObject({
        classification: 'missing',
        principalId: null,
      });
      expect(byId.amb).toMatchObject({
        classification: 'ambiguous',
        principalId: null,
      });
      expect(byId['orphan-null']).toMatchObject({
        classification: 'orphan',
        principalId: null,
      });
      expect(byId['orphan-blank']).toMatchObject({
        classification: 'orphan',
        principalId: 'po',
      });
      expect(plan.ambiguousSubjects).toBe(1);
      expect(plan.summary).toEqual({
        mapped: 1,
        'already-migrated': 2,
        missing: 1,
        conflicting: 1,
        ambiguous: 1,
        colliding: 0,
        orphan: 2,
      });
    });
  });

  describe('operator preference collisions', () => {
    const pref = (
      id: string,
      subject: string,
      extra: Partial<IdentityRow> = {},
    ) =>
      row({
        id,
        subject,
        model: 'OperatorPreference',
        collisionScope: 'desktop',
        ...extra,
      });

    it('marks rows that converge on one principal and device class as colliding', () => {
      const plan = planMigration(
        [
          pref('a', 's1'),
          pref('b', 's2'),
          pref('c', 's3'),
          pref('d', 's4', { collisionScope: 'phone' }),
        ],
        [
          { subject: 's1', principalId: 'p' },
          { subject: 's2', principalId: 'p' },
          { subject: 's3', principalId: 'p' },
          { subject: 's4', principalId: 'p' },
        ],
      );
      expect(plan.rows.map((r) => r.classification)).toEqual([
        'colliding',
        'colliding',
        'colliding',
        'mapped',
      ]);
      expect(hasConflicts(plan)).toBe(true);
      expect(applicableChanges(plan).map((r) => r.id)).toEqual(['d']);
    });

    it('does not downgrade conflicting rows and ignores rows without a principal or scope', () => {
      const plan = planMigration(
        [
          pref('a', 's3', { principalId: 'old' }),
          pref('conflict', 's2', { principalId: 'old' }),
          pref('noscope', 's1', { collisionScope: undefined }),
          pref('unmapped', 's9'),
          row({
            id: 'layout',
            subject: 's1',
            model: 'SharedConsoleLayout',
            collisionScope: 'desktop',
          }),
        ],
        [
          { subject: 's1', principalId: 'p' },
          { subject: 's2', principalId: 'p' },
        ],
      );
      const byId = Object.fromEntries(
        plan.rows.map((r) => [r.id, r.classification]),
      );
      expect(byId.a).toBe('colliding');
      expect(byId.conflict).toBe('conflicting');
      expect(byId.noscope).toBe('mapped');
      expect(byId.unmapped).toBe('missing');
      expect(byId.layout).toBe('mapped');
    });

    it('does not rewrite ambiguous rows to colliding', () => {
      const plan = planMigration(
        [pref('x', 's1', { principalId: 'p' }), pref('y', 's2')],
        [
          { subject: 's1', principalId: 'p' },
          { subject: 's2', principalId: 'a' },
          { subject: 's2', principalId: 'b' },
        ],
      );
      expect(plan.rows.map((r) => r.classification)).toEqual([
        'already-migrated',
        'ambiguous',
      ]);
    });
  });

  describe('hasConflicts', () => {
    const planWith = (
      rows: IdentityRow[],
      mappings = [{ subject: 'subject-a', principalId: 'p' }],
    ) => planMigration(rows, mappings);

    it('is false for clean plans', () => {
      expect(hasConflicts(planWith([row({ id: '1' })]))).toBe(false);
    });
    it('is true for conflicting rows', () => {
      expect(
        hasConflicts(planWith([row({ id: '1', principalId: 'other' })])),
      ).toBe(true);
    });
    it('is true for ambiguous rows', () => {
      expect(
        hasConflicts(
          planWith(
            [row({ id: '1' })],
            [
              { subject: 'subject-a', principalId: 'p' },
              { subject: 'subject-a', principalId: 'q' },
            ],
          ),
        ),
      ).toBe(true);
    });
  });

  describe('formatPlan', () => {
    it('reports per-model and total counts only', () => {
      const output = formatPlan(
        planMigration(
          [
            row({ id: 'secret-row-id', subject: 'secret-subject' }),
            row({
              id: 'second',
              subject: 'secret-subject',
              model: 'GuestEvent',
            }),
          ],
          [{ subject: 'secret-subject', principalId: 'secret-principal' }],
        ),
      );
      expect(output).toContain('Canonical principal migration — dry run');
      expect(output).toContain(
        'OperatorPreference.subject -> principalId (ownership): 0 rows',
      );
      expect(output).toContain(
        'SharedConsoleLayout.ownerSubject -> ownerPrincipalId (ownership): 1 rows',
      );
      expect(output).toContain('  mapped: 1');
      expect(output).toContain('Totals:');
      expect(output).toContain('  mapped: 2');
      expect(output).not.toContain('subject(s) map to more than one principal');
      expect(output).not.toContain('Conflicts found');
      expect(output).not.toContain('secret');
    });

    it('explains ambiguous subjects and conflicts', () => {
      const output = formatPlan(
        planMigration(
          [row({ id: '1' })],
          [
            { subject: 'subject-a', principalId: 'p' },
            { subject: 'subject-a', principalId: 'q' },
          ],
        ),
      );
      expect(output).toContain(
        '1 subject(s) map to more than one principal and are skipped.',
      );
      expect(output).toContain(
        'Conflicts found. Nothing is rewritten automatically; resolve them first.',
      );
    });
  });

  describe('identityFilters and ownsRow', () => {
    it('echoes the caller identity', () => {
      expect(identityFilters({ principalId: 'p', subject: 's' })).toEqual({
        principalId: 'p',
        subject: 's',
      });
      expect(identityFilters({ principalId: null, subject: 's' })).toEqual({
        principalId: null,
        subject: 's',
      });
    });

    it('owns migrated rows only by principal and legacy rows only by subject', () => {
      expect(
        ownsRow(
          { principalId: 'p', subject: 'x' },
          { principalId: 'p', subject: 'y' },
        ),
      ).toBe(true);
      expect(
        ownsRow(
          { principalId: 'p', subject: 's' },
          { principalId: 'q', subject: 's' },
        ),
      ).toBe(false);
      expect(
        ownsRow(
          { principalId: 'p', subject: 's' },
          { principalId: null, subject: 's' },
        ),
      ).toBe(false);
      expect(
        ownsRow(
          { principalId: null, subject: 's' },
          { principalId: 'q', subject: 's' },
        ),
      ).toBe(true);
      expect(
        ownsRow(
          { principalId: null, subject: 's' },
          { principalId: null, subject: 'other' },
        ),
      ).toBe(false);
      expect(
        ownsRow(
          { principalId: null, subject: null },
          { principalId: null, subject: 's' },
        ),
      ).toBe(false);
    });
  });
});
