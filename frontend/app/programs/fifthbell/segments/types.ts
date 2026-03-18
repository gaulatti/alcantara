import type React from 'react';

export interface Segment {
  id: string;
  label: string;
  itemCount: number;
  durationMsPerItem: number;
  render(itemIndex: number, progress: number): React.ReactNode;
  onEnter?(): void;
  onExit?(): void;
  prefetch?(): Promise<void>;
}

export interface PlaylistState {
  currentSegmentIndex: number;
  currentItemIndex: number;
  progress: number;
  isPaused: boolean;
}

export interface PlaylistConfig {
  segments: Segment[];
  defaultDurationMs?: number;
  updateIntervalMs?: number;
  onPlaylistLoop?: () => void;
}
