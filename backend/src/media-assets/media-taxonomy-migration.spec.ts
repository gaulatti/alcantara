import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260915010000_media_types_capabilities_labels/migration.sql',
  ),
  'utf8',
);

describe('media type, capability, and label migration', () => {
  it('separates physical media type from the legacy single-purpose kind', () => {
    expect(migration).toContain(
      `CREATE TYPE "MediaAssetType" AS ENUM ('IMAGE', 'AUDIO', 'VIDEO');`,
    );
    expect(migration).toContain(
      `WHEN "kind" IN ('AUDIO_CLIP'::"MediaAssetKind", 'SONG'::"MediaAssetKind") THEN 'AUDIO'::"MediaAssetType"`,
    );
    expect(migration).toContain(
      'ALTER TABLE "MediaAsset" ALTER COLUMN "kind" DROP NOT NULL;',
    );
    expect(migration).not.toContain(
      'ALTER TABLE "MediaAsset" ALTER COLUMN "mediaType" SET NOT NULL;',
    );
  });

  it('backfills legacy photo groups as labels with ordered canonical assets', () => {
    expect(migration).toContain(
      `SELECT 'legacy-media-group:' || "id", "name", "description", "createdAt", "updatedAt"`,
    );
    expect(migration).toContain(
      `JOIN "Media" AS media ON media."id" = item."mediaId"`,
    );
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "MediaAssetLabel_labelId_position_key"`,
    );
  });

  it('adds typed background capability storage without removing legacy data', () => {
    expect(migration).toContain('CREATE TABLE "BackgroundAudioCapability"');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it('backfills song covers as image assets while preserving coverUrl', () => {
    expect(migration).toContain(
      'ALTER TABLE "Song" ADD COLUMN "coverAssetId" TEXT;',
    );
    expect(migration).toContain(`'song-cover:' || "id"`);
    expect(migration).toContain(`'IMAGE'::"MediaAssetType"`);
    expect(migration).toContain('SET "coverAssetId" = \'song-cover:\' || "id"');
    expect(migration).not.toMatch(/DROP\s+COLUMN\s+"coverUrl"/i);
  });
});
