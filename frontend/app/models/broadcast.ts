export interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

export interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

export interface ProgramSceneEntry {
  id: number;
  sceneId: number;
  position: number;
  scene: Scene;
}

export interface ProgramMediaGroupEntry {
  id: number;
  mediaGroupId: number;
  position: number;
  mediaGroup: MediaGroup;
}

export interface ProgramState {
  id: number;
  programId: string;
  activeSceneId: number | null;
  activeScene?: Scene | null;
  stagedSceneId?: number | null;
  stagedScene?: Scene | null;
  scenes: ProgramSceneEntry[];
  mediaGroups: ProgramMediaGroupEntry[];
}

export interface InstantItem {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
}

export interface InstantPlaybackState {
  startedAtMs: number;
  endsAtMs: number | null;
}

export interface SongCatalogItem {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
  coverUrl: string | null;
  durationMs: number | null;
  earoneSongId: string | null;
  earoneRank: string | null;
  earoneSpins: string | null;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  catalogTotal: number;
  catalogEnabled: number;
  catalogTotalDurationMs: number;
  catalogKnownDurationCount: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface MediaItem {
  id: number;
  name: string;
  imageUrl: string;
}

export interface MediaGroupItem {
  id: number;
  mediaGroupId: number;
  mediaId: number;
  position: number;
  media: MediaItem;
}

export interface MediaGroup {
  id: number;
  name: string;
  description: string | null;
  items: MediaGroupItem[];
}

export interface ProgramAudioBusSettings {
  songSequence: unknown | null;
  mixerSettings?: unknown | null;
}

export interface BroadcastSettings {
  mainMasterVolume: number;
  songMasterVolume: number;
  instantMasterVolume: number;
  sceneInstantMasterVolume: number;
  streamMasterVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
  sceneInstantMuted: boolean;
  streamMuted: boolean;
  songSolo: boolean;
  instantSolo: boolean;
  sceneInstantSolo: boolean;
  streamSolo: boolean;
  mixerChannels: MixerChannelSetting[];
}

export interface MixerChannelSetting {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface ProgramAudioMeterLevels {
  song: { vu: number; peak: number; peakHold: number };
  instants: { vu: number; peak: number; peakHold: number };
  sceneInstant: { vu: number; peak: number; peakHold: number };
  main: { vu: number; peak: number; peakHold: number };
  updatedAt: string;
}

export interface SceneInstantPlaybackState {
  sceneId: number | null;
  instantId: number | null;
  instantName: string;
  isPlaying: boolean;
  updatedAt: string;
}

export interface ProgramSongPlaybackState {
  token: string;
  audioUrl: string;
  progress: number;
  currentTimeMs: number;
  durationMs: number | null;
  isPlaying: boolean;
  updatedAt: string;
}

export type ComponentPropsMap = Record<string, any>;
export type SceneAttributeSavePayload = {
  sceneId: number;
  props: ComponentPropsMap;
  signature: string;
  revision: number;
};
export type ProgramUpdateTopic = 'state' | 'audioBus' | 'audioMeter' | 'songPlayback' | 'sceneInstant';
export type MixerTakeChannelKey = 'song' | 'stream' | 'instants' | 'sceneInstant' | 'main';
export type MixerTakePresetSide = 'a' | 'b';
export type MixerTakePresetDbMap = Record<MixerTakeChannelKey, { aDb: number; bDb: number }>;
export type MixerTakeSideMap = Record<MixerTakeChannelKey, MixerTakePresetSide>;
export type MixerTakeApplyingMap = Record<MixerTakeChannelKey, boolean>;
export type MixerTakeTimerMap = Record<MixerTakeChannelKey, number | null>;
export type MixerTakeRunIdMap = Record<MixerTakeChannelKey, number>;
