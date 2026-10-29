/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports -- Module isolation requires dynamic loading of untyped modules. */
/**
 * TypeScript emits `design:paramtypes` metadata with a guarded fallback to
 * `Object` for every decorated parameter type. These tests load the modules in
 * isolated registries so both sides of those guards are exercised and the
 * resulting reflected metadata is asserted.
 */
describe('webrtc decorator parameter metadata', () => {
  afterEach(() => {
    jest.dontMock('./webrtc.service');
    jest.dontMock('@nestjs/config');
    jest.dontMock('../prisma.service');
  });

  it('reflects Record as a function when a global Record exists', () => {
    const globals = globalThis as Record<string, unknown>;
    const original = globals.Record;
    class RecordStub {}
    globals.Record = RecordStub;
    try {
      jest.isolateModules(() => {
        const { WebrtcController } = require('./webrtc.controller');
        const proto = WebrtcController.prototype;
        expect(
          Reflect.getMetadata('design:paramtypes', proto, 'createInvitation'),
        ).toEqual([Object, RecordStub]);
        expect(Reflect.getMetadata('design:paramtypes', proto, 'join')).toEqual(
          [RecordStub],
        );
      });
    } finally {
      if (original === undefined) delete globals.Record;
      else globals.Record = original;
    }
  });

  it('falls back to Object when the controller dependency type is unavailable', () => {
    jest.doMock('./webrtc.service', () => ({ WebrtcService: {} }));
    jest.isolateModules(() => {
      const { WebrtcController } = require('./webrtc.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', WebrtcController),
      ).toEqual([Object]);
    });
  });

  it('falls back to Object when service dependency types are unavailable', () => {
    jest.doMock('@nestjs/config', () => ({
      ...jest.requireActual('@nestjs/config'),
      ConfigService: {},
    }));
    jest.doMock('../prisma.service', () => ({ PrismaService: {} }));
    jest.isolateModules(() => {
      const { WebrtcService } = require('./webrtc.service');
      expect(Reflect.getMetadata('design:paramtypes', WebrtcService)).toEqual([
        Object,
        Object,
      ]);
    });
  });
});
