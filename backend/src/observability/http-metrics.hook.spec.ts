import {
  routeGroupOf,
  UNMATCHED_ROUTE,
  HttpMetricsHook,
} from './http-metrics.hook';

type Handler = (request: unknown, reply: unknown, done: () => void) => void;

function hookWith(addHook: (name: string, handler: Handler) => void) {
  const metrics = { recordHttp: jest.fn() };
  const adapter = { httpAdapter: { getInstance: () => ({ addHook }) } };
  const hook = new HttpMetricsHook(adapter as never, metrics as never);
  return { hook, metrics };
}

describe('routeGroupOf', () => {
  it('labels a matched route by its first static segment of the route pattern', () => {
    expect(
      routeGroupOf({ method: 'GET', routeOptions: { url: '/songs/:id' } }),
    ).toBe('songs');
    expect(
      routeGroupOf({
        method: 'GET',
        routeOptions: { url: '/program/:programId/tape' },
      }),
    ).toBe('program');
    expect(
      routeGroupOf({ method: 'GET', routeOptions: { url: '/metrics' } }),
    ).toBe('metrics');
  });

  it('labels a request with no matched route, or a pattern with no static segment, as unmatched', () => {
    expect(routeGroupOf({ method: 'GET' })).toBe(UNMATCHED_ROUTE);
    expect(
      routeGroupOf({ method: 'GET', routeOptions: { url: '/:slug' } }),
    ).toBe(UNMATCHED_ROUTE);
    expect(routeGroupOf({ method: 'GET', routeOptions: { url: '/*' } })).toBe(
      UNMATCHED_ROUTE,
    );
  });

  it('labels the root pattern, which has no segment at all, as unmatched', () => {
    expect(routeGroupOf({ method: 'GET', routeOptions: { url: '/' } })).toBe(
      UNMATCHED_ROUTE,
    );
  });

  it('never reads the raw URL: a scanner path cannot become a label', () => {
    expect(routeGroupOf({ method: 'GET', routeOptions: undefined })).toBe(
      UNMATCHED_ROUTE,
    );
  });
});

describe('HttpMetricsHook', () => {
  it('records every response from Fastify onResponse, with the status and the seconds', () => {
    let handler: Handler | undefined;
    const { hook, metrics } = hookWith((name, fn) => {
      expect(name).toBe('onResponse');
      handler = fn;
    });
    hook.onModuleInit();
    const done = jest.fn();
    handler?.(
      { method: 'POST', routeOptions: { url: '/songs' } },
      { statusCode: 201, elapsedTime: 250 },
      done,
    );
    expect(metrics.recordHttp).toHaveBeenCalledWith('POST', 'songs', 201, 0.25);
    expect(done).toHaveBeenCalled();
  });

  it('records a 404 under the unmatched label', () => {
    let handler: Handler | undefined;
    const { hook, metrics } = hookWith((_name, fn) => {
      handler = fn;
    });
    hook.onModuleInit();
    handler?.(
      { method: 'GET' },
      { statusCode: 404, elapsedTime: 3 },
      jest.fn(),
    );
    expect(metrics.recordHttp).toHaveBeenCalledWith(
      'GET',
      UNMATCHED_ROUTE,
      404,
      0.003,
    );
  });

  it('refuses to start on an adapter that has no hooks', () => {
    const metrics = { recordHttp: jest.fn() };
    const hook = new HttpMetricsHook(
      { httpAdapter: { getInstance: () => ({}) } } as never,
      metrics as never,
    );
    expect(() => hook.onModuleInit()).not.toThrow();
  });

  it('starts without a hook when the adapter hands back no instance at all', () => {
    const metrics = { recordHttp: jest.fn() };
    const hook = new HttpMetricsHook(
      { httpAdapter: { getInstance: () => undefined } } as never,
      metrics as never,
    );
    expect(() => hook.onModuleInit()).not.toThrow();
  });

  it('does nothing in a context with no HTTP adapter at all', () => {
    const metrics = { recordHttp: jest.fn() };
    const hook = new HttpMetricsHook(
      { httpAdapter: undefined } as never,
      metrics as never,
    );
    expect(() => hook.onModuleInit()).not.toThrow();
    expect(metrics.recordHttp).not.toHaveBeenCalled();
  });
});
