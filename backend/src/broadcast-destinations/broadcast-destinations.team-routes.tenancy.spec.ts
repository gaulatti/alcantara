import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient, AlanaRequestError } from './alana.client';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { ProgramTeamAccess } from '../tenancy/program-team-access';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// #122 slice 5: the destination routes that took no team (the program view, retire and restore, reorder, and the
// selection a start or reload checks) read and write through the caller's team, against the real scoped client.
describe("destination routes confined to the caller's team, against Postgres", () => {
  const team = 830_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `dest-gate-${randomUUID().slice(0, 8)}`;
  const mineA = `${prefix}-mine-a`;
  const mineB = `${prefix}-mine-b`;
  const theirs = `${prefix}-theirs`;
  const programId = `${prefix}-tv`;
  let prisma: PrismaService;
  let service: BroadcastDestinationsService;

  const unavailable = () =>
    new AlanaRequestError(503, {
      requestedState: 'stopped',
      actualState: 'stopped',
      transition: null,
      readiness: false,
      lastSequence: 0,
      activeDestinations: null,
      pendingDestinations: null,
      destinations: [],
      commandResult: null,
      error: 'Executor unavailable',
    } as never);

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new BroadcastDestinationsService(
      prisma,
      {
        status: jest.fn(() => Promise.reject(unavailable())),
      } as unknown as AlanaClient,
      { recordBroadcastDestination: jest.fn() } as never,
      {} as never,
      { cancelDeletion: jest.fn(), scheduleDeletion: jest.fn() } as never,
    );
    for (const [id, teamId, position] of [
      [mineA, team, 0],
      [mineB, team, 1],
      [theirs, other, 0],
    ] as const) {
      // No `service`: a hand-typed secret reference, so retiring it calls Secrets Manager for nothing.
      await prisma.broadcastDestination.create({
        data: {
          id,
          teamId,
          displayName: id,
          secretId: `fake/${id}`,
          secretVersionId: 'fake-version',
          position,
        },
      });
    }
    await prisma.programState.create({ data: { programId, type: 'tv' } });
  });

  afterAll(async () => {
    await prisma?.broadcastDestination.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.$disconnect();
  });

  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  const position = async (id: string) =>
    (await prisma.broadcastDestination.findUniqueOrThrow({ where: { id } }))
      .position;

  it("shows a caller the program's selectable destinations of their own team only", async () => {
    const view = await service.getProgramState(programId, team);
    expect(view.available).toBe(false);
    expect(ids(view.destinations)).toEqual([mineA, mineB]);
    expect(
      ids((await service.getProgramState(programId, other)).destinations),
    ).toEqual([theirs]);
    expect(ids((await service.getProgramState(programId)).destinations)).toEqual(
      expect.arrayContaining([mineA, mineB, theirs]),
    );
  });

  it("a caller's program state and reconcile never reach another team's downstream entries or runtime rows", async () => {
    const ownProgram = `${prefix}-own-tv`;
    const otherProgram = `${prefix}-other-tv`;
    const live = new BroadcastDestinationsService(
      prisma,
      {
        status: jest.fn(async () => ({
          requestedState: 'stopped',
          actualState: 'stopped',
          transition: null,
          readiness: true,
          lastSequence: 3,
          activeDestinations: null,
          pendingDestinations: null,
          destinations: [
            { id: mineA, state: 'stopped' },
            { id: theirs, state: 'stopped' },
          ],
          commandResult: null,
          error: null,
        })),
      } as unknown as AlanaClient,
      { recordBroadcastDestination: jest.fn() } as never,
      {} as never,
      { cancelDeletion: jest.fn(), scheduleDeletion: jest.fn() } as never,
      new ProgramTeamAccess(
        prisma,
        { teamId: 0 } as never,
        { recordProgramTeamCheck: jest.fn() } as never,
      ),
    );
    try {
      await prisma.program.createMany({
        data: [
          { programId: ownProgram, teamId: team },
          { programId: otherProgram, teamId: other },
        ],
      });
      await prisma.programState.createMany({
        data: [
          { programId: ownProgram, type: 'tv' },
          { programId: otherProgram, type: 'tv' },
        ],
      });
      await prisma.broadcastDestinationRuntime.create({
        data: {
          programId: otherProgram,
          nextSequence: 42,
          requestedState: 'stopped',
          actualState: 'stopped',
        },
      });

      const view = await live.getProgramState(ownProgram, team);
      expect(ids(view.downstream.destinations)).toEqual([mineA]);
      expect(ids(view.downstream.destinations)).not.toContain(theirs);
      expect(
        await prisma.broadcastDestinationRuntime.findUnique({
          where: { programId: ownProgram },
        }),
      ).not.toBeNull();

      // Asking for another team's program with this team's caller reconciles nothing of it.
      await live.getProgramState(otherProgram, team);
      expect(
        (
          await prisma.broadcastDestinationRuntime.findUniqueOrThrow({
            where: { programId: otherProgram },
          })
        ).nextSequence,
      ).toBe(42);
    } finally {
      await prisma.broadcastDestinationRuntime.deleteMany({
        where: { programId: { in: [ownProgram, otherProgram] } },
      });
      await prisma.programState.deleteMany({
        where: { programId: { in: [ownProgram, otherProgram] } },
      });
      await prisma.program.deleteMany({
        where: { programId: { in: [ownProgram, otherProgram] } },
      });
    }
  });

  it("reconciles a program no team owns, and still reconciles when the owner lookup fails or hangs", async () => {
    const liveState = (overrides: Record<string, unknown> = {}) =>
      ({
        requestedState: 'stopped',
        actualState: 'stopped',
        transition: null,
        readiness: true,
        lastSequence: 3,
        activeDestinations: null,
        pendingDestinations: null,
        destinations: [],
        commandResult: null,
        error: null,
        ...overrides,
      }) as never;
    const services = (teams: ProgramTeamAccess) =>
      new BroadcastDestinationsService(
        prisma,
        { status: jest.fn(async () => liveState()) } as unknown as AlanaClient,
        { recordBroadcastDestination: jest.fn() } as never,
        {} as never,
        { cancelDeletion: jest.fn(), scheduleDeletion: jest.fn() } as never,
        teams,
      );
    const failing = new ProgramTeamAccess(
      { program: { findUnique: jest.fn(async () => { throw new Error('lookup down'); }) } } as never,
      { teamId: 0 } as never,
      { recordProgramTeamCheck: jest.fn() } as never,
    );
    const hung = new ProgramTeamAccess(
      { program: { findUnique: jest.fn(() => new Promise(() => undefined)) } } as never,
      { teamId: 0 } as never,
      { recordProgramTeamCheck: jest.fn() } as never,
    );
    const unowned = `${prefix}-unowned-tv`;
    const failingProgram = `${prefix}-failing-tv`;
    const hungProgram = `${prefix}-hung-tv`;
    const all = [unowned, failingProgram, hungProgram];
    try {
      await prisma.program.create({ data: { programId: unowned, teamId: null } });
      await prisma.programState.createMany({
        data: all.map((id) => ({ programId: id, type: 'tv' })),
      });
      await services(new ProgramTeamAccess(prisma, { teamId: 0 } as never, { recordProgramTeamCheck: jest.fn() } as never)).getProgramState(unowned, team);
      await services(failing).getProgramState(failingProgram, team);
      await services(hung).getProgramState(hungProgram, team);
      for (const id of all) {
        expect(
          await prisma.broadcastDestinationRuntime.findUnique({ where: { programId: id } }),
        ).not.toBeNull();
      }
    } finally {
      await prisma.broadcastDestinationRuntime.deleteMany({ where: { programId: { in: all } } });
      await prisma.programState.deleteMany({ where: { programId: { in: all } } });
      await prisma.program.deleteMany({ where: { programId: { in: all } } });
    }
  });

  it("names only the caller's own destinations in the active and pending selections", async () => {
    const selection = {
      version: 'v1',
      selectionHash: 'a'.repeat(64),
      count: 2,
      destinationIds: [mineA, theirs],
    };
    const withSelections = new BroadcastDestinationsService(
      prisma,
      {
        status: jest.fn(async () => ({
          requestedState: 'stopped',
          actualState: 'stopped',
          transition: null,
          readiness: true,
          lastSequence: 3,
          activeDestinations: selection,
          pendingDestinations: selection,
          destinations: [],
          commandResult: null,
          error: null,
        })),
      } as unknown as AlanaClient,
      { recordBroadcastDestination: jest.fn() } as never,
      {} as never,
      { cancelDeletion: jest.fn(), scheduleDeletion: jest.fn() } as never,
      new ProgramTeamAccess(prisma, { teamId: 0 } as never, { recordProgramTeamCheck: jest.fn() } as never),
    );
    const view = await withSelections.getProgramState(programId, team);
    expect(view.downstream.activeDestinations?.destinationIds).toEqual([mineA]);
    expect(view.downstream.pendingDestinations?.destinationIds).toEqual([mineA]);
  });

  it("retires and restores the caller's destination, and finds no other team's", async () => {
    await expect(service.setRetired(theirs, true, team)).rejects.toThrow(
      NotFoundException,
    );
    expect(
      (await prisma.broadcastDestination.findUniqueOrThrow({ where: { id: theirs } }))
        .retiredAt,
    ).toBeNull();

    const retired = await service.setRetired(mineB, true, team);
    expect(retired.retiredAt).not.toBeNull();
    const restored = await service.setRetired(mineB, false, team);
    expect(restored.retiredAt).toBeNull();
    expect(restored.teamId).toBe(team);
  });

  it("reorders exactly the caller's catalog and leaves another team's order alone", async () => {
    for (const order of [[mineA], [mineB, mineA, theirs]]) {
      await expect(
        service.reorderDestinations(order, team),
      ).rejects.toThrow('Destination order must include the complete catalog');
    }

    const catalog = await service.reorderDestinations([mineB, mineA], team);
    expect(ids(catalog)).toEqual([mineB, mineA]);
    expect(await position(mineB)).toBe(0);
    expect(await position(mineA)).toBe(1);
    expect(await position(theirs)).toBe(0);
  });

  it("refuses to select another team's destination for a start or reload", async () => {
    const selectable = (destinationIds: string[], callerTeam: number) =>
      (
        service as unknown as {
          assertCurrentlySelectable(
            destinationIds: string[],
            callerTeam: number,
          ): Promise<Array<{ id: string }>>;
        }
      ).assertCurrentlySelectable(destinationIds, callerTeam);

    await expect(selectable([theirs], team)).rejects.toThrow(
      new BadRequestException(
        'Every selected destination must exist and not be retired',
      ),
    );
    await expect(selectable([mineA, theirs], team)).rejects.toThrow(
      BadRequestException,
    );
    expect(ids(await selectable([mineA], team))).toEqual([mineA]);
    expect(ids(await selectable([theirs], 0))).toEqual([theirs]);
  });
});
