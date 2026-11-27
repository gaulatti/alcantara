import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GuestRoute from './guest';

// Screening before air: the guest waits in a room of their own and goes in only when admitted.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = { rooms: [] as InstanceType<typeof Room>[] };
  class Room {
    state = 'disconnected';
    token = '';
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map();
    media: string[] = [];
    localParticipant = {
      setCameraEnabled: async (on: boolean) => void this.media.push(`camera:${on}`),
      setMicrophoneEnabled: async (on: boolean) => void this.media.push(`microphone:${on}`),
      getTrackPublication: () => ({ videoTrack: { attach() {} } })
    };
    constructor() {
      state.rooms.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    async connect(_url: string, token: string) {
      this.token = token;
      this.state = 'connected';
    }
    disconnect() {
      this.state = 'disconnected';
      this.emit('disconnected', 1);
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
  }
  return { state, Room };
});

vi.mock('livekit-client', () => ({
  Room: lk.Room,
  ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', Disconnected: 'disconnected' },
  RoomEvent: {
    TrackPublished: 'trackPublished',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ConnectionStateChanged: 'connectionStateChanged',
    ConnectionQualityChanged: 'connectionQualityChanged',
    DataReceived: 'dataReceived',
    Disconnected: 'disconnected'
  },
  DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
  Track: { Kind: { Video: 'video', Audio: 'audio' }, Source: { Camera: 'camera' } }
}));

let admission: 'waiting' | 'admitted';
let refused: boolean;
let beats: Array<Record<string, unknown>>;
let poll: (() => void) | null;

const track = () => ({ enabled: true, stop() {}, getSettings: () => ({}) });

beforeEach(() => {
  lk.state.rooms = [];
  admission = 'waiting';
  refused = false;
  beats = [];
  poll = null;
  window.sessionStorage.clear();
  const video = [track()];
  const audio = [track()];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getVideoTracks: () => video, getAudioTracks: () => audio, getTracks: () => [...video, ...audio] })),
      enumerateDevices: vi.fn(async () => [])
    }
  });
  Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  const realSetInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, delay?: number) => {
    if (delay === 3_000) {
      poll = handler;
      return 0;
    }
    if (delay === 20_000) return 0;
    return realSetInterval(handler, delay);
  }) as typeof window.setInterval);
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return { frequency: { value: 0 }, connect: (next: unknown) => next, start() {}, stop() {}, addEventListener() {} };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (next: unknown) => next };
      }
      close() {}
    }
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/webrtc/join'))
        return Response.json({
          serverUrl: 'wss://livekit.example',
          token: `${admission}-token`,
          sessionToken: 'session-1',
          displayName: 'Ada',
          programId: 'main',
          participantIdentity: 'guest-ada',
          returnVideo: 'program',
          returnAudioBus: 'master',
          admission
        });
      if (url.endsWith('/webrtc/session/heartbeat')) {
        beats.push((JSON.parse(String(init!.body)) as { telemetry: Record<string, unknown> }).telemetry);
        return refused ? new Response(null, { status: 401 }) : Response.json({ admission });
      }
      return new Response(null, { status: 204 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function join() {
  render(
    <MemoryRouter initialEntries={['/guest/inv-1.secret']}>
      <Routes>
        <Route path='/guest/:invitation' element={<GuestRoute />} />
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByText('Browser network check ready')).toBeVisible();
  fireEvent.click(screen.getByText('Speaker test').closest('button')!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  fireEvent.click(screen.getByRole('button', { name: /Join studio/ }));
  expect(await screen.findByText('Waiting for the producer to let you in')).toBeVisible();
}
const live = () => screen.findByText('Ada · main · program video · master mix-minus');

it('waits off air, hearing the producer, and goes in when admitted with the choices made meanwhile', async () => {
  await join();
  const waiting = lk.state.rooms[0];
  expect(waiting.token).toBe('waiting-token');
  const attach = vi.fn();
  act(() => waiting.emit('trackSubscribed', { kind: 'audio', attach }));
  act(() => waiting.emit('trackSubscribed', { kind: 'video', attach }));
  expect(attach).toHaveBeenCalledTimes(1);
  // A waiting heartbeat is not a join.
  expect(beats[0]).not.toHaveProperty('joined');
  fireEvent.click(screen.getByRole('button', { name: /Camera on/ }));
  await screen.findByRole('button', { name: /Camera off/ });

  admission = 'admitted';
  await act(async () => waiting.emit('disconnected', 4));
  await live();
  expect(lk.state.rooms).toHaveLength(2);
  expect(lk.state.rooms[1].token).toBe('admitted-token');
  expect(lk.state.rooms[1].media).toContain('camera:false');
  await waitFor(() => expect(beats.at(-1)).toMatchObject({ joined: true }));
});

it('notices admission by its poll too, and joins once', async () => {
  await join();
  admission = 'admitted';
  await act(async () => {
    poll!();
    poll!();
  });
  await live();
  expect(lk.state.rooms).toHaveLength(2);
});

it('says the studio did not let the guest in when declined', async () => {
  await join();
  refused = true;
  await act(async () => lk.state.rooms[0].emit('disconnected', 4));
  expect(await screen.findByText(/The studio did not let you in/)).toBeVisible();
});

it('lets a waiting guest leave', async () => {
  await join();
  fireEvent.click(screen.getByRole('button', { name: /Leave/ }));
  expect(await screen.findByText('You left the studio.')).toBeVisible();
  expect(lk.state.rooms).toHaveLength(1);
  await waitFor(() => expect(beats.at(-1)).toEqual({ left: true }));
});
