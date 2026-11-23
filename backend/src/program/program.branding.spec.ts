// gaulatti/alcantara#335: per-program station marks. The validator, the read and write paths, and
// the Program row that createProgram now creates with the ProgramState.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProgramService, parseBrandingInput } from './program.service';

describe('parseBrandingInput', () => {
  it('keeps the known marks, trims them, and stores an empty string as null', () => {
    expect(
      parseBrandingInput({ callsign: '  MR  ', subtitle: '', hashtag: '#ModoSanremoMR' }),
    ).toEqual({ callsign: 'MR', subtitle: null, hashtag: '#ModoSanremoMR' });
  });

  it('accepts null to clear a mark', () => {
    expect(parseBrandingInput({ siteUrl: null })).toEqual({ siteUrl: null });
  });

  it('rejects an unknown field', () => {
    expect(() => parseBrandingInput({ teamId: 3 })).toThrow(BadRequestException);
  });

  it('rejects a logo that is not an absolute https URL', () => {
    expect(() => parseBrandingInput({ logoUrl: 'http://example.com/logo.png' })).toThrow(BadRequestException);
    expect(() => parseBrandingInput({ logoUrl: 'javascript:alert(1)' })).toThrow(BadRequestException);
    expect(() => parseBrandingInput({ logoUrl: 'not a url' })).toThrow(BadRequestException);
  });

  it('rejects a value longer than its limit and a non-string value', () => {
    expect(() => parseBrandingInput({ callsign: 'x'.repeat(33) })).toThrow(BadRequestException);
    expect(() => parseBrandingInput({ callsign: 7 })).toThrow(BadRequestException);
  });

  it('rejects a body that is not an object', () => {
    expect(() => parseBrandingInput(null)).toThrow(BadRequestException);
    expect(() => parseBrandingInput(['MR'])).toThrow(BadRequestException);
  });
});

function serviceWith(prisma: Record<string, unknown>): ProgramService {
  return Object.assign(Object.create(ProgramService.prototype), { prisma });
}

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
    await expect(service.putBranding('ghost', { callsign: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gives the new Program row the caller team when one is supplied', async () => {
    const programUpsert = jest.fn().mockResolvedValue({});
    const transaction = jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const service = Object.assign(serviceWith({
      programState: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      program: { upsert: programUpsert },
      $transaction: transaction,
    }), {
      getProgramStateWithScenes: jest.fn().mockResolvedValue({}),
      programTemplateUpdateData: () => ({}),
      createDefaultProgramAudioMixerSettings: () => ({}),
      normalizeProgramId: (id: string) => id,
    });
    await service.createProgram('team-owned', 'tv', null, 9);
    expect(programUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { programId: 'team-owned', teamId: 9 } }),
    );
  });

  it('creates the Program row in the same transaction as the ProgramState', async () => {
    const programUpsert = jest.fn().mockResolvedValue({});
    const stateCreate = jest.fn().mockResolvedValue({});
    const transaction = jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const service = Object.assign(serviceWith({
      programState: { findUnique: jest.fn().mockResolvedValue(null), create: stateCreate },
      program: { upsert: programUpsert },
      $transaction: transaction,
    }), {
      getProgramStateWithScenes: jest.fn().mockResolvedValue({ programId: 'fresh' }),
      programTemplateUpdateData: () => ({}),
      createDefaultProgramAudioMixerSettings: () => ({}),
      normalizeProgramId: (id: string) => id,
    });
    await service.createProgram('fresh');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(programUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { programId: 'fresh' }, create: { programId: 'fresh' } }),
    );
    expect(stateCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ programId: 'fresh' }) }),
    );
  });
});
