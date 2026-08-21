import 'reflect-metadata';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  IS_RENDERER_PUBLIC_KEY,
  RENDERER_HTTP_BOUNDARY,
  RENDERER_REALTIME_INBOUND_TYPES,
  isRendererRealtimeInboundType,
} from './renderer-boundary';
import { ChartsController } from '../charts/charts.controller';
import { MediaGroupsController } from '../media-groups/media-groups.controller';
import { ProgramController } from '../program/program.controller';

describe('transitional renderer boundary', () => {
  const controllerCapabilities = [
    [ProgramController.prototype, 'getBroadcastSettings'],
    [ProgramController.prototype, 'getStateById'],
    [ProgramController.prototype, 'getProgramAudioBusById'],
    [ProgramController.prototype, 'getProgramAudioMeterById'],
    [ProgramController.prototype, 'updateProgramAudioMeterById'],
    [ProgramController.prototype, 'getProgramSceneInstantById'],
    [ProgramController.prototype, 'getProgramSongPlaybackById'],
    [ProgramController.prototype, 'updateProgramSongPlaybackById'],
    [ProgramController.prototype, 'proxyAudio'],
    [ProgramController.prototype, 'getState'],
    [ProgramController.prototype, 'listProgramMediaGroups'],
    [ProgramController.prototype, 'listProgramStingers'],
    [ProgramController.prototype, 'eventsById'],
    [ProgramController.prototype, 'events'],
    [MediaGroupsController.prototype, 'findOne'],
    [ChartsController.prototype, 'getSanremoRealtime'],
  ] as const;

  const getMethodMetadata = <T>(
    metadataKey: string,
    controller: object,
    method: string,
  ): T | undefined => {
    const handler = Object.getOwnPropertyDescriptor(controller, method)
      ?.value as object | undefined;
    if (!handler) {
      throw new Error(`Missing controller method: ${method}`);
    }
    return Reflect.getMetadata(metadataKey, handler) as T | undefined;
  };

  it('enumerates every renderer HTTP capability exactly once', () => {
    const declared = RENDERER_HTTP_BOUNDARY.map(({ capability }) => capability);
    const decorated = controllerCapabilities.map(([controller, method]) =>
      getMethodMetadata<string>(IS_RENDERER_PUBLIC_KEY, controller, method),
    );

    expect(new Set(declared).size).toBe(16);
    expect(decorated.sort()).toEqual([...declared].sort());
    for (const [controller, method] of controllerCapabilities) {
      expect(
        getMethodMetadata<boolean>(IS_PUBLIC_KEY, controller, method),
      ).toBe(true);
    }
  });

  it('does not expose representative operator actions as renderer public', () => {
    for (const method of [
      'updateBroadcastSettings',
      'activateSceneById',
      'updateProgramAudioBusById',
      'goFlightById',
    ] as const) {
      expect(
        getMethodMetadata<string>(
          IS_RENDERER_PUBLIC_KEY,
          ProgramController.prototype,
          method,
        ),
      ).toBeUndefined();
      expect(
        getMethodMetadata<boolean>(
          IS_PUBLIC_KEY,
          ProgramController.prototype,
          method,
        ),
      ).toBeUndefined();
    }
  });

  it('allows only renderer telemetry, playback, and song completion messages', () => {
    expect(RENDERER_REALTIME_INBOUND_TYPES).toEqual([
      'audio_meter_update',
      'song_playback_update',
      'song_ended',
    ]);
    expect(isRendererRealtimeInboundType('audio_meter_update')).toBe(true);
    expect(isRendererRealtimeInboundType('scene_activate')).toBe(false);
    expect(isRendererRealtimeInboundType('program_state_update')).toBe(false);
    expect(isRendererRealtimeInboundType(undefined)).toBe(false);
  });
});
