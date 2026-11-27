import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A deploy migrates while the previous release still serves, and a handover keeps it serving longer
// (gaulatti/alcantara#873): a migration must work with that release. Expand first; drop or tighten in a later one.
// A statement that would break it needs a line in the same file saying why it is safe now:
//
//   -- reviewed-breaking: the column has had no reader since 2026-11-20

/** The migrations that were already applied when the rule began. Their files must not change. */
const APPLIED_BEFORE_THE_RULE = '20261127030000_guest_cue';

const RULES: [string, RegExp][] = [
  ['drops a table, column or type', /\bDROP\s+(TABLE|COLUMN|TYPE)\b/],
  [
    'renames something the previous release names',
    /^(?!ALTER\s+INDEX\b).*\bRENAME\b/,
  ],
  ['makes a column required', /\bSET\s+NOT\s+NULL\b/],
  [
    'changes a column type',
    /\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/,
  ],
  [
    'adds a required column with no default',
    /\bADD\s+COLUMN\b(?=[^,]*\bNOT\s+NULL\b)(?![^,]*\bDEFAULT\b)/,
  ],
];

export function breakingStatements(sql: string): string[] {
  if (/^\s*--\s*reviewed-breaking:[ \t]*\S/m.test(sql)) return [];
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  return code.split(';').flatMap((statement) => {
    const one = statement.replace(/\s+/g, ' ').trim().toUpperCase();
    return RULES.filter(([, rule]) => rule.test(one)).map(
      ([reason]) => `${reason}: ${one.slice(0, 120)}`,
    );
  });
}

describe('migration safety', () => {
  const root = join(__dirname, '../../prisma/migrations');
  const migrations = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('keeps every new migration usable by the release that is still serving', () => {
    expect(migrations).toContain(APPLIED_BEFORE_THE_RULE);
    const found = migrations
      .filter((name) => name > APPLIED_BEFORE_THE_RULE)
      .flatMap((name) =>
        breakingStatements(
          readFileSync(join(root, name, 'migration.sql'), 'utf8'),
        ).map((problem) => `${name} ${problem}`),
      );
    expect(found).toEqual([]);
  });

  it.each([
    'DROP TABLE "Song";',
    'ALTER TABLE "Song" DROP COLUMN "title";',
    'DROP TYPE "Kind";',
    'ALTER TABLE "Song" RENAME COLUMN "title" TO "name";',
    'ALTER TABLE "Song"\n  RENAME TO "Track";',
    "ALTER TYPE \"Kind\" RENAME VALUE 'a' TO 'b';",
    'ALTER TABLE "Song" ALTER COLUMN "title" SET NOT NULL;',
    'ALTER TABLE "Song" ALTER COLUMN "title" TYPE VARCHAR(10);',
    'ALTER TABLE "Song" ALTER COLUMN "title" SET DATA TYPE TEXT;',
    'ALTER TABLE "Song" ADD COLUMN "mood" TEXT NOT NULL;',
  ])('flags %s', (sql) => {
    expect(breakingStatements(sql)).toHaveLength(1);
  });

  it.each([
    'CREATE TABLE "Mood" ("id" TEXT NOT NULL, PRIMARY KEY ("id"));',
    'ALTER TABLE "Song" ADD COLUMN "mood" TEXT;',
    'ALTER TABLE "Song" ADD COLUMN "plays" INTEGER NOT NULL DEFAULT 0;',
    'ALTER TABLE "Song" ALTER COLUMN "title" DROP NOT NULL;',
    'ALTER INDEX "Song_pkey" RENAME TO "Track_pkey";',
    'DROP INDEX "Song_title_idx";',
    '-- we no longer DROP TABLE here\nUPDATE "Song" SET "title" = \'RENAME\';',
    '-- reviewed-breaking: nothing has read it for a release\nDROP TABLE "Song";',
  ])('accepts %s', (sql) => {
    expect(breakingStatements(sql)).toEqual([]);
  });

  it('does not accept a review with no reason', () => {
    expect(
      breakingStatements('-- reviewed-breaking:\nDROP TABLE "Song";'),
    ).toHaveLength(1);
  });
});
