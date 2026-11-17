/* eslint-disable @typescript-eslint/no-require-imports */
// Nest reads constructor parameter types from decorator metadata; tsc emits an
// `Object` fallback for each type imported as undefined. This pins that the
// filler classes declare exactly their collaborators, the same way the
// broadcast-destination metadata spec does.
describe('filler decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      jest.doMock('../broadcast-destinations/alana.client', () => ({
        AlanaClient: undefined,
        AlanaRequestError: class AlanaRequestError extends Error {},
      }));
      jest.doMock('../radio/palazzo-machine.client', () => ({
        PalazzoMachineClient: undefined,
      }));
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      jest.doMock('./filler.service', () => ({ FillerService: undefined }));
      const { FillerBindingService } = require('./filler-binding.service') as {
        FillerBindingService: object;
      };
      const { FillerController } = require('./filler.controller') as {
        FillerController: object;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', FillerBindingService),
      ).toEqual([Object, Object]);
      expect(
        Reflect.getMetadata('design:paramtypes', FillerController),
      ).toEqual([Object]);
    });
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      jest.doMock('../broadcast-destinations/alana.client', () => ({
        AlanaClient: undefined,
        AlanaRequestError: class AlanaRequestError extends Error {},
      }));
      jest.doMock('../radio/palazzo-machine.client', () => ({
        PalazzoMachineClient: undefined,
      }));
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      jest.dontMock('./filler.service');
      const { FillerService } = require('./filler.service') as {
        FillerService: object;
      };
      expect(Reflect.getMetadata('design:paramtypes', FillerService)).toEqual([
        Object,
        Object,
        Object,
        Object,
        Object,
      ]);
    });
  });
});
