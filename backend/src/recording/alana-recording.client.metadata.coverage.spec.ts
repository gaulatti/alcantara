/* eslint-disable @typescript-eslint/no-require-imports */
describe('AlanaRecordingClient decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { AlanaRecordingClient } = require('./alana-recording.client') as {
        AlanaRecordingClient: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', AlanaRecordingClient),
      ).toEqual([Object, Object, Function]);
    });
  });
});
