import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261124020000_media_analysis_rule_version/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

// gaulatti/alcantara#235: which cue rule placed a song's cue points.
describe('media analysis rule version migration', () => {
  it('is additive only: one nullable column, no backfill, so earlier analyses stay null (rule 1)', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "MediaAssetAnalysis" ADD COLUMN "ruleVersion" INTEGER;',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(
      /model MediaAssetAnalysis \{[^}]*\n\s*ruleVersion\s+Int\?\n/,
    );
  });
});

// gaulatti/alcantara#235: the rule a re-analysis request asked for, so a bad batch can be re-run on the previous rule.
describe('media analysis requested rule migration', () => {
  const requested = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20261124030000_media_analysis_requested_rule/migration.sql',
    ),
    'utf8',
  );

  it('is additive only: one nullable column and no backfill', () => {
    const statements = requested
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "MediaAssetAnalysis" ADD COLUMN "requestedRuleVersion" INTEGER;',
    ]);
    expect(requested).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(
      /model MediaAssetAnalysis \{[^}]*\n\s*requestedRuleVersion\s+Int\?\n/,
    );
  });
});
