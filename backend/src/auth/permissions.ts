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
  broadcast: {
    view: 'broadcast.view',
    operate: 'broadcast.operate',
    manage: 'broadcast.manage',
  },
} as const;

type PermissionLeaf<T> = T extends string
  ? T
  : T extends Record<PropertyKey, unknown>
    ? PermissionLeaf<T[keyof T]>
    : never;

export type AlcantaraPermission = PermissionLeaf<typeof ALCANTARA_PERMISSIONS>;
