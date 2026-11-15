import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Room, RoomEvent } from 'livekit-client';

export interface SourceSubscriptionState {
  participantIdentity: string;
  videoTrack: any | null;
  audioTrack: any | null;
  audioLevel: number;
  error: string | null;
  isSubscribed: boolean;
}

export interface SourcesSubscriptionContextValue {
  room: any | null;
  subscribeSource: (participantIdentity: string) => () => void;
  useSourceSubscription: (participantIdentity: string) => SourceSubscriptionState;
  getSourceState: (participantIdentity: string) => SourceSubscriptionState;
}

const defaultStates = new Map<string, SourceSubscriptionState>();
function getDefaultState(identity: string): SourceSubscriptionState {
  let state = defaultStates.get(identity);
  if (!state) {
    state = {
      participantIdentity: identity,
      videoTrack: null,
      audioTrack: null,
      audioLevel: 0,
      error: null,
      isSubscribed: false,
    };
    defaultStates.set(identity, state);
  }
  return state;
}

export const SourcesSubscriptionContext = createContext<SourcesSubscriptionContextValue | null>(
  null
);

export interface SourcesSubscriptionProviderProps {
  room?: any;
  children: React.ReactNode;
}

export function SourcesSubscriptionProvider({
  room: providedRoom,
  children,
}: SourcesSubscriptionProviderProps) {
  const roomRef = useRef<any>(providedRoom ?? null);
  const refCounts = useRef<Map<string, number>>(new Map());
  const statesRef = useRef<Map<string, SourceSubscriptionState>>(new Map());
  const listenersRef = useRef<Map<string, Set<() => void>>>(new Map());

  if (!roomRef.current && typeof window !== 'undefined') {
    roomRef.current = new Room();
  }

  const getSourceState = useCallback((identity: string): SourceSubscriptionState => {
    return statesRef.current.get(identity) || getDefaultState(identity);
  }, []);

  const updateState = useCallback(
    (identity: string, updater: (prev: SourceSubscriptionState) => SourceSubscriptionState) => {
      const current = statesRef.current.get(identity) || getDefaultState(identity);
      const updated = updater(current);
      statesRef.current.set(identity, updated);
      const listeners = listenersRef.current.get(identity);
      if (listeners) {
        for (const listener of listeners) {
          listener();
        }
      }
    },
    []
  );

  const getRemoteParticipant = useCallback((room: any, identity: string) => {
    if (!room) return undefined;
    if (room.remoteParticipants?.get) {
      return room.remoteParticipants.get(identity);
    }
    if (room.participants?.get) {
      return room.participants.get(identity);
    }
    if (Array.isArray(room.remoteParticipants)) {
      return room.remoteParticipants.find((p: any) => p.identity === identity);
    }
    return undefined;
  }, []);

  const subscribeSource = useCallback(
    (identity: string) => {
      const currentCount = refCounts.current.get(identity) || 0;
      const nextCount = currentCount + 1;
      refCounts.current.set(identity, nextCount);

      if (nextCount === 1) {
        // Initial subscription for this source
        const room = roomRef.current;
        let vTrack: any = null;
        let aTrack: any = null;

        if (room) {
          const participant = getRemoteParticipant(room, identity);
          if (participant && participant.trackPublications) {
            const publications =
              typeof participant.trackPublications.values === 'function'
                ? Array.from(participant.trackPublications.values())
                : Object.values(participant.trackPublications);

            for (const pub of publications as any[]) {
              if (pub && typeof pub.setSubscribed === 'function') {
                pub.setSubscribed(true);
              }
              if (pub && pub.track) {
                if (pub.track.kind === 'video') vTrack = pub.track;
                if (pub.track.kind === 'audio') aTrack = pub.track;
              }
            }
          }
        }

        updateState(identity, (prev) => ({
          ...prev,
          isSubscribed: true,
          videoTrack: vTrack ?? prev.videoTrack,
          audioTrack: aTrack ?? prev.audioTrack,
          error: null,
        }));
      }

      return () => {
        const count = refCounts.current.get(identity) || 1;
        const remaining = Math.max(0, count - 1);
        if (remaining === 0) {
          refCounts.current.delete(identity);
          // Release LiveKit subscription
          const room = roomRef.current;
          if (room) {
            const participant = getRemoteParticipant(room, identity);
            if (participant && participant.trackPublications) {
              const publications =
                typeof participant.trackPublications.values === 'function'
                  ? Array.from(participant.trackPublications.values())
                  : Object.values(participant.trackPublications);

              for (const pub of publications as any[]) {
                if (pub && typeof pub.setSubscribed === 'function') {
                  pub.setSubscribed(false);
                }
              }
            }
          }
          updateState(identity, () => getDefaultState(identity));
        } else {
          refCounts.current.set(identity, remaining);
        }
      };
    },
    [getRemoteParticipant, updateState]
  );

  useEffect(() => {
    const room = roomRef.current;
    if (!room || typeof room.on !== 'function') return;

    const handleTrackPublished = (publication: any, participant: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      if ((refCounts.current.get(identity) || 0) > 0) {
        if (publication && typeof publication.setSubscribed === 'function') {
          publication.setSubscribed(true);
        }
      }
    };

    const handleTrackSubscribed = (track: any, publication: any, participant: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      if ((refCounts.current.get(identity) || 0) > 0) {
        if (track?.kind === 'video') {
          updateState(identity, (prev) => ({ ...prev, videoTrack: track, error: null }));
        } else if (track?.kind === 'audio') {
          updateState(identity, (prev) => ({ ...prev, audioTrack: track, error: null }));
        }
      }
    };

    const handleTrackUnsubscribed = (track: any, publication: any, participant: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      if (track?.kind === 'video') {
        updateState(identity, (prev) => ({ ...prev, videoTrack: null }));
      } else if (track?.kind === 'audio') {
        updateState(identity, (prev) => ({ ...prev, audioTrack: null }));
      }
    };

    const handleTrackSubscriptionFailed = (trackSid: string, participant: any, reason?: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      updateState(identity, (prev) => ({
        ...prev,
        error: `Track subscription failed: ${reason || trackSid}`,
      }));
    };

    const handleParticipantDisconnected = (participant: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      updateState(identity, (prev) => ({
        ...prev,
        videoTrack: null,
        audioTrack: null,
        error: 'Participant disconnected',
      }));
    };

    const handleActiveSpeakersChanged = (speakers: any[]) => {
      if (!Array.isArray(speakers)) return;
      for (const speaker of speakers) {
        const identity = speaker?.identity;
        if (identity && (refCounts.current.get(identity) || 0) > 0) {
          const level =
            typeof speaker.audioLevel === 'number' ? Math.round(speaker.audioLevel * 100) : 0;
          updateState(identity, (prev) => ({ ...prev, audioLevel: level }));
        }
      }
    };

    room.on(RoomEvent.TrackPublished, handleTrackPublished);
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    room.on(RoomEvent.TrackSubscriptionFailed, handleTrackSubscriptionFailed);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);

    return () => {
      if (typeof room.off === 'function') {
        room.off(RoomEvent.TrackPublished, handleTrackPublished);
        room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
        room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
        room.off(RoomEvent.TrackSubscriptionFailed, handleTrackSubscriptionFailed);
        room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
        room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
      }
    };
  }, [updateState]);

  const useSourceSubscription = useCallback(
    (identity: string): SourceSubscriptionState => {
      useEffect(() => {
        if (!identity) return;
        return subscribeSource(identity);
      }, [identity]);

      const subscribe = useCallback(
        (onStoreChange: () => void) => {
          let listeners = listenersRef.current.get(identity);
          if (!listeners) {
            listeners = new Set();
            listenersRef.current.set(identity, listeners);
          }
          listeners.add(onStoreChange);
          return () => {
            listeners?.delete(onStoreChange);
          };
        },
        [identity]
      );

      const getSnapshot = useCallback(() => {
        return getSourceState(identity);
      }, [identity]);

      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    },
    [getSourceState, subscribeSource]
  );

  return (
    <SourcesSubscriptionContext.Provider
      value={{
        room: roomRef.current,
        subscribeSource,
        useSourceSubscription,
        getSourceState,
      }}
    >
      {children}
    </SourcesSubscriptionContext.Provider>
  );
}

export function useSourcesSubscriptionContext(): SourcesSubscriptionContextValue {
  const context = useContext(SourcesSubscriptionContext);
  if (!context) {
    throw new Error(
      'useSourcesSubscriptionContext must be used within a SourcesSubscriptionProvider'
    );
  }
  return context;
}

export function useSourceSubscription(identity: string): SourceSubscriptionState {
  const context = useSourcesSubscriptionContext();
  return context.useSourceSubscription(identity);
}
