import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Public } from './public.decorator';

export const IS_RENDERER_PUBLIC_KEY = 'isRendererPublic';

export const RENDERER_HTTP_BOUNDARY = [
  {
    capability: 'broadcast-settings-read',
    method: 'GET',
    path: '/program/broadcast-settings',
    purpose: 'Bootstrap and poll renderer-owned audio and timing behavior.',
  },
  {
    capability: 'program-state-read',
    method: 'GET',
    path: '/program/:programId/state',
    purpose: 'Bootstrap and reconcile the active scene and program state.',
  },
  {
    capability: 'legacy-program-state-read',
    method: 'GET',
    path: '/program/state',
    purpose: 'Retain the deployed default-program renderer bootstrap.',
  },
  {
    capability: 'audio-bus-read',
    method: 'GET',
    path: '/program/:programId/audio-bus',
    purpose: 'Bootstrap and reconcile the renderer audio bus.',
  },
  {
    capability: 'audio-meter-read',
    method: 'GET',
    path: '/program/:programId/audio-meter',
    purpose: 'Read the latest renderer meter snapshot.',
  },
  {
    capability: 'audio-meter-write',
    method: 'POST',
    path: '/program/:programId/audio-meter',
    purpose: 'Publish bounded renderer meter telemetry.',
  },
  {
    capability: 'scene-instant-read',
    method: 'GET',
    path: '/program/:programId/scene-instant',
    purpose: 'Restore renderer-owned scene-instant playback.',
  },
  {
    capability: 'song-playback-read',
    method: 'GET',
    path: '/program/:programId/song-playback',
    purpose: 'Restore renderer-owned song playback.',
  },
  {
    capability: 'song-playback-write',
    method: 'POST',
    path: '/program/:programId/song-playback',
    purpose: 'Publish renderer playback position and completion state.',
  },
  {
    capability: 'audio-proxy-read',
    method: 'GET',
    path: '/program/audio-proxy',
    purpose:
      'Retain the deployed same-origin audio proxy used by the renderer.',
  },
  {
    capability: 'program-media-groups-read',
    method: 'GET',
    path: '/program/:programId/media-groups',
    purpose: 'Read media groups assigned to the rendered program.',
  },
  {
    capability: 'program-stingers-read',
    method: 'GET',
    path: '/program/:programId/stingers',
    purpose: 'Preload stingers assigned to the rendered program.',
  },
  {
    capability: 'program-events-read',
    method: 'SSE',
    path: '/program/:programId/events',
    purpose: 'Consume the scoped program event stream.',
  },
  {
    capability: 'legacy-program-events-read',
    method: 'SSE',
    path: '/program/events',
    purpose: 'Retain the deployed default-program event stream.',
  },
  {
    capability: 'media-group-read',
    method: 'GET',
    path: '/media-groups/:id',
    purpose: 'Resolve the active slideshow media group.',
  },
  {
    capability: 'sanremo-realtime-read',
    method: 'GET',
    path: '/charts/sanremo-realtime',
    purpose: 'Resolve the public chart data used by the current renderer.',
  },
] as const;

export type RendererHttpCapability =
  (typeof RENDERER_HTTP_BOUNDARY)[number]['capability'];

export const RENDERER_REALTIME_INBOUND_TYPES = [
  'audio_meter_update',
  'song_playback_update',
  'song_ended',
] as const;
export type RendererRealtimeInboundType =
  (typeof RENDERER_REALTIME_INBOUND_TYPES)[number];

export function isRendererRealtimeInboundType(
  value: unknown,
): value is RendererRealtimeInboundType {
  return (
    typeof value === 'string' &&
    (RENDERER_REALTIME_INBOUND_TYPES as readonly string[]).includes(value)
  );
}

export function RendererPublic(capability: RendererHttpCapability) {
  return applyDecorators(
    Public(),
    SetMetadata(IS_RENDERER_PUBLIC_KEY, capability),
  );
}
