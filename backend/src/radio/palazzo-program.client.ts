import { Logger } from '@nestjs/common';
import type {
  PalazzoConnectionState,
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
  PalazzoProgramStatus,
  PalazzoProgramType,
} from './palazzo-contract';
import { parsePalazzoState } from './palazzo-contract';
import type { RadioMetricsService } from './radio-metrics.service';

export type PalazzoInstanceValidation = 'ok' | 'mismatch' | 'conflict';

export interface PalazzoProgramClientCallbacks {
  onSnapshot: (programId: string, state: PalazzoPlaybackState) => void;
  onEvent: (programId: string, event: PalazzoPlaybackEvent) => void;
  onStatus: (programId: string, status: PalazzoProgramStatus) => void;
  validateInstance: (programId: string, instanceId: string) => PalazzoInstanceValidation;
}

export interface PalazzoProgramClientOptions {
  programId: string;
  programType: PalazzoProgramType;
  palazzoUrl: string;
  metrics: RadioMetricsService;
  callbacks: PalazzoProgramClientCallbacks;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  stalenessMs?: number;
}

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALENESS_MS = 15_000;

/**
 * Consumes one Palazzo instance's authoritative playback telemetry for one
 * radio-capable program.
 *
 * The client opens a single SSE connection to `/playback/events`, validates
 * the instance identity reported by Palazzo before any telemetry is accepted,
 * deduplicates events by `bootId + sequence`, and falls back to polling the
 * private `/playback/state` endpoint while SSE reconnects. When both
 * transports are unavailable the program's radio leg is marked unavailable and
 * no telemetry is forwarded, so the engine freezes rather than advancing on
 * guesses.
 */
export class PalazzoProgramClient {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly stalenessMs: number;

  private abort: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;

  private instanceId: string | null = null;
  private currentBootId: string | null = null;
  private lastSequence = 0;
  private lastEventAt: number | null = null;
  private lastSnapshotAt: number | null = null;
  private connection: PalazzoConnectionState = 'connecting';
  private detail: string | null = null;
  private sseLoopRunning = false;
  private pollInFlight = false;

  constructor(private readonly options: PalazzoProgramClientOptions) {
    this.logger = new Logger(`PalazzoClient(${options.programId})`);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;
  }

  get programId(): string {
    return this.options.programId;
  }

  get knownInstanceId(): string | null {
    return this.instanceId;
  }

  getStatus(): PalazzoProgramStatus {
    return {
      programId: this.options.programId,
      programType: this.options.programType,
      palazzoUrl: this.options.palazzoUrl,
      instanceId: this.instanceId,
      connection: this.connection,
      lastEventAt: isoOrNull(this.lastEventAt),
      lastSnapshotAt: isoOrNull(this.lastSnapshotAt),
      degraded: this.isDegraded(),
      detail: this.detail,
    };
  }

  start(): void {
    if (this.stopped) return;
    this.setConnection('connecting', null);
    void this.runSseLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearPollTimer();
    this.abort?.abort();
    this.abort = null;
  }

  private async runSseLoop(): Promise<void> {
    if (this.sseLoopRunning) return;
    this.sseLoopRunning = true;
    try {
      while (!this.stopped) {
        this.options.metrics.recordReconnectAttempt();
        const connected = await this.connectOnce();
        if (this.stopped) return;
        if (connected) {
          this.clearPollTimer();
          this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
          this.setConnection('connected', null);
        } else {
          this.options.metrics.recordReconnectFailure();
          if (this.connection !== 'unavailable') {
            this.setConnection('connecting', 'sse connect failed');
          }
          this.startPolling();
        }
        if (this.stopped) return;
        // connectOnce resolves only when the stream ends or fails.
        await this.waitForReconnect();
      }
    } finally {
      this.sseLoopRunning = false;
    }
  }

