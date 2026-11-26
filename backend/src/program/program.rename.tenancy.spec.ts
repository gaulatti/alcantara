import { randomUUID } from 'node:crypto';
import { FillerBindingService } from '../filler/filler-binding.service';
import { FillerService } from '../filler/filler.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { RadioService } from '../radio/radio.service';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';
import { releaseActiveFiller } from '../filler/release-active-filler';

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

  const recovery = { isRecoveryRunning: jest.fn().mockResolvedValue(false) };

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ProgramService(
      prisma,
      recovery as never,
      {} as never,
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
    await prisma?.fillerLeg.deleteMany({ where: { programId } });
    await prisma?.fillerVersion.deleteMany({ where: { programId } });
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

  /** A program with a prepared filler on both legs, and radio settings with no recovery playlist of their own. */
  const configured = async (name: string) => {
    await service.createProgram(id(name), 'both', null, team);
    const state = await prisma.programState.findUniqueOrThrow({
      where: { programId: id(name) },
    });
    await prisma.radioSettings.create({ data: { programStateId: state.id } });
    for (const leg of ['television', 'radio']) {
      const version = await prisma.fillerVersion.create({
        data: {
          id: `${id(name)}-${leg}`,
          programId: id(name),
          leg,
          checksum: 'c',
          config: { sources: [], mode: 'loop', profileChecksum: 'p' },
          status: 'ready',
          createdBy: 'tester',
        },
      });
      await prisma.fillerLeg.create({
        data: { programId: id(name), leg, activeVersionId: version.id },
      });
    }
  };
  const binding = () =>
    new FillerBindingService(prisma, new ManagedMetricsService());
  const alana = { activeFiller: { profileChecksum: 'p' } } as never;
  /** What a radio Start with fallback does, down to the version it sends Palazzo. */
  const radioStart = async (name: string) => {
    const palazzo = {
      getAutomation: jest.fn().mockResolvedValue({ lastSequence: 0 }),
      commandAutomation: jest.fn(),
    };
    const radio = new RadioService(
      prisma,
      palazzo as never,
      { get: () => 'http://palazzo:3100' } as never,
      {} as never,
      { teamId: team } as never,
    );
    return radio
      .setRecoveryAutomation(id(name), 'start')
      .then(() => 'started')
      .catch((error: Error) => error.message);
  };

  it('moves the filler with the program, and Start then behaves as with no filler', async () => {
    await configured('filled');
    await expect(service.hasPreparedFiller(id('filled'))).resolves.toBe(true);
    // Before the rename the prepared version binds, and Alana, not holding it, refuses.
    await expect(
      binding().televisionStartBinding(id('filled'), alana),
    ).rejects.toThrow('Alana is not prepared');

    // While a session holds the filler, and while Palazzo reports recovery running, the rename is refused.
    const onAir = {
      status: 409,
      message: 'Its filler is on air. Stop it before renaming.',
    };
    await expect(
      service.renameProgram(id('filled'), id('moved')),
    ).rejects.toMatchObject(onAir);
    for (const leg of ['radio', 'television'] as const)
      await releaseActiveFiller(prisma, id('filled'), leg);
    recovery.isRecoveryRunning.mockResolvedValueOnce(true);
    await expect(
      service.renameProgram(id('filled'), id('moved')),
    ).rejects.toMatchObject(onAir);

    await service.renameProgram(id('filled'), id('moved'));

    await expect(service.hasPreparedFiller(id('moved'))).resolves.toBe(false);
    await expect(
      prisma.fillerLeg.findMany({
        where: { programId: id('moved') },
        select: { leg: true, pendingVersionId: true, activeVersionId: true },
        orderBy: { leg: 'asc' },
      }),
    ).resolves.toEqual([
      { leg: 'radio', pendingVersionId: null, activeVersionId: null },
      { leg: 'television', pendingVersionId: null, activeVersionId: null },
    ]);
    for (const programId of [id('filled'), id('moved')]) {
      await expect(
        prisma.fillerVersion.count({ where: { programId } }),
      ).resolves.toBe(programId === id('moved') ? 2 : 0);
    }

    await service.createProgram(id('never'), 'both', null, team);
    const state = await prisma.programState.findUniqueOrThrow({
      where: { programId: id('never') },
    });
    await prisma.radioSettings.create({ data: { programStateId: state.id } });
    // Television: no version to bind, exactly as a program that never had a filler.
    for (const name of ['moved', 'never']) {
      await expect(
        binding().televisionStartBinding(id(name), alana),
      ).resolves.toBeNull();
    }
    // Radio: the same answer as the program that never had one, then the same start with the settings' playlist.
    const never = await radioStart('never');
    await expect(radioStart('moved')).resolves.toBe(never);
    expect(never).toBe('prepare a recovery playlist first');

    const view = await new FillerService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      new ManagedMetricsService(),
      { teamId: team } as never,
    ).getState(id('moved'));
    expect(view.legs.radio).toEqual({
      pending: null,
      active: null,
      needsPreparing: true,
    });
  });

  it("refuses an id a deleted program's filler still holds", async () => {
    await prisma.fillerLeg.create({
      data: { programId: id('held'), leg: 'radio' },
    });
    await service.createProgram(id('e'), 'radio', null, team);
    await expect(
      service.renameProgram(id('e'), id('held')),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an id a deleted program's filler version still holds, with no leg", async () => {
    await prisma.fillerVersion.create({
      data: {
        id: id('version'),
        programId: id('orphan'),
        leg: 'radio',
        checksum: 'x',
        config: {},
        createdBy: 'test',
      },
    });
    await service.createProgram(id('f'), 'radio', null, team);
    await expect(
      service.renameProgram(id('f'), id('orphan')),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('leaves the row alone when only the type changes', async () => {
    await service.createProgram(id('d'), 'tv', null, team);
    await service.renameProgram(id('d'), id('d'), 'radio');
    await expect(row('d')).resolves.toMatchObject({ teamId: team });
  });
});
