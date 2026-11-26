import { Logger } from '@nestjs/common';
import type {
  PalazzoConnectionState,
  PalazzoEventEnvelope,
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
  PalazzoProgramStatus,
  PalazzoProgramType,
} from './palazzo-contract';
import { classifyPalazzoFrame, parsePalazzoState } from './palazzo-contract';
import type {
  PalazzoUnknownField,
  RadioMetricsService,
} from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';

export type PalazzoInstanceValidation = 'ok' | 'mismatch' | 'conflict';

export interface PalazzoProgramClientCallbacks {
  onSnapshot: (programId: string, state: PalazzoPlaybackState) => void;
  onEvent: (programId: string, event: PalazzoPlaybackEvent) => void;
  onStatus: (programId: string, status: PalazzoProgramStatus) => void;
  validateInstance: (
    programId: string,
    instanceId: string,
  ) => PalazzoInstanceValidation;
}

export interface PalazzoProgramClientOptions {
  programId: string;
  programType: PalazzoProgramType;
  palazzoUrl: string;
  metrics: RadioMetricsService;
  callbacks: PalazzoProgramClientCallbacks;
  machineClient: PalazzoMachineClient;
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
 * gaulatti/alcantara#734: an event stream that delivers no byte for this long is treated as lost. Palazzo emits
 * `playback.position` every second and a `heartbeat` every 10 s from its Liquidsoap sample loop
 * (gaulatti/palazzo src/stream/playback-telemetry.service.ts, `now - this.lastHeartbeatAt >= 10_000`, L556 at
 * 706c383), so 30 s is three missed heartbeats. A hung Palazzo (connections accepted, nothing answered) keeps the
 * TCP stream open and silent, and was never noticed. The stream is aborted and takes the usual path: `connecting`
 * (no freeze), the state-endpoint poll, reconnect. The engine freezes only if Palazzo also fails the state poll; a
 * Palazzo that answers reconnects with a snapshot at once and never freezes.
 */
export const PALAZZO_EVENT_IDLE_MS = 30_000;

/**
 * Consumes one Palazzo instance's authoritative playback telemetry for one
 * radio-capable program.
 *
 * The client opens a single SSE connection to the authenticated program-scoped
 * `/v1/programs/{programId}/playback/events` route, validates
 * the instance identity reported by Palazzo before any telemetry is accepted,
 * deduplicates events by `bootId + sequence`, and falls back to polling the
 * private program-scoped playback-state endpoint while SSE reconnects. When both
 * transports are unavailable the program's radio leg is marked unavailable and
 * no telemetry is forwarded, so the engine freezes rather than advancing on
 * guesses.
 */
export class PalazzoProgramClient {
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly stalenessMs: number;

  private abort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the idle watchdog aborted the stream, so the loop names the reason. */
  private idleAborted = false;
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
  private playout: 'up' | 'down' | null = null;
  private detail: string | null = null;
  private sseLoopRunning = false;
  private pollInFlight = false;
  private lastStatus: PalazzoPlaybackState['status'] | null = null;

  constructor(private readonly options: PalazzoProgramClientOptions) {
    this.logger = new Logger(`PalazzoClient(${options.programId})`);
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
      playout: this.playout,
    };
  }

  start(): void {
    if (this.stopped) return;
    this.setConnection('connecting', null);
    void this.runSseLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdleWatchdog();
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
            this.setConnection(
              'connecting',
              this.idleAborted
                ? 'sse idle: no event for 30 s'
                : 'sse connect failed',
            );
          }
          // The idle watchdog aborted this controller; the state poll reuses it, and an aborted signal would fail
          // the poll at once and read unavailable for a Palazzo that still answers (#734). Start a fresh one.
          if (this.idleAborted && this.abort?.signal.aborted) {
            this.abort = new AbortController();
          }
          this.idleAborted = false;
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
    const lastId = this.lastAcceptedEventId();

