describe('radio scope preflight decorator metadata', () => {
  it('records Object for constructor types whose tokens are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../playout/playout-lease.service', () => ({
        ...jest.requireActual<object>('../playout/playout-lease.service'),
        PlayoutLease: undefined,
      }));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require('./radio-scope-preflight.service') as {
        RadioScopePreflightService: object;
      };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          module.RadioScopePreflightService,
        ),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});
