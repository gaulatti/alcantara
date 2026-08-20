export const ALCANTARA_PERMISSIONS = {
  access: 'alcantara:access',
  program: {
    read: 'alcantara:program:read',
    manage: 'alcantara:program:manage',
    operate: 'alcantara:program:operate',
  },
  flight: {
    read: 'alcantara:flight:read',
    manage: 'alcantara:flight:manage',
    operate: 'alcantara:flight:operate',
  },
  scene: {
    read: 'alcantara:scene:read',
    manage: 'alcantara:scene:manage',
    operate: 'alcantara:scene:operate',
  },
  layout: {
    read: 'alcantara:layout:read',
    manage: 'alcantara:layout:manage',
  },
  media: {
    read: 'alcantara:media:read',
    manage: 'alcantara:media:manage',
  },
  song: {
    read: 'alcantara:song:read',
    manage: 'alcantara:song:manage',
  },
  instant: {
    read: 'alcantara:instant:read',
    manage: 'alcantara:instant:manage',
    operate: 'alcantara:instant:operate',
  },
  stinger: {
    read: 'alcantara:stinger:read',
    manage: 'alcantara:stinger:manage',
  },
  radio: {
    read: 'alcantara:radio:read',
    manage: 'alcantara:radio:manage',
    operate: 'alcantara:radio:operate',
  },
  webrtc: {
    read: 'alcantara:webrtc:read',
    operate: 'alcantara:webrtc:operate',
  },
  upload: {
    create: 'alcantara:upload:create',
  },
} as const;

export type AlcantaraPermission =
  | typeof ALCANTARA_PERMISSIONS.access
  | 'alcantara:program:read'
  | 'alcantara:program:manage'
  | 'alcantara:program:operate'
  | 'alcantara:flight:read'
  | 'alcantara:flight:manage'
  | 'alcantara:flight:operate'
  | 'alcantara:scene:read'
  | 'alcantara:scene:manage'
  | 'alcantara:scene:operate'
  | 'alcantara:layout:read'
  | 'alcantara:layout:manage'
  | 'alcantara:media:read'
  | 'alcantara:media:manage'
  | 'alcantara:song:read'
  | 'alcantara:song:manage'
  | 'alcantara:instant:read'
  | 'alcantara:instant:manage'
  | 'alcantara:instant:operate'
  | 'alcantara:stinger:read'
  | 'alcantara:stinger:manage'
  | 'alcantara:radio:read'
  | 'alcantara:radio:manage'
  | 'alcantara:radio:operate'
  | 'alcantara:webrtc:read'
  | 'alcantara:webrtc:operate'
  | 'alcantara:upload:create';