    let response: Response;
    try {
      response = await this.options.machineClient.connectEvents(
        this.options.palazzoUrl,
        this.options.programId,
        lastId,
        this.abort.signal,
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

    let consumed = true;
    try {
      await this.consumeStream(response.body);
    } catch {
      consumed = false;
    }
    try {
      await response.body?.cancel();
    } catch {
      // no-op
    }
    return consumed;
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.armIdleWatchdog();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Any byte proves the stream is alive, a partial frame included.
        this.armIdleWatchdog();
        buffer += decoder.decode(value, { stream: true });
        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator?.index !== undefined) {
          const rawFrame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          await this.handleFrame(rawFrame);
          if (this.stopped) {
            await reader.cancel();
            return;
          }
          separator = /\r?\n\r?\n/.exec(buffer);
        }
      }
    } finally {
      this.clearIdleWatchdog();
      reader.releaseLock();
    }
  }

  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleTimer = setTimeout(() => {
      // stop() clears this timer, so it never fires for a stopped client.
      this.idleTimer = null;
      this.idleAborted = true;
      this.options.metrics.recordEventStreamIdleDisconnect();
      this.logger.warn(
        `Palazzo event stream for ${this.options.programId} sent nothing for ${PALAZZO_EVENT_IDLE_MS / 1000} s; reconnecting`,
      );
      this.abort?.abort();
    }, PALAZZO_EVENT_IDLE_MS);
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async handleFrame(rawFrame: string): Promise<void> {
    const frame = parseSseFrame(rawFrame);
    if (!frame) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.data);
    } catch {
      this.options.metrics.recordEventIgnored('malformed');
      throw new Error('malformed Palazzo event');
    }
    const parsed = classifyPalazzoFrame(decoded, this.recordUnknown);
    if (parsed.kind === 'unknown-type') {
      this.skipUnknownEvent(parsed.envelope);
      return;
    }
    if (parsed.kind === 'unsupported-version') {
      // Another major version: nothing of the frame is read, and the stream
      // stays up (gaulatti/ariston#217). A later known event that skips past
      // its sequence is reconciled as a gap.
      this.options.metrics.recordEventIgnored('unsupported-version');
      return;
    }
    if (parsed.kind === 'malformed') {
      this.options.metrics.recordEventIgnored('malformed');
      throw new Error('malformed Palazzo event');
    }
    const event = parsed.event;
    if (frame.id) event.id = frame.id;
    await this.acceptEvent(event);
  }

  /**
   * A well-formed event of a type Alcantara does not know is skipped and
   * counted, never a reason to drop the stream (gaulatti/ariston#217). When it
   * is the next event of the accepted boot it still advances the cursor, so the
   * known event after it is not mistaken for a gap.
   */
  private skipUnknownEvent(envelope: PalazzoEventEnvelope): void {
    this.options.metrics.recordEventIgnored('unknown-type');
    if (
      this.currentBootId === null ||
      envelope.bootId !== this.currentBootId ||
      (this.instanceId !== null && envelope.instanceId !== this.instanceId) ||
      envelope.sequence <= this.lastSequence
    )
      return;
    this.lastSequence = envelope.sequence;
    this.touch(envelope);
  }

  private async acceptEvent(event: PalazzoPlaybackEvent): Promise<void> {
    const eventProgramId = event.data?.programId;
    if (
      typeof eventProgramId === 'string' &&
      eventProgramId !== this.options.programId
    ) {
      this.options.metrics.recordEventIgnored('cross-program');
      return;
    }
    if (event.type === 'snapshot') {
      let state = parsePalazzoState(event.data?.state, {
        previousStatus: this.lastStatus ?? undefined,
        onUnknown: this.recordUnknown,
      });
      if (!state) {
        // Palazzo's SSE security boundary intentionally strips URL-shaped
        // fields, including track and intro URLs, from snapshots. Hydrate the
        // redacted event through the authenticated state endpoint instead of
        // rejecting a healthy stream as malformed.
        state = await this.fetchState();
      }
      if (!state) {
        this.options.metrics.recordEventIgnored('malformed');
        throw new Error('malformed Palazzo snapshot');
      }
      if (state.intro && state.intro.programId !== this.options.programId) {
        this.options.metrics.recordEventIgnored('cross-program');
        return;
      }
      if (!this.validateInstanceId(state.instanceId)) return;
      this.rebaseCursor(state.bootId, state.sequence);
      this.lastSnapshotAt = Date.now();
      this.touch(event);
      // A valid snapshot proves the SSE stream is connected. Waiting for the
      // long-lived stream to close before marking it connected leaves the
      // automation engine permanently "unreconciled" during healthy service
      // and prevents idle startup recovery.
      this.setConnection('connected', null);
      this.emitSnapshot(state);
      return;
    }

    if (
      event.instanceId &&
      this.instanceId &&
      event.instanceId !== this.instanceId
    ) {
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

    if (event.type === 'replay.gap') {
      this.recordReplayGap(event);
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
    if (event.sequence > this.lastSequence + 1) {
      this.options.metrics.recordEventIgnored('sequence-gap');
      if (isLifecycleEvent(event.type)) {
        await this.reconcileGap();
        return;
      }
    }

    this.lastSequence = event.sequence;
    this.touch(event);
    if (event.type === 'telemetry.disconnected') this.setPlayout('down');
    else if (event.type === 'telemetry.connected') this.setPlayout('up');
    if (isEnginePlaybackEvent(event.type)) {
      this.options.callbacks.onEvent(this.options.programId, event);
    }
  }

  /**
   * Palazzo says the events between our last cursor and its snapshot are gone
   * (gaulatti/alcantara#240): the cursor was outside its replay window or came
   * from another boot. It arrives right after the snapshot, carrying the
   * snapshot's id, boot and sequence, and that snapshot has already been
   * hydrated and applied, so the state is current and there is nothing more to
   * fetch. It is counted under the existing gap counter and logged once; the
   * cursor stays at the snapshot and nothing reaches the engine, so what airs
   * does not change.
   */
  private recordReplayGap(event: PalazzoPlaybackEvent): void {
    this.options.metrics.recordEventIgnored('sequence-gap');
    const replayEvents = event.data?.replayEvents;
    this.logger.warn(
      `Palazzo replay gap on ${this.options.programId}: events between the last cursor and the snapshot were not replayed` +
        (Number.isSafeInteger(replayEvents)
          ? ` (replay window held ${String(replayEvents)} events)`
          : ''),
    );
  }

  private async reconcileGap(): Promise<void> {
    const state = await this.options.machineClient.getPlaybackState(
      this.options.palazzoUrl,
      this.options.programId,
      this.abort?.signal,
      this.lastStatus ?? undefined,
    );
    if (!this.validateInstanceId(state.instanceId)) return;
    if (state.intro && state.intro.programId !== this.options.programId) {
      this.options.metrics.recordEventIgnored('cross-program');
      throw new Error('cross-program Palazzo state');
    }
    this.rebaseCursor(state.bootId, state.sequence);
    this.lastSnapshotAt = Date.now();
    this.lastEventAt = Date.now();
    this.emitSnapshot(state);
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

  /** Keeps the last accepted status for a later unknown one, then forwards. */
  private emitSnapshot(state: PalazzoPlaybackState): void {
    this.lastStatus = state.status;
    this.setPlayout(state.liquidsoap.connected ? 'up' : 'down');
    this.options.callbacks.onSnapshot(this.options.programId, state);
  }

  private readonly recordUnknown = (field: PalazzoUnknownField): void => {
    this.options.metrics.recordUnknownValue(field);
  };

  private touch(event: Pick<PalazzoPlaybackEvent, 'occurredAt'>): void {
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
          this.setConnection(
            'unavailable',
            'sse and state endpoint unreachable',
          );
        }
        return;
      }
      if (!this.validateInstanceId(state.instanceId)) return;
      this.rebaseCursor(state.bootId, state.sequence);
      this.lastSnapshotAt = Date.now();
      this.lastEventAt = Date.now();
      if (this.isTransientConnection()) {
        this.setConnection(
          'polling',
          'sse unavailable; polling state endpoint',
        );
      }
      this.emitSnapshot(state);
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

  /**
   * Palazzo's current state on request (gaulatti/alcantara#230): Palazzo sends
   * a snapshot only when a stream connects, so a healthy connection never
   * reports an idle player by itself. The engine asks when it needs the
   * authoritative state. Null when this client is stopped, Palazzo is
   * unreachable, or the state belongs to another Palazzo instance or boot;
   * nothing is emitted and the stream's cursor is not touched.
   */
  async currentState(): Promise<PalazzoPlaybackState | null> {
    if (this.stopped) return null;
    const state = await this.fetchState();
    if (!state || state.instanceId !== this.instanceId) return null;
    if (this.currentBootId && state.bootId !== this.currentBootId) return null;
    this.lastStatus = state.status;
    return state;
  }

  private async fetchState(): Promise<PalazzoPlaybackState | null> {
    try {
      return await this.options.machineClient.getPlaybackState(
        this.options.palazzoUrl,
        this.options.programId,
        this.abort?.signal,
        this.lastStatus ?? undefined,
      );
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

  /** Playout up or down is reported, not acted on: the engine still follows `connection` alone. */
  private setPlayout(next: 'up' | 'down'): void {
    if (this.playout === next) return;
    this.playout = next;
    this.options.callbacks.onStatus(this.options.programId, this.getStatus());
  }

  private setConnection(
    state: PalazzoConnectionState,
    detail: string | null,
  ): void {
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
  for (const line of rawFrame.split(/\r?\n/)) {
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

function isLifecycleEvent(type: PalazzoPlaybackEvent['type']): boolean {
  return (
    type === 'track.started' ||
    type === 'track.ended' ||
    type === 'intro.started' ||
    type === 'intro.ended' ||
    type === 'intro.failed'
  );
}

function isEnginePlaybackEvent(type: PalazzoPlaybackEvent['type']): boolean {
  return (
    type === 'track.started' ||
    type === 'track.ended' ||
    type === 'intro.started' ||
    type === 'intro.ended' ||
    type === 'intro.failed' ||
    type === 'playout.next_withdrawn' ||
    type === 'instant.started' ||
    type === 'instant.ended' ||
    type === 'playback.position' ||
    type === 'audio.levels' ||
    type === 'playout.request_failed'
  );
}
