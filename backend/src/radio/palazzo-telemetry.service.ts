import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SongExecutionEngine } from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';
import {
  PalazzoProgramClient,
  type PalazzoInstanceValidation,
} from './palazzo-program.client';
import type {
  PalazzoProgramStatus,
  PalazzoProgramType,
} from './palazzo-contract';
import { PalazzoMachineClient } from './palazzo-machine.client';

const RADIO_PROGRAM_TYPES = ['radio', 'both'];

/**
 * Supervises one Palazzo telemetry client per enabled radio-capable program.
 *
 * Ownership rules:
 * - Only programs whose type is `radio` or `both` consume a Palazzo instance.
 * - Two radio-capable programs must never resolve to the same Palazzo
 *   instance identity; the second claimant is rejected with a conflict.
 * - A Palazzo instance that changes identity under a program is rejected as a
 *   mismatch, degrading only that program's radio leg.
 */
@Injectable()
export class PalazzoRadioTelemetryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PalazzoRadioTelemetryService.name);
  private readonly clients = new Map<string, PalazzoProgramClient>();
  private readonly statusByProgram = new Map<string, PalazzoProgramStatus>();
  private readonly ownerByInstance = new Map<string, string>();
  private readonly instanceByProgram = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => SongExecutionEngine))
    private readonly engine: SongExecutionEngine,
    private readonly metrics: RadioMetricsService,
    private readonly machineClient: PalazzoMachineClient,
  ) {}

  async onModuleInit(): Promise<void> {
    this.engine.setPalazzoTelemetry(this);
    await this.startAll();
  }

  onModuleDestroy(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
    this.ownerByInstance.clear();
    this.instanceByProgram.clear();
  }

  private async startAll(): Promise<void> {
    const settings = await this.prisma.radioSettings.findMany({
      where: { enabled: true },
      select: {
        palazzoUrl: true,
        programState: { select: { programId: true, type: true } },
      },
    });
    for (const setting of settings) {
      const programId = setting.programState.programId;
      const programType = setting.programState.type;
      if (!RADIO_PROGRAM_TYPES.includes(programType)) continue;
      if (!setting.palazzoUrl) continue;
      this.startClient(
        programId,
        programType as PalazzoProgramType,
        setting.palazzoUrl,
      );
    }
  }

  /** Called when radio settings change so URL/enablement is honored promptly. */
  async handleRadioSettingsChanged(programId: string): Promise<void> {
    this.stopClient(programId);
    const setting = await this.prisma.radioSettings.findFirst({
      where: {
        enabled: true,
        programState: { programId },
      },
      select: {
        palazzoUrl: true,
        programState: { select: { type: true } },
      },
    });
    if (!setting) return;
    if (!RADIO_PROGRAM_TYPES.includes(setting.programState.type)) return;
    if (!setting.palazzoUrl) return;
    this.startClient(
      programId,
      setting.programState.type as PalazzoProgramType,
      setting.palazzoUrl,
    );
  }

  isReconciled(programId: string): boolean {
    const client = this.clients.get(programId);
    if (!client) return false;
    const status = this.statusByProgram.get(programId);
    if (!status) return false;
    return (
      (status.connection === 'connected' || status.connection === 'polling') &&
      status.lastSnapshotAt !== null
    );
  }

  getStatus(programId: string): PalazzoProgramStatus | null {
    const client = this.clients.get(programId);
    return client ? client.getStatus() : null;
  }

  listStatuses(): PalazzoProgramStatus[] {
    return [...this.clients.values()].map((client) => client.getStatus());
  }

  private startClient(
    programId: string,
    programType: PalazzoProgramType,
    palazzoUrl: string,
  ): void {
    if (this.clients.has(programId)) return;
    let approvedUrl: string;
    try {
      approvedUrl = this.machineClient.validateBaseUrl(palazzoUrl);
    } catch {
      this.logger.error(`Palazzo URL configuration rejected for ${programId}`);
      return;
    }
    this.engine.registerRadioProgram(programId);
    const client = new PalazzoProgramClient({
      programId,
      programType,
      palazzoUrl: approvedUrl,
      metrics: this.metrics,
      machineClient: this.machineClient,
      callbacks: {
        onSnapshot: (pid, state) =>
          this.engine.handlePalazzoSnapshot(pid, state),
        onEvent: (pid, event) =>
          this.engine.handlePalazzoEvent(pid, event as never),
        onStatus: (pid, status) => this.handleStatus(pid, status),
        validateInstance: (pid, instanceId) =>
          this.validateInstance(pid, instanceId),
      },
    });
    this.clients.set(programId, client);
    this.logger.log(
      `Consuming authenticated Palazzo telemetry for ${programId} (${programType})`,
    );
    client.start();
  }

  private stopClient(programId: string): void {
    const client = this.clients.get(programId);
    if (!client) return;
    client.stop();
    this.clients.delete(programId);
    this.statusByProgram.delete(programId);
    const instanceId = this.instanceByProgram.get(programId);
    if (instanceId && this.ownerByInstance.get(instanceId) === programId) {
      this.ownerByInstance.delete(instanceId);
    }
    this.instanceByProgram.delete(programId);
    this.refreshAggregateMetrics();
  }

  private validateInstance(
    programId: string,
    instanceId: string,
  ): PalazzoInstanceValidation {
    const owner = this.ownerByInstance.get(instanceId);
    if (owner && owner !== programId) {
      this.logger.error(
        `Palazzo instance ${instanceId} is already owned by ${owner}; rejecting ${programId}`,
      );
      return 'conflict';
    }
    const known = this.instanceByProgram.get(programId);
    if (known && known !== instanceId) {
      this.logger.error(
        `Program ${programId} expected Palazzo instance ${known} but found ${instanceId}`,
      );
      return 'mismatch';
    }
    this.ownerByInstance.set(instanceId, programId);
    this.instanceByProgram.set(programId, instanceId);
    return 'ok';
  }

  private handleStatus(programId: string, status: PalazzoProgramStatus): void {
    this.statusByProgram.set(programId, status);
    this.engine.handlePalazzoStatus(programId, status);
    this.refreshAggregateMetrics();
  }

  private refreshAggregateMetrics(): void {
    const statuses = this.listStatuses();
    const degraded = statuses.filter((status) => status.degraded).length;
    this.metrics.recordDegradedPrograms(degraded);
    const stale = statuses.filter(
      (status) =>
        status.lastEventAt !== null &&
        Date.now() - Date.parse(status.lastEventAt) > 15_000,
    ).length;
    this.metrics.recordStaleTelemetryPrograms(stale);
  }
}
