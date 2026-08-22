import { createServer, Server } from 'http';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';
import { ProgramRealtimeService } from './program.realtime.service';

describe('ProgramRealtimeService renderer isolation', () => {
  const programService = {
    addEventListener: jest.fn(() => jest.fn()),
    getState: jest.fn().mockResolvedValue({ version: 1 }),
    getProgramAudioBus: jest.fn().mockResolvedValue({ version: 1 }),
    getBroadcastSettings: jest.fn().mockResolvedValue({ version: 1 }),
    getProgramAudioMeter: jest.fn().mockResolvedValue({ version: 1 }),
    getProgramSongPlayback: jest.fn().mockResolvedValue({ version: 1 }),
    getProgramSceneInstantPlayback: jest.fn().mockResolvedValue({ version: 1 }),
    updateProgramAudioMeter: jest.fn(),
    updateProgramSongPlayback: jest.fn(),
  };
  const flightService = {
    handleSongEnded: jest.fn(),
  };
  let service: ProgramRealtimeService;

  const rendererClient = {
    socket: { readyState: WebSocket.OPEN },
    programId: 'main',
    role: 'program',
  };

  const decodeMessage = (data: RawData): string =>
    Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : Buffer.from(data).toString('utf8');

  const getMessageType = (message: string): string => {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      throw new Error('Expected a typed realtime message');
    }
    return String(parsed.type);
  };

  const send = async (payload: Record<string, unknown>) => {
    const subject = service as unknown as {
      handleMessage(client: unknown, data: Buffer): Promise<void>;
    };
    await subject.handleMessage(
      rendererClient,
      Buffer.from(JSON.stringify(payload)),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProgramRealtimeService(
      programService as never,
      flightService as never,
      new RealtimeTicketService(),
    );
  });

  it('keeps a renderer role out of operator snapshots even when given a valid ticket', async () => {
    const tickets = new RealtimeTicketService();
    const issued = tickets.issue('main');
    const isolatedService = new ProgramRealtimeService(
      programService as never,
      flightService as never,
      tickets,
    );
    const server: Server = createServer();
    isolatedService.attachToServer(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address');
    }

    const renderer = new WebSocket(
      `ws://127.0.0.1:${address.port}/program/ws?programId=main&role=program&ticket=${issued.ticket}`,
    );
    const rendererMessages: string[] = [];
    renderer.on('message', (data) =>
      rendererMessages.push(decodeMessage(data)),
    );
    await new Promise<void>((resolve, reject) => {
      renderer.once('open', resolve);
      renderer.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rendererMessages).toEqual([]);
    renderer.close();

    const control = new WebSocket(
      `ws://127.0.0.1:${address.port}/program/ws?programId=main&role=control&ticket=${issued.ticket}`,
    );
    const controlMessages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      control.on('message', (data) => {
        controlMessages.push(decodeMessage(data));
        if (controlMessages.length === 6) {
          resolve();
        }
      });
      control.once('error', reject);
    });

    expect(controlMessages.map(getMessageType)).toEqual(
      expect.arrayContaining([
        'program_state_snapshot',
        'audio_bus_snapshot',
        'broadcast_settings_snapshot',
        'audio_meter_update',
        'song_playback_update',
        'scene_instant_state',
      ]),
    );

    control.close();
    isolatedService.onModuleDestroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('accepts only renderer-owned telemetry, playback, and song completion', async () => {
    const levels = { main: { vu: -12 } };
    const playback = { token: 'song-7', progress: 0.4 };

    await send({ type: 'audio_meter_update', levels });
    await send({ type: 'song_playback_update', playback });
    await send({ type: 'song_ended' });

    expect(programService.updateProgramAudioMeter).toHaveBeenCalledWith(
      levels,
      'main',
    );
    expect(programService.updateProgramSongPlayback).toHaveBeenCalledWith(
      playback,
      'main',
    );
    expect(flightService.handleSongEnded).toHaveBeenCalledWith('main');
  });

  it.each([
    'program_state_update',
    'scene_activate',
    'audio_bus_update',
    'flight_go',
  ])(
    'rejects renderer attempts to invoke operator message %s',
    async (type) => {
      await send({ type, sceneId: 7, enabled: true });

      expect(programService.updateProgramAudioMeter).not.toHaveBeenCalled();
      expect(programService.updateProgramSongPlayback).not.toHaveBeenCalled();
      expect(flightService.handleSongEnded).not.toHaveBeenCalled();
    },
  );
});
