import 'reflect-metadata';

// Exercise the `design:paramtypes` fallbacks to `Object` that TypeScript emits when a referenced class is
// unresolved at decoration time.
jest.mock('../../program/program.service', () => ({
  ProgramService: undefined,
}));
jest.mock('../../radio/radio.service', () => ({ RadioService: undefined }));
jest.mock('../../radio/song-execution.engine', () => ({
  SongExecutionEngine: undefined,
}));
jest.mock('../../songs/songs.service', () => ({ SongsService: undefined }));
jest.mock('../../auth/pompeii.service', () => ({ PompeiiService: undefined }));

describe('RotationMcpTools metadata', () => {
  it('falls back to Object metadata when its dependencies are unresolved', () => {
    let loaded: typeof import('./rotation');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require('./rotation');
    });
    expect(
      Reflect.getMetadata('design:paramtypes', loaded!.RotationMcpTools),
    ).toEqual([Object, Object, Object, Object, Object]);
  });
});
