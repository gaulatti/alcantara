import { ConflictException } from '@nestjs/common';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { ProgramService } from './program.service';

// A program that is on air is not renamed: its engines and outputs would be left behind.
describe('renaming a program that is on air', () => {
  const off = {
    id: 1,
    type: 'radio',
    activeSceneId: null,
    fadeToBlack: false,
    activeFlightSequenceId: null,
  };
  const build = (state: Partial<typeof off> | Record<string, unknown> = {}) => {
    const prisma = {
      programState: {
        findUnique: jest.fn(({ where }: { where: { programId: string } }) =>
          Promise.resolve(
            where.programId === 'show' ? { ...off, ...state } : null,
          ),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      program: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      flightSequence: {
        findUnique: jest.fn(({ where }: { where: { id: number } }) =>
          Promise.resolve({ isRunning: where.id === 4 }),
        ),
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
    const engine = {
      getOnAirView: jest.fn((): { playbackRequestId: string | null } => ({
        playbackRequestId: null,
      })),
      renameProgram: jest.fn(),
    };
    const service = new ProgramService(
      prisma as never,
      { isRecoveryRunning: jest.fn().mockResolvedValue(false) } as never,
      engine as never,
      undefined,
      undefined,
      noRecorder(),
    );
    jest
      .spyOn(service as never, 'getProgramStateWithScenes')
      .mockResolvedValue({} as never);
    return { service, prisma, engine };
  };
  const refused = async (service: ProgramService, reason: string) => {
    const error: unknown = await service
      .renameProgram('show', 'other')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(
      `This show is on air (${reason}). Take it off air before renaming it.`,
    );
  };

  it.each([
    [{ activeSceneId: 3 }, 'a scene is on air'],
    [{ fadeToBlack: true }, 'fade to black is on'],
    [{ activeFlightSequenceId: 4 }, 'a log is running'],
  ])('refuses with %p and writes nothing', async (state, reason) => {
    const { service, prisma, engine } = build(state);
    await refused(service, reason);
    expect(prisma.programState.update).not.toHaveBeenCalled();
    expect(engine.renameProgram).not.toHaveBeenCalled();
  });

  it('refuses while the engine or the player has a song, or a scene instant plays', async () => {
    const engineSong = build();
    engineSong.engine.getOnAirView.mockReturnValue({ playbackRequestId: 'p' });
    await refused(engineSong.service, 'a song is playing');

    for (const [map, reason] of [
      ['programSongPlaybackByProgramId', 'a song is playing'],
      ['programSceneInstantPlaybackByProgramId', 'a scene instant is playing'],
    ]) {
      const { service } = build();
      (service as unknown as Record<string, Map<string, unknown>>)[map].set(
        'show',
        { isPlaying: true },
      );
      await refused(service, reason);
    }
  });

  it('renames a program whose selected log is not running', async () => {
    const { service, engine } = build({ activeFlightSequenceId: 5 });
    await service.renameProgram('show', 'other');
    expect(engine.renameProgram).toHaveBeenCalledWith('show', 'other');
  });

  it('writes only while the show is still off air, and refuses when that changed', async () => {
    const { service, prisma, engine } = build({ activeFlightSequenceId: 5 });
    await service.renameProgram('show', 'other');
    expect(prisma.programState.update.mock.calls[0][0].where).toEqual({
      id: 1,
      activeSceneId: null,
      fadeToBlack: false,
      activeFlightSequenceId: 5,
      flightSequences: { none: { id: 5, isRunning: true } },
    });
    engine.renameProgram.mockClear();
    prisma.programState.update.mockRejectedValueOnce(
      Object.assign(new Error('no row'), { code: 'P2025' }),
    );
    await refused(service, 'it changed while it was being renamed');
    expect(engine.renameProgram).not.toHaveBeenCalled();
    prisma.programState.update.mockRejectedValueOnce(new Error('database'));
    await expect(service.renameProgram('show', 'other')).rejects.toThrow(
      'database',
    );
  });

  it('still changes the type of a program on air under the same id', async () => {
    const { service, engine } = build({ activeSceneId: 3 });
    await service.renameProgram('show', 'show', 'both');
    expect(engine.renameProgram).not.toHaveBeenCalled();
  });
});
