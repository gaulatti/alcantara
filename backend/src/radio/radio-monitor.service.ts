import {
  BadGatewayException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RadioService } from './radio.service';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';

/** One-use grants let native audio authenticate without exposing session tokens. */
@Injectable()
export class RadioMonitorService {
  private readonly tickets = new Map<
    string,
    { programId: string; expiresAt: number }
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
      if (grant.expiresAt <= Date.now()) this.tickets.delete(ticket);
    }
    const ticket = randomUUID();
    this.tickets.set(ticket, { programId, expiresAt: Date.now() + 15_000 });
    return {
      streamPath: `/radio/${encodeURIComponent(programId)}/monitor-audio?ticket=${encodeURIComponent(ticket)}`,
      expiresInMs: 15_000,
    };
  }

  async open(
    programId: string,
    ticket: string,
    signal: AbortSignal,
  ): Promise<{ stream: Readable; type: string }> {
    const grant = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.programId !== programId
    ) {
      this.metrics.recordMonitor('rejected');
      throw new UnauthorizedException('Valid monitor ticket required');
    }
    try {
      const settings = await this.radio.getRadioSettings(programId);
      if (!settings)
        throw new BadGatewayException('Radio connection is unavailable');
      const response = await this.palazzo.openOutput(
        settings.palazzoUrl,
        programId,
        signal,
      );
      const stream = Readable.fromWeb(response.body as any);
      this.metrics.recordMonitor('opened');
      let failed = false;
      stream.once('error', () => {
        failed = true;
      });
      stream.once('close', () =>
        this.metrics.recordMonitor(
          signal.aborted ? 'aborted' : failed ? 'failure' : 'closed',
        ),
      );
      return { stream, type: response.headers.get('content-type')! };
    } catch {
      this.metrics.recordMonitor(signal.aborted ? 'aborted' : 'failure');
      throw new BadGatewayException('Program audio is unavailable');
    }
  }
}
