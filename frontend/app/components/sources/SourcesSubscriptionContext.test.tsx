import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  SourcesSubscriptionProvider,
  useSourceSubscription,
  useSourcesSubscriptionContext,
} from './SourcesSubscriptionContext';
import { RoomEvent } from 'livekit-client';

class FakeTrackPublication {
  track: any;
  isSubscribed = false;
  setSubscribed = vi.fn((sub: boolean) => {
    this.isSubscribed = sub;
  });

  constructor(public trackSid: string, public kind: 'video' | 'audio') {
    this.track = { sid: trackSid, kind, attach: vi.fn(), detach: vi.fn() };
  }
}

class FakeParticipant {
  trackPublications = new Map<string, FakeTrackPublication>();
  constructor(public identity: string) {}

  addTrack(kind: 'video' | 'audio', sid = `${this.identity}-${kind}`) {
    const pub = new FakeTrackPublication(sid, kind);
    this.trackPublications.set(sid, pub);
    return pub;
  }
}

class FakeRoom {
  remoteParticipants = new Map<string, FakeParticipant>();
  private handlers = new Map<string, Function[]>();

  on(event: string, fn: Function) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(fn);
  }

  off(event: string, fn: Function) {
    const arr = this.handlers.get(event) || [];
    this.handlers.set(event, arr.filter((f) => f !== fn));
  }

  emit(event: string, ...args: any[]) {
    for (const fn of this.handlers.get(event) || []) {
      fn(...args);
    }
  }

  connect = vi.fn();
}

function ConsumerComponent({ identity, id }: { identity: string; id: string }) {
  const state = useSourceSubscription(identity);
  return (
    <div data-testid={`consumer-${id}`}>
      <span data-testid={`subscribed-${id}`}>{state.isSubscribed ? 'yes' : 'no'}</span>
      <span data-testid={`error-${id}`}>{state.error || 'none'}</span>
      <span data-testid={`has-video-${id}`}>{state.videoTrack ? 'yes' : 'no'}</span>
      <span data-testid={`has-audio-${id}`}>{state.audioTrack ? 'yes' : 'no'}</span>
    </div>
  );
}

describe('SourcesSubscriptionContext', () => {
  it('joining the room subscribes to nothing', () => {
    const room = new FakeRoom();
    const p1 = new FakeParticipant('part-1');
    const pub1 = p1.addTrack('video');
    const pub2 = p1.addTrack('audio');
    room.remoteParticipants.set('part-1', p1);

    const p2 = new FakeParticipant('part-2');
    const pub3 = p2.addTrack('video');
    room.remoteParticipants.set('part-2', p2);

    render(
      <SourcesSubscriptionProvider room={room}>
        <div>Active Room</div>
      </SourcesSubscriptionProvider>
    );

    expect(pub1.setSubscribed).not.toHaveBeenCalled();
    expect(pub2.setSubscribed).not.toHaveBeenCalled();
    expect(pub3.setSubscribed).not.toHaveBeenCalled();
  });

  it('selecting a source subscribes to exactly that participant, and deselecting unsubscribes', () => {
    const room = new FakeRoom();
    const p1 = new FakeParticipant('source-alpha');
    const p1Video = p1.addTrack('video');
    const p1Audio = p1.addTrack('audio');
    room.remoteParticipants.set('source-alpha', p1);

    const p2 = new FakeParticipant('source-beta');
    const p2Video = p2.addTrack('video');
    room.remoteParticipants.set('source-beta', p2);

    const { rerender } = render(
      <SourcesSubscriptionProvider room={room}>
        <ConsumerComponent identity="source-alpha" id="alpha" />
      </SourcesSubscriptionProvider>
    );

    // Alpha tracks are subscribed
    expect(p1Video.setSubscribed).toHaveBeenCalledWith(true);
    expect(p1Audio.setSubscribed).toHaveBeenCalledWith(true);

    // Beta tracks are NOT subscribed
    expect(p2Video.setSubscribed).not.toHaveBeenCalled();

    // Deselect source-alpha (unmount consumer)
    rerender(
      <SourcesSubscriptionProvider room={room}>
        <div>No consumer</div>
      </SourcesSubscriptionProvider>
    );

    expect(p1Video.setSubscribed).toHaveBeenCalledWith(false);
    expect(p1Audio.setSubscribed).toHaveBeenCalledWith(false);
  });

  it('two consumers of one source produce one subscription, released after the second consumer unmounts', () => {
    const room = new FakeRoom();
    const p = new FakeParticipant('shared-source');
    const v = p.addTrack('video');
    room.remoteParticipants.set('shared-source', p);

    const { rerender } = render(
      <SourcesSubscriptionProvider room={room}>
        <ConsumerComponent identity="shared-source" id="1" />
        <ConsumerComponent identity="shared-source" id="2" />
      </SourcesSubscriptionProvider>
    );

    // Only one subscribe call to the track publication
    expect(v.setSubscribed).toHaveBeenCalledTimes(1);
    expect(v.setSubscribed).toHaveBeenCalledWith(true);

    // Unmount the first consumer, second consumer remains
    rerender(
      <SourcesSubscriptionProvider room={room}>
        <ConsumerComponent identity="shared-source" id="2" />
      </SourcesSubscriptionProvider>
    );

    // Still not unsubscribed
    expect(v.setSubscribed).not.toHaveBeenCalledWith(false);

    // Unmount the second consumer
    rerender(
      <SourcesSubscriptionProvider room={room}>
        <div>Empty</div>
      </SourcesSubscriptionProvider>
    );

    // Released now
    expect(v.setSubscribed).toHaveBeenCalledWith(false);
  });

  it('a failing track or a dropped participant changes only its own tile', () => {
    const room = new FakeRoom();
    const p1 = new FakeParticipant('source-1');
    const p1Video = p1.addTrack('video');
    room.remoteParticipants.set('source-1', p1);

    const p2 = new FakeParticipant('source-2');
    const p2Video = p2.addTrack('video');
    room.remoteParticipants.set('source-2', p2);

    render(
      <SourcesSubscriptionProvider room={room}>
        <ConsumerComponent identity="source-1" id="1" />
        <ConsumerComponent identity="source-2" id="2" />
      </SourcesSubscriptionProvider>
    );

    expect(screen.getByTestId('error-1').textContent).toBe('none');
    expect(screen.getByTestId('error-2').textContent).toBe('none');

    // Simulate track failure on source-1
    act(() => {
      room.emit(RoomEvent.TrackSubscriptionFailed, 'track-s1', p1, 'Decode failed');
    });

    expect(screen.getByTestId('error-1').textContent).toContain('Decode failed');
    expect(screen.getByTestId('error-2').textContent).toBe('none');

    // Simulate participant drop on source-2
    act(() => {
      room.emit(RoomEvent.ParticipantDisconnected, p2);
    });

    expect(screen.getByTestId('error-2').textContent).toBe('Participant disconnected');
    // Source 1 retains its own separate error
    expect(screen.getByTestId('error-1').textContent).toContain('Decode failed');
  });
});
