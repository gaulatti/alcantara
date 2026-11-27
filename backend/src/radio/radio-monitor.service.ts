import {
  BadGatewayException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { RadioService } from './radio.service';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';

// Native media may probe or reconnect to the same URL. Grants authenticate those
// requests without placing a login token in the media URL. Expiry is an idle
// deadline: 60 seconds to connect, then 30 seconds after the last disconnect.
const CONNECT_WINDOW_MS = 60_000;
const RECONNECT_WINDOW_MS = 30_000;
// Icecast opens each listener with a burst of buffered audio (about 16 s at Palazzo's burst size), so a reader that
// plays everything it receives stays that far behind. A return feed drops what arrives in its first 750 ms and
// starts close to live; the MP3 decoder resynchronizes on the next frame.
const BURST_SKIP_MS = 750;

/** Drops the stream's opening burst: everything received until BURST_SKIP_MS after the first chunk. */
export function skipOpeningBurst(now: () => number = Date.now): Transform {
  let firstChunkAt: number | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      firstChunkAt ??= now();
      done(null, now() - firstChunkAt < BURST_SKIP_MS ? undefined : chunk);
    },
  });
}
@Injectable()
export class RadioMonitorService {
  private readonly tickets = new Map<
    string,
    {
      programId: string;
      expiresAt: number;
      connections: number;
      skipBurst: boolean;
    }
  >();

  constructor(
    private readonly radio: RadioService,
    private readonly palazzo: PalazzoMachineClient,
    private readonly metrics: RadioMetricsService,
  ) {}

  async issue(
    programId: string,
    options: { skipBurst?: boolean } = {},
  ): Promise<{ streamPath: string; expiresInMs: number }> {
    const settings = await this.radio.getRadioSettings(programId);
    if (!settings)
      throw new BadGatewayException('Radio connection is unavailable');
    this.palazzo.validateBaseUrl(settings.palazzoUrl);
    for (const [ticket, grant] of this.tickets) {
      if (grant.connections === 0 && grant.expiresAt <= Date.now())
        this.tickets.delete(ticket);
    }
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      programId,
      expiresAt: Date.now() + CONNECT_WINDOW_MS,
      connections: 0,
      skipBurst: options.skipBurst === true,
    });
    return {
      streamPath: `/radio/${encodeURIComponent(programId)}/monitor-audio?ticket=${encodeURIComponent(ticket)}`,
      expiresInMs: CONNECT_WINDOW_MS,
    };
  }

  async open(
    programId: string,
    ticket: string,
    signal: AbortSignal,
  ): Promise<{ stream: Readable; type: string }> {
    const grant = this.tickets.get(ticket);
    if (
      !grant ||
      (grant.connections === 0 && grant.expiresAt <= Date.now()) ||
      grant.programId !== programId
    ) {
      this.tickets.delete(ticket);
      this.metrics.recordMonitor('rejected');
      throw new UnauthorizedException('Valid monitor ticket required');
    }
    grant.connections += 1;
    const release = () => {
      grant.connections -= 1;
      if (grant.connections === 0)
        grant.expiresAt = Date.now() + RECONNECT_WINDOW_MS;
    };
    try {
      const settings = await this.radio.getRadioSettings(programId);
      if (!settings)
        throw new BadGatewayException('Radio connection is unavailable');
      const response = await this.palazzo.openOutput(
        settings.palazzoUrl,
        programId,
        signal,
      );
      const source = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      const stream = grant.skipBurst
        ? source.pipe(skipOpeningBurst()).once('close', () => source.destroy())
        : source;
      if (grant.skipBurst)
        source.once('error', (error) => stream.destroy(error));
      this.metrics.recordMonitor('opened');
      let failed = false;
      stream.once('error', () => {
        failed = true;
      });
      stream.once('close', () => {
        release();
        this.metrics.recordMonitor(
          signal.aborted ? 'aborted' : failed ? 'failure' : 'closed',
        );
      });
      return { stream, type: response.headers.get('content-type')! };
    } catch {
      release();
      this.metrics.recordMonitor(signal.aborted ? 'aborted' : 'failure');
      throw new BadGatewayException('Program audio is unavailable');
    }
  }
}
