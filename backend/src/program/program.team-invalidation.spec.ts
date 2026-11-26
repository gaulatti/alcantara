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
      program: { upsert: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    const programTeams = { invalidate: jest.fn() };
    const service = new ProgramService(
      prisma as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      noRecorder(),
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
