import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CallsRoute from './calls';

// Call telemetry: the operator's talkback reports how its own connection went, and each guest row shows the path.

const lk = vi.hoisted(() => {
  const state = { fail: null as unknown };
  class Room {
    localParticipant = {
      trackPublications: new Map<string, unknown>(),
      publishTrack: async () => {
        const stats = new Map([
          ['P', { type: 'candidate-pair', localCandidateId: 'L', nominated: true, state: 'succeeded' }],
          ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }]
        ]);
        this.localParticipant.trackPublications.set('mic', { track: { getRTCStatsReport: async () => stats } });
      }
    };
    async connect() {
      if (state.fail) throw state.fail;
    }
    disconnect() {}
  }
  return { state, Room };
});
const reports = vi.hoisted(() => ({ sent: [] as unknown[], refuse: false }));

vi.mock('livekit-client', () => ({ Room: lk.Room, createLocalAudioTrack: async () => ({ stop() {} }) }));
vi.mock('../hooks/useFeatures', () => ({ useFeatures: () => ({ hasPermission: () => true }) }));
vi.mock('../utils/globalProgram', () => ({ useGlobalProgramId: () => ['main'] }));
vi.mock('../services/api', () => ({
  authFetch: async (path: string, init?: RequestInit) => {
    if (path === '/webrtc/operator-report') {
      if (reports.refuse) throw new Error('offline');
      reports.sent.push(JSON.parse(String(init!.body)));
      return new Response(null, { status: 201 });
    }
    if (path === '/webrtc/operator-token') return Response.json({ serverUrl: 'wss://livekit.example', token: 'fictional' });
    if (path === '/webrtc/invitations')
      return Response.json([{ id: 'inv-1', programId: 'main', displayName: 'Ada', slotNumber: 1, status: 'active', expiresAt: '2026-12-01T00:00:00Z' }]);
    return Response.json({
      participants: [
        {
          invitationId: 'inv-1',
          identity: 'guest-ada',
          name: 'Ada',
          slotNumber: 1,
          connectionState: 'connected',
          returnVideo: 'program',
          returnAudioBus: 'master',
          sourceGain: 1,
          sourceMuted: false,
          sourceDelayMs: 0,
          tracks: [],
          commands: [],
          icePath: 'relay'
        }
      ]
    });
  }
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reports.sent = [];
  reports.refuse = false;
  lk.state.fail = null;
});

async function talk() {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true })));
  render(<CallsRoute />);
  await screen.findByText('Ada', { selector: 'h3' });
  fireEvent.pointerDown(screen.getByRole('button', { name: /Hold · talk/ }));
}

it('shows the guest’s path and reports a talkback that connected, with its path', async () => {
  await talk();
  expect(screen.getByText('Path: relayed (TURN)')).toBeTruthy();
  await waitFor(() => expect(reports.sent).toEqual([{ result: 'success', icePath: 'udp' }]));
});

it('reports why a talkback failed', async () => {
  lk.state.fail = Object.assign(new Error('refused'), { name: 'ConnectionError', reasonName: 'NotAllowed' });
  await talk();
  await waitFor(() => expect(reports.sent).toEqual([{ result: 'token_rejected', icePath: null }]));
});

it('keeps the talkback’s own error when the report cannot be sent', async () => {
  reports.refuse = true;
  lk.state.fail = new Error('The microphone is busy.');
  await talk();
  expect(await screen.findByText('The microphone is busy.')).toBeTruthy();
});
