/* eslint-disable @typescript-eslint/no-require-imports */
describe('Tape controllers decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('TapeController falls back to Object when the client is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./alana-recording.client', () => ({
        AlanaRecordingClient: undefined,
      }));
      const { TapeController } = require('./tape.controller') as {
        TapeController: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', TapeController)).toEqual([
        Object,
      ]);
    });
  });

  it('RecordingFileController falls back to Object for undefined collaborators', () => {
    jest.isolateModules(() => {
      jest.doMock('./alana-recording.client', () => ({
        AlanaRecordingClient: undefined,
      }));
      jest.doMock('./recording-download-ticket.service', () => ({
        RecordingDownloadTicketService: undefined,
      }));
      const { RecordingFileController } =
        require('./recording-file.controller') as {
          RecordingFileController: new (...args: never[]) => unknown;
        };
      expect(
        Reflect.getMetadata('design:paramtypes', RecordingFileController),
      ).toEqual([Object, Object]);
      const handlerTypes = Reflect.getMetadata(
        'design:paramtypes',
        RecordingFileController.prototype as object,
        'file',
      ) as unknown[];
      expect(handlerTypes).toEqual([String, Object, Object, Object]);
    });
  });
});

describe('RecordingFileController return metadata', () => {
  it('falls back to Object when Promise is unresolved at decoration time', () => {
    const globals = globalThis as { Promise?: PromiseConstructor };
    const originalPromise = globals.Promise;
    let loaded: typeof import('./recording-file.controller');
    jest.isolateModules(() => {
      globals.Promise = undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        loaded = require('./recording-file.controller');
      } finally {
        globals.Promise = originalPromise;
      }
    });
    const { RecordingFileController } = loaded!;
    expect(
      Reflect.getMetadata(
        'design:returntype',
        RecordingFileController.prototype,
        'file',
      ),
    ).toBe(Object);
    expect(globals.Promise).toBe(originalPromise);
  });
});
