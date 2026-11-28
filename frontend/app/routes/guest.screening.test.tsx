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
let scheduledBeat: (() => void) | null;
// When set, a heartbeat answer waits here: the test decides when the server's answer arrives.
let heartbeatGate: Promise<void> | null;
// The studio's cue for the guest's session, as the join and heartbeat responses carry it.
let cueState: 'live' | 'standby' | 'wrap' | undefined;

const track = () => ({ enabled: true, stop() {}, getSettings: () => ({}) });

beforeEach(() => {
  lk.state.rooms = [];
  admission = 'waiting';
  refused = false;
  beats = [];
  poll = null;
  scheduledBeat = null;
  heartbeatGate = null;
  cueState = 'standby';
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
    if (delay === 20_000) {
      scheduledBeat = handler;
      return 0;
    }
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
          admission,
          cue: cueState
        });
      if (url.endsWith('/webrtc/session/heartbeat')) {
        beats.push((JSON.parse(String(init!.body)) as { telemetry: Record<string, unknown> }).telemetry);
        // The server answers from the state it holds when the request arrives, whatever arrives while it is on the way.
        const answered = cueState;
        if (heartbeatGate) await heartbeatGate;
        return refused ? new Response(null, { status: 401 }) : Response.json({ admission, cue: answered });
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

it('offers to rejoin when the screening connection is lost while still waiting', async () => {
  await join();
  await act(async () => lk.state.rooms[0].emit('disconnected', 3));
  expect(await screen.findByText(/Your connection to the studio dropped/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Rejoin the studio' })).toBeVisible();
  expect(lk.state.rooms).toHaveLength(1);
});

it('leaving while a waiting-room heartbeat is in flight does not touch timers or raise the dropped error', async () => {
  await join();
  // The waiting room's heartbeat is held on the way back, and the guest leaves the page meanwhile.
  let release!: () => void;
  heartbeatGate = new Promise<void>((resolve) => (release = resolve));
  await act(async () => poll!());
  // A dropped connection that lands during teardown: its heartbeat settles after the page is gone.
  act(() => lk.state.rooms[0].emit('disconnected', 3));
  cleanup();
  const clearInterval = vi.spyOn(window, 'clearInterval');
  await act(async () => release());
  heartbeatGate = null;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(clearInterval).not.toHaveBeenCalled();
  expect(screen.queryByText(/Your connection to the studio dropped/)).toBeNull();
});

it('lets a waiting guest leave', async () => {
  await join();
  fireEvent.click(screen.getByRole('button', { name: /Leave/ }));
  expect(await screen.findByText('You left the studio.')).toBeVisible();
  expect(lk.state.rooms).toHaveLength(1);
  await waitFor(() => expect(beats.at(-1)).toEqual({ left: true }));
});

// The guest's own on-air state, from the studio's cue for their session: the banner follows the server's value.
async function joinAdmitted() {
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
}

it('shows You\'re on air when the studio has cued the guest live, and Off air when it stands them by', async () => {
  admission = 'admitted';
  cueState = 'live';
  await joinAdmitted();
  await live();
  expect(screen.getByText("You're on air")).toBeVisible();
  expect(screen.getByText("You're on air").closest('[role="status"]')).toHaveAttribute('data-on-air', 'true');

  cueState = 'standby';
  await act(async () => scheduledBeat!());
  expect(await screen.findByText('Off air')).toBeVisible();
  expect(screen.queryByText("You're on air")).toBeNull();
});

it('shows no on-air state until the studio has said, rather than guessing Off air', async () => {
  admission = 'admitted';
  cueState = undefined;
  await joinAdmitted();
  await live();
  expect(screen.queryByText("You're on air")).toBeNull();
  expect(screen.queryByText('Off air')).toBeNull();
});

// The studio's cue message sets the banner at once; the heartbeat's cue corrects it; a reconnect clears it.
const cueMessage = (cue: 'live' | 'standby' | 'wrap') => new TextEncoder().encode(JSON.stringify({ id: 'cue-1', type: 'cue', cue, sentAt: new Date().toISOString() }));

it('a director cue message flips the banner at once, without waiting for a heartbeat', async () => {
  admission = 'admitted';
  cueState = 'standby';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  expect(screen.getByText('Off air')).toBeVisible();
  act(() => lk.state.rooms[0].emit('dataReceived', cueMessage('live'), undefined, undefined, 'alcantara-director'));
  expect(screen.getByText("You're on air")).toBeVisible();
  act(() => lk.state.rooms[0].emit('dataReceived', cueMessage('standby'), undefined, undefined, 'alcantara-director'));
  expect(screen.getByText('Off air')).toBeVisible();
});

it('the next heartbeat corrects a banner the studio message got wrong', async () => {
  admission = 'admitted';
  cueState = 'standby';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  act(() => lk.state.rooms[0].emit('dataReceived', cueMessage('live'), undefined, undefined, 'alcantara-director'));
  expect(screen.getByText("You're on air")).toBeVisible();
  // The server says standby (for example after a rejoin the page did not see): the heartbeat wins.
  cueState = 'standby';
  await act(async () => scheduledBeat!());
  expect(await screen.findByText('Off air')).toBeVisible();
  expect(screen.queryByText("You're on air")).toBeNull();
});

it('a reconnect clears the banner until the studio answers again', async () => {
  admission = 'admitted';
  cueState = 'live';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  expect(screen.getByText("You're on air")).toBeVisible();
  act(() => lk.state.rooms[0].emit('connectionStateChanged', 'reconnecting'));
  expect(screen.queryByText("You're on air")).toBeNull();
  expect(screen.queryByText('Off air')).toBeNull();
});

it('a cue message from another participant does not set the banner', async () => {
  admission = 'admitted';
  cueState = 'standby';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  act(() =>
    lk.state.rooms[0].emit('dataReceived', cueMessage('live'), { identity: 'guest-other' }, undefined, 'alcantara-director'),
  );
  expect(screen.queryByText("You're on air")).toBeNull();
  expect(screen.getByText('Off air')).toBeVisible();
});

it('a heartbeat that started before the studio cue cannot override it, in either direction', async () => {
  admission = 'admitted';
  cueState = 'live';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  expect(screen.getByText("You're on air")).toBeVisible();
  // A beat that the server answers as live, held on the way back, while the studio sends wrap.
  let release!: () => void;
  heartbeatGate = new Promise<void>((resolve) => (release = resolve));
  await act(async () => scheduledBeat!());
  act(() => lk.state.rooms[0].emit('dataReceived', cueMessage('wrap'), undefined, undefined, 'alcantara-director'));
  expect(screen.getByText('Off air')).toBeVisible();
  await act(async () => release());
  heartbeatGate = null;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(screen.getByText('Off air')).toBeVisible();
  expect(screen.queryByText("You're on air")).toBeNull();
});

it('a studio live cue, then the confirming beat, shows on air', async () => {
  admission = 'admitted';
  cueState = 'standby';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  cueState = 'live';
  act(() => lk.state.rooms[0].emit('dataReceived', cueMessage('live'), undefined, undefined, 'alcantara-director'));
  expect(screen.getByText("You're on air")).toBeVisible();
  // The confirming beat about two seconds later reads the stored state; it agrees.
  const before = beats.length;
  await waitFor(() => expect(beats.length).toBeGreaterThan(before), { timeout: 3_000 });
  expect(screen.getByText("You're on air")).toBeVisible();
});

it('a reconnect reads the studio cue at once, not on the next 20-second beat', async () => {
  admission = 'admitted';
  cueState = 'live';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  act(() => lk.state.rooms[0].emit('connectionStateChanged', 'reconnecting'));
  const before = beats.length;
  act(() => lk.state.rooms[0].emit('connectionStateChanged', 'connected'));
  await waitFor(() => expect(beats.length).toBeGreaterThan(before));
  expect(await screen.findByText("You're on air")).toBeVisible();
});

it('an answer in flight from before a reconnect cannot refill the cleared banner', async () => {
  admission = 'admitted';
  cueState = 'live';
  await joinAdmitted();
  await live();
  await waitFor(() => expect(beats.length).toBeGreaterThan(0));
  expect(screen.getByText("You're on air")).toBeVisible();
  let release!: () => void;
  heartbeatGate = new Promise<void>((resolve) => (release = resolve));
  await act(async () => scheduledBeat!());
  act(() => lk.state.rooms[0].emit('connectionStateChanged', 'reconnecting'));
  expect(screen.queryByText("You're on air")).toBeNull();
  await act(async () => release());
  heartbeatGate = null;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(screen.queryByText("You're on air")).toBeNull();
});


// A studio that cannot be reached while the guest waits: nothing is thrown at the page, and the wait goes on.
const dropHeartbeats = () => {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/webrtc/session/heartbeat')) throw new TypeError('offline');
    return original(input, init);
  }));
};

it('keeps waiting when the studio cannot be reached by the poll, and offers a rejoin when the room then drops', async () => {
  await join();
  dropHeartbeats();
  await act(async () => poll!());
  expect(screen.getByText('Waiting for the producer to let you in')).toBeVisible();
  await act(async () => lk.state.rooms[0].emit('disconnected', 3));
  expect(await screen.findByText(/Your connection to the studio dropped/)).toBeVisible();
});

it('waits with the chosen devices and no self-view track when the room publishes none', async () => {
  vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Camera' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' }
  ] as MediaDeviceInfo[]);
  const original = lk.Room.prototype.connect;
  lk.Room.prototype.connect = async function (this: InstanceType<typeof lk.Room>, url: string, token: string) {
    this.localParticipant.getTrackPublication = () => undefined as never;
    await original.call(this, url, token);
  };
  dropHeartbeats();
  try {
    await join();
  } finally {
    lk.Room.prototype.connect = original;
  }
  expect(lk.state.rooms[0].media).toEqual(['camera:true', 'microphone:true']);
});
