import {
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RendererAuthService } from './renderer-auth.service';

const SHARED = 'shared-key-fictional-built-in-this-test-000';
const FLEET = 'fleet-key-fictional-built-in-this-test-0000';

function setup(environment: Record<string, string> = { WEBRTC_RENDERER_KEY: SHARED, WEBRTC_FLEET_KEY: FLEET }) {
  const keys = { match: jest.fn(async () => 'none' as 'program' | 'other-program' | 'none') };
  const metrics = { recordRendererAuth: jest.fn() };
  const service = new RendererAuthService(new ConfigService(environment), keys as never, metrics as never);
  return { service, keys, metrics };
}

describe('RendererAuthService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("takes a program's own key, quietly", async () => {
    const { service, keys, metrics } = setup();
    keys.match.mockResolvedValue('program');
    await expect(service.authorizeProgram('on_air', 'k', 'station-a')).resolves.toBeUndefined();
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('on_air', 'program', 'accepted');
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses another program's key with 403", async () => {
    const { service, keys, metrics } = setup();
    keys.match.mockResolvedValue('other-program');
    await expect(service.authorizeProgram('on_air', 'k', 'station-b')).rejects.toThrow(ForbiddenException);
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('on_air', 'program', 'refused');
  });

  it('takes the shared key, counted and logged with its program and never its value', async () => {
    const { service, metrics } = setup();
    await service.authorizeProgram('renderer_state', SHARED, 'station-a');
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('renderer_state', 'shared', 'accepted');
    expect(warn).toHaveBeenCalledWith('Shared renderer key accepted for program station-a on renderer_state');
    service.authorizeFleet(SHARED);
    expect(warn).toHaveBeenCalledWith('Shared renderer key accepted on return_routers');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SHARED);
  });

  it('refuses anything else with 401, a key of another length included', async () => {
    const { service, metrics } = setup();
    for (const presented of [undefined, '', 'short', `${SHARED}x`])
      await expect(service.authorizeProgram('on_air', presented, 'station-a')).rejects.toThrow(UnauthorizedException);
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('on_air', 'none', 'refused');
  });

  it('takes the fleet key on the router list only, and refuses anything else there', () => {
    const { service, metrics } = setup();
    expect(() => service.authorizeFleet(FLEET)).not.toThrow();
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('return_routers', 'fleet', 'accepted');
    expect(() => service.authorizeFleet('alrk_a-program-key')).toThrow(UnauthorizedException);
    expect(metrics.recordRendererAuth).toHaveBeenCalledWith('return_routers', 'none', 'refused');
  });

  it('takes no shared or fleet key when none is configured', async () => {
    const { service } = setup({});
    await expect(service.authorizeProgram('on_air', SHARED, 'station-a')).rejects.toThrow(UnauthorizedException);
    expect(() => service.authorizeFleet(FLEET)).toThrow(UnauthorizedException);
  });

  it('records Object for each dependency whose module is not loaded yet', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({ ...jest.requireActual('@nestjs/config'), ConfigService: undefined }));
      jest.doMock('./renderer-key.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RendererAuthService: Isolated } = require('./renderer-auth.service') as {
        RendererAuthService: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([Object, Object, Object]);
    });
    jest.dontMock('@nestjs/config');
    jest.dontMock('./renderer-key.service');
    jest.dontMock('../observability/managed-metrics.service');
  });

  it('is wired into the calls service by the calls module, so the per-program check is always the one used', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { WebrtcModule } = require('../webrtc/webrtc.module');
    const { WebrtcService } = require('../webrtc/webrtc.service');
    const { RendererKeysModule } = require('./renderer-keys.module');
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(Reflect.getMetadata('imports', WebrtcModule)).toContain(RendererKeysModule);
    expect(Reflect.getMetadata('design:paramtypes', WebrtcService)[4]).toBe(RendererAuthService);
  });
});