  private async connectOnce(): Promise<boolean> {
    this.abort = new AbortController();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    const lastId = this.lastAcceptedEventId();
    if (lastId) headers['Last-Event-ID'] = lastId;

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.palazzoUrl.replace(/\/+$/, '')}/playback/events`,
        { headers, signal: this.abort.signal },
      );
    } catch {
      return false;
    }
    if (!response.ok || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        // no-op
      }
      return false;
    }

    try {
      await this.consumeStream(response.body);
      return true;
    } catch {
      return false;
    } finally {
      try {
        await response.body?.cancel();
      } catch {
        // no-op
      }
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
          const rawFrame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.handleFrame(rawFrame);
          if (this.stopped) {
            await reader.cancel();
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(rawFrame: string): void {
    const frame = parseSseFrame(rawFrame);
    if (!frame) return;
    let event: PalazzoPlaybackEvent | null = null;
    try {
      event = JSON.parse(frame.data) as PalazzoPlaybackEvent;
    } catch {
      this.logger.warn(`Discarding malformed Palazzo event on ${this.options.programId}`);
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.bootId !== 'string') {
      return;
    }
    if (frame.id) event.id = frame.id;
    this.acceptEvent(event);
  }

  private acceptEvent(event: PalazzoPlaybackEvent): void {
    if (event.type === 'snapshot') {
      const state = parsePalazzoState(event.data?.state);
      if (!state) return;
      if (!this.validateInstanceId(state.instanceId)) return;
      this.rebaseCursor(state.bootId, state.sequence);
      this.lastSnapshotAt = Date.now();
      this.touch(event);
      // A valid snapshot proves the SSE stream is connected. Waiting for the
      // long-lived stream to close before marking it connected leaves the
      // automation engine permanently "unreconciled" during healthy service
      // and prevents idle startup recovery.
      this.setConnection('connected', null);
      this.options.callbacks.onSnapshot(this.options.programId, state);
      return;
    }

    if (event.instanceId && this.instanceId && event.instanceId !== this.instanceId) {
      this.options.metrics.recordEventIgnored('superseded-boot');
      return;
    }

    if (this.currentBootId === null) {
      // No accepted snapshot yet: lifecycle events cannot be correlated.
      this.options.metrics.recordEventIgnored('superseded-boot');
      return;
    }

    if (event.bootId !== this.currentBootId) {
      this.options.metrics.recordEventIgnored('superseded-boot');
      return;
    }

    if (event.sequence === this.lastSequence) {
      this.options.metrics.recordEventIgnored('duplicate');
      return;
    }
    if (event.sequence < this.lastSequence) {
      this.options.metrics.recordEventIgnored('stale-sequence');
      return;
    }

    this.lastSequence = event.sequence;
    this.touch(event);
    this.options.callbacks.onEvent(this.options.programId, event);
  }

  private rebaseCursor(bootId: string, sequence: number): void {
    this.currentBootId = bootId;
    this.lastSequence = sequence;
  }

  private validateInstanceId(instanceId: string): boolean {
    if (!this.instanceId) {
      const verdict = this.options.callbacks.validateInstance(
        this.options.programId,
        instanceId,
      );
      if (verdict === 'conflict') {
        this.setConnection(
          'instance-conflict',
          `another program already owns Palazzo instance ${instanceId}`,
        );
        this.options.metrics.recordSnapshotReconciliation('instance-conflict');
        this.stopInternal();
        return false;
      }
      if (verdict === 'mismatch') {
        this.setConnection(
          'instance-mismatch',
          `Palazzo identity changed to ${instanceId}`,
        );
        this.options.metrics.recordSnapshotReconciliation('instance-mismatch');
        this.stopInternal();
        return false;
      }
      this.instanceId = instanceId;
      this.options.metrics.recordSnapshotReconciliation('accepted');
      return true;
    }
    if (instanceId !== this.instanceId) {
      this.setConnection(
        'instance-mismatch',
        `Palazzo identity changed from ${this.instanceId} to ${instanceId}`,
      );
      this.options.metrics.recordSnapshotReconciliation('instance-mismatch');
      this.stopInternal();
      return false;
    }
    this.options.metrics.recordSnapshotReconciliation('accepted');
    return true;
  }

  private touch(event: PalazzoPlaybackEvent): void {
    const occurred = Date.parse(event.occurredAt);
    this.lastEventAt = Number.isFinite(occurred) ? occurred : Date.now();
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    void this.pollOnce();
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.pollInFlight) return;
    if (this.connection === 'connected') return;
    this.pollInFlight = true;
    try {
      const state = await this.fetchState();
      if (!state) {
        if (this.isTerminalConnection()) {
          this.setConnection('unavailable', 'sse and state endpoint unreachable');
        }
        return;
      }
      if (!this.validateInstanceId(state.instanceId)) return;
      this.rebaseCursor(state.bootId, state.sequence);
      this.lastSnapshotAt = Date.now();
      this.lastEventAt = Date.now();
      if (this.isTransientConnection()) {
        this.setConnection('polling', 'sse unavailable; polling state endpoint');
      }
      this.options.callbacks.onSnapshot(this.options.programId, state);
    } catch {
      if (this.isTerminalConnection()) {
        this.setConnection('unavailable', 'sse and state endpoint unreachable');
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private isTerminalConnection(): boolean {
    return (
      this.connection !== 'instance-mismatch' &&
      this.connection !== 'instance-conflict'
    );
  }

  private isTransientConnection(): boolean {
    return (
      this.connection !== 'connected' &&
      this.connection !== 'polling' &&
      this.connection !== 'instance-mismatch' &&
      this.connection !== 'instance-conflict'
    );
  }

  private async fetchState(): Promise<PalazzoPlaybackState | null> {
    try {
      const response = await this.fetchImpl(
        `${this.options.palazzoUrl.replace(/\/+$/, '')}/playback/state`,
        { signal: this.abort?.signal },
      );
      if (!response.ok) return null;
      return parsePalazzoState(await response.json());
    } catch {
      return null;
    }
  }

  private lastAcceptedEventId(): string | null {
    if (!this.currentBootId) return null;
    if (this.lastSequence <= 0) return null;
    return `${this.currentBootId}:${this.lastSequence}`;
  }

  private waitForReconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        resolve();
      }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        MAX_RECONNECT_DELAY_MS,
      );
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopInternal(): void {
    this.clearReconnectTimer();
    this.clearPollTimer();
    this.abort?.abort();
  }

  private isDegraded(): boolean {
    if (
      this.connection === 'unavailable' ||
      this.connection === 'instance-mismatch' ||
      this.connection === 'instance-conflict'
    ) {
      return true;
    }
    if (this.connection === 'connected' && this.lastEventAt) {
      return Date.now() - this.lastEventAt > this.stalenessMs;
    }
    return false;
  }

  private setConnection(state: PalazzoConnectionState, detail: string | null): void {
    if (this.connection === state && this.detail === detail) return;
    const previous = this.connection;
    this.connection = state;
    this.detail = detail;
    if (previous !== state && previous !== 'connecting') {
      this.options.metrics.recordConnectionState(previous, -1);
    }
    if (previous !== state) {
      this.options.metrics.recordConnectionState(state, 1);
    }
    this.options.callbacks.onStatus(this.options.programId, this.getStatus());
  }
}

function parseSseFrame(rawFrame: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of rawFrame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
    else if (field === 'event') event = value;
  }
  if (!dataLines.length) return null;
  return { id, event, data: dataLines.join('\n') };
}

function isoOrNull(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}
