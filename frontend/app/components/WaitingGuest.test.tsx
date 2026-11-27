import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WaitingGuest } from './WaitingGuest';
import { resetLocalAudio, setHostMicLive, setOnHeadphones } from '../utils/localAudio';

const mic = vi.hoisted(() => ({ value: null as null | { state: 'off' | 'on' } }));
vi.mock('./HostMicOnAir', () => ({ useHostMic: () => mic.value }));

// Screening before air: the operator's private link to a waiting guest, and Admit or Decline.

const lk = vi.hoisted(() => {
  const state = { rooms: [] as InstanceType<typeof Room>[], tracks: [] as { stopped: boolean }[], hold: null as null | (() => void), holding: false };
  class Room {
    published: string[] = [];
    disconnected = false;
    subscribed: ((track: unknown) => void) | null = null;
    localParticipant = { publishTrack: async (_track: unknown, options: { name: string }) => void this.published.push(options.name) };
    constructor() {
      state.rooms.push(this);
    }
    on(_event: string, handler: (track: unknown) => void) {
      this.subscribed = handler;
      return this;
    }
    async connect() {
      if (state.holding) await new Promise<void>((resolve) => (state.hold = resolve));
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  return { state, Room };
});
vi.mock('livekit-client', () => ({
  Room: lk.Room,
  RoomEvent: { TrackSubscribed: 'trackSubscribed' },
  Track: { Kind: { Video: 'video' } },
  createLocalAudioTrack: async () => {
    const track = { stopped: false, stop: () => void (track.stopped = true) };
    lk.state.tracks.push(track);
    return track;
  }
}));
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/api', () => ({ authFetch: api.fetch }));

beforeEach(() => {
  lk.state.rooms = [];
  lk.state.tracks = [];
  lk.state.holding = false;
  api.fetch.mockReset().mockImplementation(async () => Response.json({ serverUrl: 'wss://livekit.example', token: 'fictional' }));
});
afterEach(() => {
  cleanup();
  resetLocalAudio();
  window.localStorage.clear();
  mic.value = null;
});

const admit = vi.fn();
const decline = vi.fn();
const mount = (canOperate = true) =>
  render(
    <ul>
      <WaitingGuest invitationId='inv-1' name='Ada' slot={2} canOperate={canOperate} busy={false} onAdmit={admit} onDecline={decline} />
    </ul>
  );
const talk = () => screen.getByRole('button', { name: 'Talk to Ada privately' });

it('says the guest is off air, and admits or declines', () => {
  mount();
  expect(screen.getByText('Slot 2 · waiting to be let in · not on air')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Admit Ada' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decline Ada' }));
  expect(admit).toHaveBeenCalledTimes(1);
  expect(decline).toHaveBeenCalledTimes(1);
});

it('opens a private two-way link, shows the guest, and closes the microphone when ended or removed', async () => {
  const view = mount();
  fireEvent.click(talk());
  await waitFor(() => expect(lk.state.rooms[0].published).toEqual(['talkback:inv-1']));
  expect(api.fetch).toHaveBeenCalledWith('/webrtc/invitations/inv-1/screening-token', { method: 'POST' });
  const attach = vi.fn();
  act(() => lk.state.rooms[0].subscribed!({ kind: 'video', attach }));
  act(() => lk.state.rooms[0].subscribed!({ kind: 'audio', attach }));
  expect(attach.mock.calls.map((call) => (call[0] as Element).tagName)).toEqual(['VIDEO', 'AUDIO']);
  fireEvent.click(talk());
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(lk.state.rooms[0].disconnected).toBe(true);

  fireEvent.click(talk());
  await waitFor(() => expect(lk.state.rooms[1].published).toEqual(['talkback:inv-1']));
  view.unmount();
  expect(lk.state.tracks[1].stopped).toBe(true);
  expect(lk.state.rooms[1].disconnected).toBe(true);
});

it('does not open the microphone when ended while still connecting', async () => {
  lk.state.holding = true;
  mount();
  fireEvent.click(talk());
  await waitFor(() => expect(lk.state.hold).not.toBeNull());
  fireEvent.click(talk());
  await act(async () => lk.state.hold!());
  expect(lk.state.rooms[0].published).toEqual([]);
  expect(lk.state.tracks.every((track) => track.stopped)).toBe(true);
});

it('says why the link could not be opened', async () => {
  api.fetch.mockResolvedValue(new Response(null, { status: 503 }));
  mount();
  fireEvent.click(talk());
  expect(await screen.findByRole('alert')).toHaveTextContent('The private link could not be opened.');
  expect(talk()).toHaveAttribute('aria-pressed', 'false');
});

// gaulatti/alcantara#879: a waiting guest's voice from speakers would reach the open host microphone.
it('plays the waiting guest aloud only with the mic off, or on headphones, and says which', async () => {
  mic.value = { state: 'on' };
  setHostMicLive(true);
  mount();
  fireEvent.click(talk());
  await waitFor(() => expect(lk.state.rooms[0].published).toEqual(['talkback:inv-1']));
  const attach = vi.fn();
  act(() => lk.state.rooms[0].subscribed!({ kind: 'audio', attach }));
  const audio = document.querySelector('audio')!;
  expect(attach).toHaveBeenCalledWith(audio);
  expect(audio.muted).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent('PFL muted');
  act(() => setOnHeadphones(true));
  expect(audio.muted).toBe(false);
  expect(screen.getByRole('status')).toHaveTextContent('PFL on headphones');
  act(() => setOnHeadphones(false));
  expect(audio.muted).toBe(true);
  act(() => setHostMicLive(false));
  expect(audio.muted).toBe(false);
});

it('ignores a track that arrives after the card is gone', async () => {
  const view = mount();
  fireEvent.click(talk());
  await waitFor(() => expect(lk.state.rooms[0].published).toEqual(['talkback:inv-1']));
  view.unmount();
  const attach = vi.fn();
  act(() => lk.state.rooms[0].subscribed!({ kind: 'audio', attach }));
  expect(attach).not.toHaveBeenCalled();
});

it('stays quiet when a link the operator already ended then fails', async () => {
  let fail!: (reason: unknown) => void;
  api.fetch.mockImplementation(() => new Promise<Response>((_resolve, reject) => (fail = reject)));
  mount();
  fireEvent.click(talk());
  fireEvent.click(talk());
  await act(async () => fail(new Error('late failure')));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('says the link could not be opened when the failure is not an error', async () => {
  api.fetch.mockRejectedValue('offline');
  mount();
  fireEvent.click(talk());
  expect(await screen.findByRole('alert')).toHaveTextContent('The private link could not be opened.');
});
