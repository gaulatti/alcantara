import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { ProgramService } from './program.service';

type ProgramRealtimeRole = 'program' | 'control' | 'unknown';

interface ProgramRealtimeClient {
  socket: WebSocket;
  programId: string;
  role: ProgramRealtimeRole;
}

interface ProgramAudioMeterLevels {
  song: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  instants: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  sceneInstant: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  main: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  updatedAt: string;
}

interface ProgramSongPlayback {
  token: string;
  audioUrl: string;
  progress: number;
  currentTimeMs: number;
  durationMs: number | null;
  isPlaying: boolean;
  updatedAt: string;
}

@Injectable()
export class ProgramRealtimeService implements OnModuleDestroy {
  private static readonly DEFAULT_PROGRAM_ID = 'main';
  private readonly logger = new Logger(ProgramRealtimeService.name);
  private readonly clients = new Set<ProgramRealtimeClient>();
  private wsServer: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private removeProgramEventListener: (() => void) | null = null;

  constructor(private readonly programService: ProgramService) {
    this.removeProgramEventListener = this.programService.addEventListener(
      (event) => {
        this.forwardProgramServiceEvent(event);
      },
    );
  }

  attachToServer(server: HttpServer): void {
    if (this.httpServer === server && this.wsServer) {
      return;
    }

    this.detach();
    this.httpServer = server;
    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', this.handleUpgrade);
  }

  broadcastAudioMeterUpdate(
    programId: string,
    levels: ProgramAudioMeterLevels,
  ): void {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const payload = JSON.stringify({
      type: 'audio_meter_update',
      programId: normalizedProgramId,
      levels,
    });

    for (const client of this.clients) {
      if (
        client.programId !== normalizedProgramId ||
        client.socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      client.socket.send(payload);
    }
  }

  broadcastSongPlaybackUpdate(
    programId: string,
    playback: ProgramSongPlayback,
  ): void {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const payload = JSON.stringify({
      type: 'song_playback_update',
      programId: normalizedProgramId,
      playback,
    });

    for (const client of this.clients) {
      if (
        client.programId !== normalizedProgramId ||
        client.socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      client.socket.send(payload);
    }
  }

  onModuleDestroy(): void {
    if (this.removeProgramEventListener) {
      this.removeProgramEventListener();
      this.removeProgramEventListener = null;
    }
    this.detach();
  }

  private detach(): void {
    if (this.httpServer) {
      this.httpServer.off('upgrade', this.handleUpgrade);
      this.httpServer = null;
    }

    for (const client of this.clients) {
      try {
        client.socket.close();
      } catch {
        // no-op
      }
    }
    this.clients.clear();

    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    if (!this.wsServer) {
      return;
    }

    const connection = this.parseConnection(request);
    if (!connection) {
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, connection.programId, connection.role);
    });
  };

