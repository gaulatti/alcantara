import { randomUUID } from 'node:crypto';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// gaulatti/alcantara#122: a renamed program keeps its team and branding.
describe('renaming a program keeps its Program row, against Postgres', () => {
  const team = 930_000 + (process.pid % 10_000);
  const prefix = `rename-gate-${randomUUID().slice(0, 8)}`;
  const id = (name: string) => `${prefix}-${name}`;
  let prisma: PrismaService;
  let service: ProgramService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ProgramService(
      prisma,
      {} as never,
      // Nothing is on air, and there is no radio engine to move.
      {
        getOnAirView: () => ({ playbackRequestId: null }),
        renameProgram: () => Promise.resolve(),
        removeProgram: () => undefined,
      } as never,
      undefined,
      undefined,
      noRecorder(),
    );
    jest
      .spyOn(service as never, 'getProgramStateWithScenes')
      .mockResolvedValue({} as never);
  });

  afterAll(async () => {
    const programId = { startsWith: prefix };
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.program.deleteMany({ where: { programId } });
    await prisma?.$disconnect();
  });

  const row = (name: string) =>
    prisma.program.findUnique({
      where: { programId: id(name) },
      select: { teamId: true, branding: { select: { displayName: true } } },
    });

  it('moves the row, with its team and branding, to the new id', async () => {
    await service.createProgram(id('a'), 'radio', null, team);
    await prisma.programBranding.create({
      data: { programId: id('a'), displayName: 'Station' },
    });
    await service.renameProgram(id('a'), id('b'));
    await expect(row('b')).resolves.toEqual({
      teamId: team,
      branding: { displayName: 'Station' },
    });
    await expect(row('a')).resolves.toBeNull();
  });

  it("refuses an id a deleted program's settings still hold, and removes nothing", async () => {
    await service.createProgram(id('gone'), 'radio', null, team + 1);
    await prisma.programBranding.create({
      data: { programId: id('gone'), displayName: 'Old station' },
    });
    await service.deleteProgram(id('gone'));
    await service.createProgram(id('c'), 'radio', null, team);
    await expect(
      service.renameProgram(id('c'), id('gone')),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "That ID belongs to a deleted show's settings. Choose another ID.",
    });
    await expect(row('c')).resolves.toMatchObject({ teamId: team });
    await expect(row('gone')).resolves.toEqual({
      teamId: team + 1,
      branding: { displayName: 'Old station' },
    });
    await expect(
      prisma.programState.count({ where: { programId: id('c') } }),
    ).resolves.toBe(1);
  });

  it('renames a program that has no row of its own', async () => {
    await prisma.programState.create({ data: { programId: id('legacy') } });
    await service.renameProgram(id('legacy'), id('legacy-renamed'));
    await expect(row('legacy-renamed')).resolves.toBeNull();
    await expect(
      prisma.programState.count({
        where: { programId: id('legacy-renamed') },
      }),
    ).resolves.toBe(1);
  });

  it('leaves the row alone when only the type changes', async () => {
    await service.createProgram(id('d'), 'tv', null, team);
    await service.renameProgram(id('d'), id('d'), 'radio');
    await expect(row('d')).resolves.toMatchObject({ teamId: team });
  });
});
