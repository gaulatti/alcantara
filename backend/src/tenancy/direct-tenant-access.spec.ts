import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TENANT_DELEGATES,
  directAccessProblems,
  directTenantUses,
  scanDirectTenantUses,
} from './direct-tenant-access';
import { TENANCY_CLASSIFICATION } from './tenancy-classification';

// gaulatti/alcantara#122 slice 1: direct `prisma.<tenantModel>` access outside the tenancy module is a ratchet. The
// uses that exist today are listed in direct-tenant-access.baseline.json; a new one fails, and a fixed one must be
// taken off the list. Moving a service onto the scoped client (`forTeam`) is #122's later slices.
const BACKEND = join(__dirname, '../..');
const BASELINE = JSON.parse(readFileSync(join(__dirname, 'direct-tenant-access.baseline.json'), 'utf8')) as Record<
  string,
  Record<string, number>
>;

describe('direct tenant-model access outside the tenancy module', () => {
  it('adds no use the baseline does not list', () => {
    const { added } = directAccessProblems(scanDirectTenantUses(BACKEND), BASELINE);
    expect(added).toEqual([]);
  });

  it('lists no use that is gone, so the baseline only goes down', () => {
    const { stale } = directAccessProblems(scanDirectTenantUses(BACKEND), BASELINE);
    expect(stale).toEqual([]);
  });

  it('covers every tenant model of the classification, under its client delegate name', () => {
    const tenants = Object.entries(TENANCY_CLASSIFICATION).filter(([, tenancy]) => tenancy.kind === 'tenant');
    expect(TENANT_DELEGATES).toHaveLength(tenants.length);
    expect(TENANT_DELEGATES).toEqual(expect.arrayContaining(['song', 'mediaAsset', 'broadcastDestinationKeyChange', 'program']));
  });
});

describe('directTenantUses', () => {
  it('counts a member access on a receiver named prisma, by delegate', () => {
    expect(
      directTenantUses(
        [
          'const rows = await this.prisma.song.findMany();',
          'await prisma . song . count(); await this.prisma.mediaAsset.update({});',
          'const program = await this.prisma.program.findUnique({});',
        ].join('\n'),
      ),
    ).toEqual({ song: 2, mediaAsset: 1, program: 1 });
  });

  it('does not count a scoped client, a transaction client, a non-tenant model, a longer name or a comment', () => {
    expect(
      directTenantUses(
        [
          'await songDb.song.findMany();',
          'await scopedPrisma.song.findMany();',
          'await tx.song.update({});',
          'await this.prisma.programState.findUnique({});',
          'await this.prisma.songIntro.findMany();',
          '// this.prisma.song.findMany() is the old way',
          ' * see this.prisma.song.count()',
        ].join('\n'),
      ),
    ).toEqual({});
  });
});

describe('directAccessProblems', () => {
  it('names a new or increased use, and a use the baseline still lists that is gone', () => {
    expect(
      directAccessProblems(
        { 'src/a.ts': { song: 2, scene: 1 }, 'src/new.ts': { media: 1 } },
        { 'src/a.ts': { song: 1, scene: 1 }, 'src/gone.ts': { stinger: 2 } },
      ),
    ).toEqual({
      added: ['src/a.ts: prisma.song 2 (baseline 1)', 'src/new.ts: prisma.media 1 (baseline 0)'],
      stale: ['src/gone.ts: prisma.stinger 0 (baseline 2)'],
    });
    expect(directAccessProblems({ 'src/a.ts': { song: 1 } }, { 'src/a.ts': { song: 1 } })).toEqual({ added: [], stale: [] });
  });
});
