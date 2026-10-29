/* eslint-disable @typescript-eslint/no-require-imports */
describe('RecordingController decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when the client class is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./alana-recording.client', () => ({
        AlanaRecordingClient: undefined,
      }));
      const { RecordingController } = require('./recording.controller') as {
        RecordingController: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', RecordingController),
      ).toEqual([Object]);
    });
  });
});
