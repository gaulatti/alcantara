import { ProgramService } from './program.service';

describe('ProgramService.onAirSongId', () => {
  it("is the engine's catalog song on air for the program, or null", () => {
    const getOnAirView = jest.fn((programId: string) => ({
      songId: programId === 'radio' ? 12 : null,
    }));
    const service = Object.assign(Object.create(ProgramService.prototype), {
      songExecutionEngine: { getOnAirView },
    }) as ProgramService;
    expect(service.onAirSongId('radio')).toBe(12);
    expect(service.onAirSongId('tv')).toBeNull();
  });
});
