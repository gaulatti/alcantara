import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260914234500_media_asset_registry/migration.sql',
  ),
  'utf8',
);

describe('media asset expand migration', () => {
  it('backfills and links all four existing asset tables', () => {
    for (const [table, prefix] of [
      ['Media', 'image:'],
      ['Instant', 'audio-clip:'],
      ['Song', 'song:'],
      ['Stinger', 'transition:'],
    ]) {
      expect(migration).toContain(`FROM "${table}";`);
      expect(migration).toContain(
        `UPDATE "${table}" SET "assetId" = '${prefix}' || "id";`,
      );
    }
  });

  it('is additive and leaves every legacy record recoverable', () => {
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/\bRENAME\b/i);
    expect(migration).not.toMatch(/SET\s+NOT\s+NULL/i);
    expect(migration.match(/ON DELETE SET NULL/g)).toHaveLength(4);
  });
});
