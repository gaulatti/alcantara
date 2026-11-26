import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createPostgresAdapter } from '../prisma-adapter';
import { forTeam, SCOPED_TENANT_MODELS } from './scoped-prisma';
import { TENANCY_CLASSIFICATION } from './tenancy-classification';

// gaulatti/alcantara#150: the team-scoped client against a real PostgreSQL
// database with the migrations applied (CI's, or a disposable local one), never a
// mock of Prisma. Every row it creates is fictional and removed afterwards.

// CI's documented local database (.github/workflows/ci.yml), started and migrated before
// test:coverage, which runs without DATABASE_URL. A local run sets DATABASE_URL to its own
// disposable database.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_URL || CI_DATABASE_URL;
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/alcantara_ci'
  ) {
    throw new Error(
      'scoped-prisma.spec.ts runs only against a local alcantara_ci test PostgreSQL.',
    );
  }
  return value;
}

const RUN = randomUUID();
const TEAM_A = 2_000_000_001;
const TEAM_B = 2_000_000_002;

describe('forTeam against PostgreSQL', () => {
  let prisma: PrismaClient;
  let teamA: ReturnType<typeof forTeam>;

  const source = (name: string, teamId: number) => ({
    name: `${RUN}:${name}`,
    teamId,
    transport: 'srt',
    transportConfigCiphertext: 'fictional-ciphertext',
    transportConfigNonce: 'fictional-nonce',
    configKeyVersion: 1,
    createdBySubject: 'fictional-subject',
  });
  const ours = { name: { startsWith: `${RUN}:` } };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: createPostgresAdapter(testDatabaseUrl()),
    });
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1 FROM "ExternalSource" LIMIT 1`;
    } catch (error) {
      const target = new URL(testDatabaseUrl());
      throw new Error(
        `scoped-prisma.spec.ts needs a migrated local PostgreSQL database "alcantara_ci" at ${target.hostname}:${target.port || '5432'} ` +
          '(CI starts one; locally, start a disposable one, run `pnpm run db:migrate:deploy` against it and set DATABASE_URL; see backend/README.md "Run tests"). ' +
          `Underlying error: ${(error as { code?: string }).code ?? ''} ${
            error instanceof Error
              ? (error.message
                  .split('\n')
                  .find((line) => line.trim().length > 0)
                  ?.trim() ?? error.name)
              : String(error)
          }`,
      );
    }
    teamA = forTeam(prisma, TEAM_A);
  });

  beforeEach(async () => {
    await prisma.externalSource.deleteMany({ where: ours });
    await prisma.externalSource.createMany({
      data: [
        source('a-1', TEAM_A),
        source('a-2', TEAM_A),
        source('b-1', TEAM_B),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.externalSource.deleteMany({ where: ours });
    await prisma.mediaLabel.deleteMany({
      where: { name: { startsWith: `${RUN}:` } },
    });
    await prisma.$disconnect();
  });

  const idOf = async (name: string) =>
    (
      await prisma.externalSource.findFirstOrThrow({
        where: { name: `${RUN}:${name}` },
      })
    ).id;

  it('scopes every model the classification calls tenant, and no other', () => {
    expect([...SCOPED_TENANT_MODELS].sort()).toEqual(
      Object.entries(TENANCY_CLASSIFICATION)
        .filter(([, tenancy]) => tenancy.kind === 'tenant')
        .map(([model]) => model)
        .sort(),
    );
    for (const model of ['Song', 'Scene', 'MediaLabel', 'Instant', 'Stinger']) {
      expect(SCOPED_TENANT_MODELS).toContain(model);
    }
    for (const model of ['ProgramState', 'ProgramBranding']) {
      expect(SCOPED_TENANT_MODELS).not.toContain(model);
    }
  });

  // gaulatti/alcantara#122: a third tenant sees none of the others' rows through the scoped client.
  it("gives a third team none of the other teams' library rows, nor the rows no team owns", async () => {
    const third = forTeam(prisma, 2_000_000_003);
    const labels = [
      { name: `${RUN}:lib-a`, teamId: TEAM_A },
      { name: `${RUN}:lib-b`, teamId: TEAM_B },
      { name: `${RUN}:lib-none`, teamId: null },
    ];
    await prisma.mediaLabel.createMany({ data: labels });
    const mine = { name: { startsWith: `${RUN}:lib-` } };
    expect(await third.mediaLabel.findMany({ where: mine })).toEqual([]);
    expect(await third.mediaLabel.count({ where: mine })).toBe(0);
    expect(
      await third.mediaLabel.updateMany({
        where: mine,
        data: { description: 'x' },
      }),
    ).toEqual({ count: 0 });
    expect(await third.mediaLabel.deleteMany({ where: mine })).toEqual({
      count: 0,
    });
    const made = await third.mediaLabel.create({
      data: { name: `${RUN}:lib-third` },
    });
    expect(made.teamId).toBe(2_000_000_003);
    expect(
      (await third.mediaLabel.findMany({ where: mine })).map((row) => row.name),
    ).toEqual([`${RUN}:lib-third`]);
    expect(
      (await teamA.mediaLabel.findMany({ where: mine })).map((row) => row.name),
    ).toEqual([`${RUN}:lib-a`]);
  });

  it("never reads another team's rows, with or without the caller's where", async () => {
    const all = await teamA.externalSource.findMany({
      where: ours,
      orderBy: { name: 'asc' },
    });
    const named = await teamA.externalSource.findMany({
      where: { name: `${RUN}:b-1` },
    });
    const withAnd = await teamA.externalSource.findMany({
      where: { AND: { name: { startsWith: `${RUN}:` } } },
    });
    const withAndList = await teamA.externalSource.findMany({
      where: {
        AND: [{ name: { startsWith: `${RUN}:` } }, { transport: 'srt' }],
      },
    });

    expect(all.map((row) => [row.name, row.teamId])).toEqual([
      [`${RUN}:a-1`, TEAM_A],
      [`${RUN}:a-2`, TEAM_A],
    ]);
    expect(named).toEqual([]);
    expect(withAnd.map((row) => row.teamId)).toEqual([TEAM_A, TEAM_A]);
    expect(withAndList.map((row) => row.teamId)).toEqual([TEAM_A, TEAM_A]);
    expect(
      await teamA.externalSource.findFirst({ where: { name: `${RUN}:b-1` } }),
    ).toBeNull();
    expect(
      await teamA.externalSource.findUnique({
        where: { id: await idOf('b-1') },
      }),
    ).toBeNull();
    expect(
      await teamA.externalSource.findUnique({
        where: { id: await idOf('a-1') },
      }),
    ).toMatchObject({
      teamId: TEAM_A,
    });
    expect(await teamA.externalSource.count({ where: ours })).toBe(2);
    expect(await teamA.externalSource.count()).toBe(
      await prisma.externalSource.count({ where: { teamId: TEAM_A } }),
    );
  });

  it("cannot widen its scope with the caller's own teamId", async () => {
    expect(
      await teamA.externalSource.findMany({
        where: { ...ours, teamId: TEAM_B },
      }),
    ).toEqual([]);
    expect(
      await teamA.externalSource.count({ where: { ...ours, teamId: TEAM_B } }),
    ).toBe(0);
    expect(
      await teamA.externalSource.findMany({
        where: { ...ours, teamId: TEAM_A },
      }),
    ).toHaveLength(2);
  });

  it("stores this team's teamId on create, createMany and upsert, whatever the caller supplied", async () => {
    const created = await teamA.externalSource.create({
      data: source('a-created', TEAM_B),
    });
    await teamA.externalSource.createMany({
      data: [source('a-many-1', TEAM_B), source('a-many-2', TEAM_B)],
    });
    await teamA.externalSource.createMany({ data: source('a-many-3', TEAM_B) });
    const upserted = await teamA.externalSource.upsert({
      where: { id: randomUUID() },
      create: source('a-upserted', TEAM_B),
      update: {},
    });

    expect(created.teamId).toBe(TEAM_A);
    expect(upserted.teamId).toBe(TEAM_A);
    expect(
      (
        await prisma.externalSource.findMany({
          where: {
            name: {
              in: ['a-many-1', 'a-many-2', 'a-many-3'].map(
                (name) => `${RUN}:${name}`,
              ),
            },
          },
        })
      ).map((row) => row.teamId),
    ).toEqual([TEAM_A, TEAM_A, TEAM_A]);
  });

  it("does not update or delete another team's row, and cannot move a row to another team", async () => {
    const theirs = await idOf('b-1');
    const mine = await idOf('a-1');

    await expect(
      teamA.externalSource.update({
        where: { id: theirs },
        data: { health: 'touched' },
      }),
    ).rejects.toMatchObject({ code: 'P2025' });
    await expect(
      teamA.externalSource.delete({ where: { id: theirs } }),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(
      await teamA.externalSource.updateMany({
        where: { id: theirs },
        data: { health: 'touched' },
      }),
    ).toEqual({
      count: 0,
    });
    expect(
      await teamA.externalSource.deleteMany({ where: { id: theirs } }),
    ).toEqual({ count: 0 });
    // An upsert on another team's id finds nothing in scope, so it creates this team's own row.
    const fresh = await teamA.externalSource.upsert({
      where: { id: theirs },
      create: source('a-upsert-fresh', TEAM_B),
      update: { health: 'touched' },
    });
    expect(fresh.id).not.toBe(theirs);
    expect(fresh.teamId).toBe(TEAM_A);
    expect(
      await prisma.externalSource.findUniqueOrThrow({ where: { id: theirs } }),
    ).toMatchObject({
      teamId: TEAM_B,
      health: 'unknown',
    });

    const moved = await teamA.externalSource.update({
      where: { id: mine },
      data: { teamId: TEAM_B, health: 'ok' },
    });
    expect(moved).toMatchObject({ teamId: TEAM_A, health: 'ok' });
    expect(
      await teamA.externalSource.updateMany({
        where: ours,
        data: { teamId: TEAM_B },
      }),
    ).toEqual({ count: 3 });
    const upserted = await teamA.externalSource.upsert({
      where: { id: mine },
      create: source('never', TEAM_A),
      update: { teamId: TEAM_B, health: 'upserted' },
    });
    expect(upserted).toMatchObject({ teamId: TEAM_A, health: 'upserted' });
    expect(
      await prisma.externalSource.count({ where: { ...ours, teamId: TEAM_A } }),
    ).toBe(3);

    await teamA.externalSource.delete({ where: { id: mine } });
    expect(
      await prisma.externalSource.findUnique({ where: { id: mine } }),
    ).toBeNull();
    expect(await teamA.externalSource.deleteMany({ where: ours })).toEqual({
      count: 2,
    });
    expect(await prisma.externalSource.count({ where: ours })).toBe(1);
  });

  it('refuses tenant-model operations it does not scope', async () => {
    await expect(
      teamA.externalSource.aggregate({ _count: true }),
    ).rejects.toThrow(
      'Operation aggregate is not scoped to a team and is refused on a tenant model.',
    );
    await expect(
      teamA.externalSource.findFirstOrThrow({ where: ours }),
    ).rejects.toThrow(
      'Operation findFirstOrThrow is not scoped to a team and is refused on a tenant model.',
    );
  });

  it('leaves non-tenant models exactly as the base client', async () => {
    const row = {
      subject: `${RUN}:person`,
      deviceClass: 'desktop',
      profile: {},
    };
    await teamA.operatorPreference.create({ data: row });
    const where = { subject: row.subject };

    expect(await teamA.operatorPreference.findMany({ where })).toEqual(
      await prisma.operatorPreference.findMany({ where }),
    );
    expect(await teamA.operatorPreference.count({ where })).toBe(1);
    await prisma.operatorPreference.deleteMany({ where });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the team id %p',
    (teamId) => {
      expect(() => forTeam(prisma, teamId)).toThrow(
        new Error('A team id must be a positive integer.'),
      );
    },
  );
});
