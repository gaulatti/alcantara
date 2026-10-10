import {
  BadGatewayException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { RadioService } from './radio.service';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';

// Native media may probe or reconnect to the same URL. Grants authenticate those
// requests without placing a login token in the media URL. Expiry is an idle
// deadline: 60 seconds to connect, then 30 seconds after the last disconnect.
const CONNECT_WINDOW_MS = 60_000;
const RECONNECT_WINDOW_MS = 30_000;
@Injectable()
export class RadioMonitorService {
  private readonly tickets = new Map<
    string,
    { programId: string; expiresAt: number; connections: number }
  >();

  constructor(
    private readonly radio: RadioService,
    private readonly palazzo: PalazzoMachineClient,
    private readonly metrics: RadioMetricsService,
  ) {}

  async issue(
    programId: string,
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
      const stream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
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
