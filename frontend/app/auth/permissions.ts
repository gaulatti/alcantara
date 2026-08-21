export const PERMISSIONS = {
  access: 'alcantara:access',
  program: {
    read: 'alcantara:program:read',
    manage: 'alcantara:program:manage',
    operate: 'alcantara:program:operate'
  },
  flight: {
    read: 'alcantara:flight:read',
    manage: 'alcantara:flight:manage',
    operate: 'alcantara:flight:operate'
  },
  scene: {
    read: 'alcantara:scene:read',
    manage: 'alcantara:scene:manage',
    operate: 'alcantara:scene:operate'
  },
  layout: { read: 'alcantara:layout:read', manage: 'alcantara:layout:manage' },
  media: { read: 'alcantara:media:read', manage: 'alcantara:media:manage' },
  song: { read: 'alcantara:song:read', manage: 'alcantara:song:manage' },
  instant: {
    read: 'alcantara:instant:read',
    manage: 'alcantara:instant:manage',
    operate: 'alcantara:instant:operate'
  },
  stinger: {
    read: 'alcantara:stinger:read',
    manage: 'alcantara:stinger:manage'
  },
  radio: {
    read: 'alcantara:radio:read',
    manage: 'alcantara:radio:manage',
    operate: 'alcantara:radio:operate'
  },
  webrtc: {
    read: 'alcantara:webrtc:read',
    operate: 'alcantara:webrtc:operate'
  },
  upload: { create: 'alcantara:upload:create' }
} as const;

export const routePermission = (pathname: string): string => {
  if (pathname.startsWith('/flight')) return PERMISSIONS.flight.read;
  if (pathname.startsWith('/instants')) return PERMISSIONS.instant.read;
  if (pathname.startsWith('/stingers')) return PERMISSIONS.stinger.read;
  if (pathname.startsWith('/songs')) return PERMISSIONS.song.read;
  if (pathname.startsWith('/media')) return PERMISSIONS.media.read;
  if (pathname.startsWith('/calls')) return PERMISSIONS.webrtc.read;
  if (pathname.startsWith('/scenes')) return PERMISSIONS.scene.read;
  if (pathname.startsWith('/layouts') || pathname.startsWith('/preview')) return PERMISSIONS.layout.read;
  return PERMISSIONS.program.read;
};
