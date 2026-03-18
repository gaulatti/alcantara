import { useState, useEffect, useCallback, useRef } from 'react';
import type { PlaylistConfig, PlaylistState, Segment } from './types';

const DEFAULT_DURATION_MS = 10000;
const DEFAULT_UPDATE_INTERVAL_MS = 100;

export function usePlaylistEngine(config: PlaylistConfig) {
  const {
    segments,
    defaultDurationMs = DEFAULT_DURATION_MS,
    updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
    onPlaylistLoop
  } = config;

  const [state, setState] = useState<PlaylistState>({
    currentSegmentIndex: 0,
    currentItemIndex: 0,
    progress: 0,
    isPaused: false
  });
  const prevSegmentIndexRef = useRef<number>(0);

  const getCurrentSegment = useCallback((): Segment | null => {
    if (segments.length === 0) return null;
    return segments[state.currentSegmentIndex] || null;
  }, [segments, state.currentSegmentIndex]);

  const pause = useCallback(() => {
    setState((prev) => ({ ...prev, isPaused: true }));
  }, []);

  const resume = useCallback(() => {
    setState((prev) => ({ ...prev, isPaused: false }));
  }, []);

  const reset = useCallback(() => {
    setState({
      currentSegmentIndex: 0,
      currentItemIndex: 0,
      progress: 0,
      isPaused: false
    });
  }, []);

  const calculateNextState = useCallback(
    (prevState: PlaylistState): PlaylistState => {
      const currentSegment = segments[prevState.currentSegmentIndex];
      if (!currentSegment) {
        return prevState;
      }

      const nextItemIndex = prevState.currentItemIndex + 1;
      if (nextItemIndex >= currentSegment.itemCount) {
        const nextSegmentIndex = (prevState.currentSegmentIndex + 1) % segments.length;
        return {
          ...prevState,
          currentSegmentIndex: nextSegmentIndex,
          currentItemIndex: 0,
          progress: 0
        };
      }

      return {
        ...prevState,
        currentItemIndex: nextItemIndex,
        progress: 0
      };
    },
    [segments]
  );

  const advanceToNext = useCallback(() => {
    setState((prevState) => calculateNextState(prevState));
  }, [calculateNextState]);

  useEffect(() => {
    const currentSegmentIndex = state.currentSegmentIndex;
    const previousSegmentIndex = prevSegmentIndexRef.current;

    if (currentSegmentIndex !== previousSegmentIndex) {
      const previousSegment = segments[previousSegmentIndex];
      previousSegment?.onExit?.();

      const currentSegment = segments[currentSegmentIndex];
      currentSegment?.onEnter?.();

      const nextSegmentIndex = (currentSegmentIndex + 1) % segments.length;
      const nextSegment = segments[nextSegmentIndex];
      nextSegment?.prefetch?.().catch((error) => {
        console.error(`[Playlist] Failed to prefetch ${nextSegment.label}:`, error);
      });

      if (
        currentSegmentIndex === 0 &&
        previousSegmentIndex === segments.length - 1 &&
        segments.length > 0
      ) {
        onPlaylistLoop?.();
      }

      prevSegmentIndexRef.current = currentSegmentIndex;
    }
  }, [state.currentSegmentIndex, segments, onPlaylistLoop]);

  useEffect(() => {
    if (state.isPaused || segments.length === 0) {
      return;
    }

    const currentSegment = segments[state.currentSegmentIndex];
    if (!currentSegment) {
      return;
    }

    const duration = currentSegment.durationMsPerItem || defaultDurationMs;
    const progressIncrement = (updateIntervalMs / duration) * 100;

    const timer = setInterval(() => {
      setState((prevState) => {
        if (prevState.progress >= 100) {
          return calculateNextState(prevState);
        }

        return {
          ...prevState,
          progress: prevState.progress + progressIncrement
        };
      });
    }, updateIntervalMs);

    return () => clearInterval(timer);
  }, [state.isPaused, state.currentSegmentIndex, segments, defaultDurationMs, updateIntervalMs, calculateNextState]);

  return {
    state,
    currentSegment: getCurrentSegment(),
    pause,
    resume,
    reset,
    advanceToNext
  };
}