  private parseConnection(
    request: IncomingMessage,
  ): { programId: string; role: ProgramRealtimeRole } | null {
    const baseUrl = `http://${request.headers.host ?? 'localhost'}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(request.url ?? '', baseUrl);
    } catch {
      return null;
    }

    if (parsedUrl.pathname !== '/program/ws') {
      return null;
    }

    const programId = this.normalizeProgramId(
      parsedUrl.searchParams.get('programId'),
    );
    const role = this.normalizeRole(parsedUrl.searchParams.get('role'));

    return { programId, role };
  }

  private normalizeProgramId(programId: unknown): string {
    if (typeof programId !== 'string') {
      return ProgramRealtimeService.DEFAULT_PROGRAM_ID;
    }
    const normalized = programId.trim();
    return normalized || ProgramRealtimeService.DEFAULT_PROGRAM_ID;
  }

  private normalizeRole(role: unknown): ProgramRealtimeRole {
    if (role === 'program' || role === 'control') {
      return role;
    }
    return 'unknown';
  }

  private handleConnection(
    socket: WebSocket,
    programId: string,
    role: ProgramRealtimeRole,
  ): void {
    const client: ProgramRealtimeClient = {
      socket,
      programId,
      role,
    };

    this.clients.add(client);
    this.sendInitialProgramStateSnapshot(client);
    this.sendInitialAudioBusSnapshot(client);
    this.sendInitialBroadcastSettingsSnapshot(client);
    this.sendInitialMeterSnapshot(client);
    this.sendInitialSongPlaybackSnapshot(client);
    this.sendInitialSceneInstantSnapshot(client);

    socket.on('message', (rawData) => {
      void this.handleMessage(client, rawData);
    });

    socket.on('close', () => {
      this.clients.delete(client);
    });

    socket.on('error', (error) => {
      this.logger.warn(`Program WS client error: ${String(error)}`);
      this.clients.delete(client);
    });
  }

  private async sendInitialMeterSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const levels = await this.programService.getProgramAudioMeter(
        client.programId,
      );
      this.sendJson(client.socket, {
        type: 'audio_meter_update',
        programId: client.programId,
        levels,
      });
    } catch {
      // no-op
    }
  }

  private async sendInitialProgramStateSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const state = await this.programService.getState(client.programId);
      this.sendJson(client.socket, {
        type: 'program_state_snapshot',
        programId: client.programId,
        state,
      });
    } catch {
      // no-op
    }
  }

  private async sendInitialAudioBusSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const settings = await this.programService.getProgramAudioBus(
        client.programId,
      );
      this.sendJson(client.socket, {
        type: 'audio_bus_snapshot',
        programId: client.programId,
        settings,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // no-op
    }
  }

  private async sendInitialBroadcastSettingsSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const settings = await this.programService.getBroadcastSettings();
      this.sendJson(client.socket, {
        type: 'broadcast_settings_snapshot',
        settings,
      });
    } catch {
      // no-op
    }
  }

  private async sendInitialSongPlaybackSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const playback = await this.programService.getProgramSongPlayback(
        client.programId,
      );
      this.sendJson(client.socket, {
        type: 'song_playback_update',
        programId: client.programId,
        playback,
      });
    } catch {
      // no-op
    }
  }

  private async sendInitialSceneInstantSnapshot(
    client: ProgramRealtimeClient,
  ): Promise<void> {
    try {
      const playback = await this.programService.getProgramSceneInstantPlayback(
        client.programId,
      );
      this.sendJson(client.socket, {
        type: 'scene_instant_state',
        programId: client.programId,
        playback,
      });
    } catch {
      // no-op
    }
  }

  private async handleMessage(
    client: ProgramRealtimeClient,
    rawData: RawData,
  ): Promise<void> {
    const messageText = this.decodeRawData(rawData);
    if (!messageText) {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(messageText);
    } catch {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'audio_meter_update') {
      if (client.role !== 'program') {
        return;
      }
      try {
        const meterLevels =
          payload.levels && typeof payload.levels === 'object'
            ? payload.levels
            : payload;
        await this.programService.updateProgramAudioMeter(
          meterLevels,
          client.programId,
        );
      } catch {
        // ignore malformed payloads from client
      }
      return;
    }

    if (payload.type === 'song_playback_update') {
      if (client.role !== 'program') {
        return;
      }
      try {
        const songPlayback =
          payload.playback && typeof payload.playback === 'object'
            ? payload.playback
            : payload;
        await this.programService.updateProgramSongPlayback(
          songPlayback,
          client.programId,
        );
      } catch {
        // ignore malformed payloads from client
      }
    }
  }

  private decodeRawData(rawData: RawData): string {
    if (typeof rawData === 'string') {
      return rawData;
    }

    if (rawData instanceof Buffer) {
      return rawData.toString('utf8');
    }

    if (Array.isArray(rawData)) {
      return Buffer.concat(rawData).toString('utf8');
    }

    return Buffer.from(rawData).toString('utf8');
  }

  private sendJson(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }

  private forwardProgramServiceEvent(event: {
    scope: 'program' | 'global';
    programId: string | null;
    data: any;
  }): void {
    if (event.scope === 'global') {
      this.broadcastGlobalEvent(event.data);
      return;
    }

    if (!event.programId) {
      return;
    }

    const normalizedProgramId = this.normalizeProgramId(event.programId);
    const payload = this.enrichProgramScopedPayload(
      event.data,
      normalizedProgramId,
    );
    this.broadcastProgramScopedEvent(normalizedProgramId, payload);
  }

  private enrichProgramScopedPayload(
    payload: any,
    programId: string,
  ): any {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        type: 'program_event',
        programId,
        payload,
      };
    }

    if ('programId' in payload) {
      return payload;
    }

    return {
      ...payload,
      programId,
    };
  }

  private broadcastProgramScopedEvent(programId: string, payload: any): void {
    const encoded = JSON.stringify(payload);
    for (const client of this.clients) {
      if (
        client.programId !== programId ||
        client.socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      client.socket.send(encoded);
    }
  }

  private broadcastGlobalEvent(payload: any): void {
    const encoded = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      client.socket.send(encoded);
    }
  }
}
