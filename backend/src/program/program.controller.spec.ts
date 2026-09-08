import { ProgramController } from './program.controller';

describe('ProgramController template registration', () => {
  const registration = {
    templateUrl: 'https://cdn.fifthbell.com/templates/manifest.json',
    templateManifest: {
      kind: 'alcantara.program-template',
      contractVersion: 1,
      id: 'fifthbell.live-program',
    },
    templateVerifiedAt: new Date('2026-09-08T18:00:00.000Z'),
  };

  it('inspects and persists a supplied template URL when creating a program', async () => {
    const programService = {
      createProgram: jest.fn().mockResolvedValue({ programId: 'fifthbell' }),
    };
    const templateService = {
      inspect: jest.fn().mockResolvedValue(registration),
    };
    const controller = new ProgramController(
      programService as never,
      {} as never,
      templateService as never,
    );

    await controller.createProgram({
      programId: 'fifthbell',
      type: 'tv',
      templateUrl: registration.templateUrl,
    });

    expect(templateService.inspect).toHaveBeenCalledWith(
      registration.templateUrl,
    );
    expect(programService.createProgram).toHaveBeenCalledWith(
      'fifthbell',
      'tv',
      registration,
    );
  });

  it('clears a template explicitly without performing a network request', async () => {
    const programService = {
      renameProgram: jest.fn().mockResolvedValue({ programId: 'main' }),
    };
    const templateService = { inspect: jest.fn() };
    const controller = new ProgramController(
      programService as never,
      {} as never,
      templateService as never,
    );

    await controller.renameProgram('main', {
      nextProgramId: 'main',
      templateUrl: null,
    });

    expect(templateService.inspect).not.toHaveBeenCalled();
    expect(programService.renameProgram).toHaveBeenCalledWith(
      'main',
      'main',
      undefined,
      null,
    );
  });
});
