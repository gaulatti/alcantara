import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { ProgramService } from './program.service';

// gaulatti/alcantara#122: a program's remembered team is forgotten when the program is created, renamed or deleted.
describe('program changes forget the remembered team', () => {
  const build = () => {
    const rows = new Set(['old']);
    const prisma = {
      programState: {
        findUnique: jest.fn(({ where }: { where: { programId: string } }) =>
          Promise.resolve(
            rows.has(where.programId) ? { id: 1, type: 'tv' } : null,
          ),
        ),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      program: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fillerVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fillerLeg: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    const programTeams = { invalidate: jest.fn() };
    const service = new ProgramService(
      prisma as never,
      { isRecoveryRunning: jest.fn().mockResolvedValue(false) } as never,
      {} as never,
      undefined,
      undefined,
      noRecorder(),
      undefined,
      undefined,
      programTeams as never,
    );
    jest
      .spyOn(service as never, 'getProgramStateWithScenes')
      .mockResolvedValue({} as never);
    return { service, programTeams };
  };

  it('on create, rename (both ids) and delete', async () => {
    const { service, programTeams } = build();
    await service.createProgram('fresh');
    await service.renameProgram('old', 'new');
    await service.deleteProgram('old');
    expect(programTeams.invalidate.mock.calls).toEqual([
      ['fresh'],
      ['old'],
      ['new'],
      ['old'],
    ]);
  });
});
