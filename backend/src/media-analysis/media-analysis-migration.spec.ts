import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261117010000_media_asset_analysis_job/migration.sql',
  ),
  'utf8',
);

describe('media analysis job migration', () => {
  it('only adds nullable or defaulted columns to MediaAssetAnalysis', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('--'))
      .join('\n');
    expect(statements).toBe(
      'ALTER TABLE "MediaAssetAnalysis" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,\n' +
        'ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),\n' +
        'ADD COLUMN     "sourceUrl" TEXT;',
    );
    expect(migration).not.toMatch(/DROP|DELETE|UPDATE|"MediaAsset"\s/);
  });
});
