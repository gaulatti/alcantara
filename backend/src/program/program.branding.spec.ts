// gaulatti/alcantara#335: per-program station marks. The validator, the read and write paths, and
// the Program row that createProgram now creates with the ProgramState.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProgramService, parseBrandingInput } from './program.service';
import { ProgramController } from './program.controller';

describe('parseBrandingInput', () => {
  it('keeps the known marks, trims them, and stores an empty string as null', () => {
    expect(
      parseBrandingInput({
        callsign: '  MR  ',
        subtitle: '',
        hashtag: '#ModoSanremoMR',
      }),
    ).toEqual({ callsign: 'MR', subtitle: null, hashtag: '#ModoSanremoMR' });
  });

  it('accepts null to clear a mark', () => {
    expect(parseBrandingInput({ siteUrl: null })).toEqual({ siteUrl: null });
  });

  it('rejects an unknown field', () => {
    expect(() => parseBrandingInput({ teamId: 3 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a logo that is not an absolute https URL', () => {
    expect(() =>
      parseBrandingInput({ logoUrl: 'http://example.com/logo.png' }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseBrandingInput({ logoUrl: 'javascript:alert(1)' }),
    ).toThrow(BadRequestException);
    expect(() => parseBrandingInput({ logoUrl: 'not a url' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a value longer than its limit and a non-string value', () => {
    expect(() => parseBrandingInput({ callsign: 'x'.repeat(33) })).toThrow(
      BadRequestException,
    );
    expect(() => parseBrandingInput({ callsign: 7 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a body that is not an object', () => {
    expect(() => parseBrandingInput(null)).toThrow(BadRequestException);
    expect(() => parseBrandingInput(['MR'])).toThrow(BadRequestException);
  });
});

function serviceWith(prisma: Record<string, unknown>): ProgramService {
  return Object.assign(Object.create(ProgramService.prototype), { prisma });
}

describe('branding coverage (gaulatti/alcantara#335)', () => {
  it('reads null for a program that has no branding row', async () => {
    const service = serviceWith({
      programBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.getBranding('bare')).resolves.toBeNull();
  });

  it('writes the marks through an upsert and returns only the public marks', async () => {
    const upsert = jest.fn().mockResolvedValue({
      programId: 'main',
      teamId: 9,
      displayName: 'Modoradio',
      callsign: 'MR',
      subtitle: null,
      logoUrl: 'https://cdn.example.com/logo.png',
      hashtag: '#ModoSanremoMR',
      siteUrl: null,
      defaultChyron: null,
      updatedAt: new Date(),
    });
    const service = serviceWith({
      program: {
        findUnique: jest.fn().mockResolvedValue({ programId: 'main' }),
      },
      programBranding: { upsert },
    });
    const marks = await service.putBranding('main', {
      displayName: ' Modoradio ',
      callsign: 'MR',
      logoUrl: 'https://cdn.example.com/logo.png',
      hashtag: '#ModoSanremoMR',
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: 'main' },
        create: expect.objectContaining({
          programId: 'main',
          displayName: 'Modoradio',
          callsign: 'MR',
        }),
        update: expect.objectContaining({
          displayName: 'Modoradio',
          callsign: 'MR',
        }),
      }),
    );
    expect(marks).toEqual({
      displayName: 'Modoradio',
      callsign: 'MR',
      subtitle: null,
      logoUrl: 'https://cdn.example.com/logo.png',
      hashtag: '#ModoSanremoMR',
      siteUrl: null,
      defaultChyron: null,
    });
    expect(marks).not.toHaveProperty('teamId');
  });

  it('treats an empty logo as cleared, and a null value as a clear', () => {
    expect(parseBrandingInput({ logoUrl: '   ' })).toEqual({ logoUrl: null });
    expect(parseBrandingInput({ hashtag: null, siteUrl: '' })).toEqual({
      hashtag: null,
      siteUrl: null,
    });
  });

  it('refuses an oversized display name and an oversized chyron', () => {
    expect(() => parseBrandingInput({ displayName: 'x'.repeat(121) })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseBrandingInput({ defaultChyron: 'x'.repeat(241) }),
    ).toThrow(BadRequestException);
  });

  it('stores team 0 as no team, and a positive team as that team', async () => {
    const make = (teamId: number) => {
      const upsert = jest.fn().mockResolvedValue({});
      const service = Object.assign(
        serviceWith({
          programState: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
          },
          program: { upsert },
          $transaction: jest.fn(async (ops: Promise<unknown>[]) =>
            Promise.all(ops),
          ),
        }),
        {
          getProgramStateWithScenes: jest.fn().mockResolvedValue({}),
          programTemplateUpdateData: () => ({}),
          createDefaultProgramAudioMixerSettings: () => ({}),
          normalizeProgramId: (id: string) => id,
        },
      ) as unknown as ProgramService;
      return { service, upsert, teamId };
    };
    const positive = make(9);
    await positive.service.createProgram(
      'with-team',
      'tv',
      null,
      positive.teamId,
    );
    expect(positive.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { programId: 'with-team', teamId: 9 },
      }),
    );
    const zero = make(0);
    await zero.service.createProgram('zero', 'tv', null, zero.teamId);
    expect(zero.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { programId: 'zero', teamId: null } }),
    );
  });
});

describe('ProgramService branding and program creation', () => {
  it('reads only the public marks, and null when a program has none', async () => {
    const service = serviceWith({
      programBranding: {
        findUnique: jest.fn().mockResolvedValue({
          programId: 'main',
          teamId: 9,
          callsign: 'MR',
          subtitle: 'MODORADIO',
          logoUrl: null,
          hashtag: null,
          siteUrl: null,
          defaultChyron: null,
          displayName: null,
          updatedAt: new Date(),
        }),
      },
    });
    const marks = await service.getBranding('main');
    expect(marks).toEqual({
      displayName: null,
      callsign: 'MR',
      subtitle: 'MODORADIO',
      logoUrl: null,
      hashtag: null,
      siteUrl: null,
      defaultChyron: null,
    });
    expect(marks).not.toHaveProperty('teamId');
  });

  it('refuses a write for a program that has no Program row', async () => {
    const service = serviceWith({
      program: { findUnique: jest.fn().mockResolvedValue(null) },
      programBranding: { upsert: jest.fn() },
    });
    await expect(
      service.putBranding('ghost', { callsign: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gives the new Program row the caller team when one is supplied', async () => {
    const programUpsert = jest.fn().mockResolvedValue({});
    const transaction = jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    const service = Object.assign(
      serviceWith({
        programState: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        program: { upsert: programUpsert },
        $transaction: transaction,
      }),
      {
        getProgramStateWithScenes: jest.fn().mockResolvedValue({}),
        programTemplateUpdateData: () => ({}),
        createDefaultProgramAudioMixerSettings: () => ({}),
        normalizeProgramId: (id: string) => id,
      },
    ) as unknown as ProgramService;
    await service.createProgram('team-owned', 'tv', null, 9);
    expect(programUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { programId: 'team-owned', teamId: 9 },
      }),
    );
  });

  it('stores no team for team 0, the test-mode value', async () => {
    const programUpsert = jest.fn().mockResolvedValue({});
    const transaction = jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    const service = Object.assign(
      serviceWith({
        programState: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        program: { upsert: programUpsert },
        $transaction: transaction,
      }),
      {
        getProgramStateWithScenes: jest.fn().mockResolvedValue({}),
        programTemplateUpdateData: () => ({}),
        createDefaultProgramAudioMixerSettings: () => ({}),
        normalizeProgramId: (id: string) => id,
      },
    ) as unknown as ProgramService;
    await service.createProgram('test-mode', 'tv', null, 0);
    expect(programUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { programId: 'test-mode', teamId: null },
      }),
    );
  });

  it('creates the Program row in the same transaction as the ProgramState', async () => {
    const programUpsert = jest.fn().mockResolvedValue({});
    const stateCreate = jest.fn().mockResolvedValue({});
    const transaction = jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    const service = Object.assign(
      serviceWith({
        programState: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: stateCreate,
        },
        program: { upsert: programUpsert },
        $transaction: transaction,
      }),
      {
        getProgramStateWithScenes: jest
          .fn()
          .mockResolvedValue({ programId: 'fresh' }),
        programTemplateUpdateData: () => ({}),
        createDefaultProgramAudioMixerSettings: () => ({}),
        normalizeProgramId: (id: string) => id,
      },
    ) as unknown as ProgramService;
    await service.createProgram('fresh');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(programUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: 'fresh' },
        create: { programId: 'fresh', teamId: null },
      }),
    );
    expect(stateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ programId: 'fresh' }),
      }),
    );
  });
});

describe('branding routes delegate to the service (gaulatti/alcantara#335)', () => {
  it('GET returns the service marks and PUT passes the body through', async () => {
    const programService = {
      getBranding: jest.fn().mockResolvedValue({ callsign: 'MR' }),
      putBranding: jest.fn().mockResolvedValue({ callsign: 'MR2' }),
    };
    const controller = Object.assign(
      Object.create(ProgramController.prototype),
      { programService },
    );
    await expect(controller.getBranding('main')).resolves.toEqual({
      callsign: 'MR',
    });
    await expect(
      controller.putBranding('main', { callsign: 'MR2' }),
    ).resolves.toEqual({ callsign: 'MR2' });
    expect(programService.getBranding).toHaveBeenCalledWith('main');
    expect(programService.putBranding).toHaveBeenCalledWith('main', {
      callsign: 'MR2',
    });
  });
});
