import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { RadioMonitorService } from '../radio/radio-monitor.service';
import { WebrtcService } from './webrtc.service';

/** How long a program keeps its return router after its last admitted guest leaves. */
export const RETURN_ROUTER_LINGER_MS = 60_000;
/** The runner polls every few seconds; one LiveKit pass serves every poll inside this window. */
const WANTED_CACHE_MS = 2_000;
const MAX_RUNNING_REPORTED = 64;
/** The return runner counts as polling while its last poll here is this recent (alcantara#877). */
export const RETURN_RUNNER_FRESH_MS = 15_000;

export type ChainState = 'ok' | 'down' | 'unknown';

/**
 * Decides which programs need a server-run return router (the runner on Helix pulls this list and opens one
 * `/return-router/<programId>` page per program), and issues the program-audio grant the router mixes in when no
 * program feed is in the room. A program needs a router while an admitted guest is in its room, and for
 * RETURN_ROUTER_LINGER_MS after the last one leaves, so a guest who reconnects finds their return still there.
 */
@Injectable()
export class ReturnRouterService {
  private readonly lastGuestSeen = new Map<string, number>();
  private cached: { at: number; programs: string[] } | null = null;
  private pending: Promise<string[]> | null = null;
  /** The last authorised poll from the return runner on this instance; null until the first. */
  private lastRunnerPollAt: number | null = null;

  constructor(
    private readonly webrtc: WebrtcService,
    private readonly monitor: RadioMonitorService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  /** The clock; tests replace it. */
  now: () => number = Date.now;

  async wantedRouters(
    rendererKey: string | undefined,
    runningValue: unknown,
  ): Promise<{ programs: string[] }> {
    try {
      this.webrtc.authorizeFleet(rendererKey);
    } catch (error) {
      this.metrics.recordReturnRouterPoll(
        error instanceof UnauthorizedException ? 'rejected' : 'failure',
      );
      throw error;
    }
    // The runner is polling, whatever this answer turns out to be.
    this.lastRunnerPollAt = this.now();
    try {
      const programs = await this.currentPrograms();
      this.metrics.recordReturnRouterPoll('ok');
      this.metrics.setReturnRouters(
        programs.length,
        this.runningCount(runningValue),
      );
      return { programs };
    } catch (error) {
      this.metrics.recordReturnRouterPoll('failure');
      throw error;
    }
  }

  /**
   * The call chain's health for a program's desk (alcantara#877): the return runner polling its work list, the
   * program's contribution worker holding its on-air stream, and LiveKit answering.
   */
  async health(programIdValue: unknown): Promise<{
    programId: string;
    returnRunner: ChainState;
    contribution: ChainState;
    livekit: 'ok' | 'down';
    checkedAt: string;
  }> {
    const programId = this.webrtc.normalizeRendererProgramId(programIdValue);
    const now = this.now();
    const livekit = await this.webrtc.livekitHealth(now);
    const returnRunner: ChainState =
      this.lastRunnerPollAt === null
        ? 'unknown'
        : now - this.lastRunnerPollAt <= RETURN_RUNNER_FRESH_MS
          ? 'ok'
          : 'down';
    this.metrics.setChainOk('return_runner', returnRunner === 'ok');
    this.metrics.setChainOk('livekit', livekit === 'ok');
    return {
      programId,
      returnRunner,
      contribution: this.webrtc.contributionHealth(programId),
      livekit,
      checkedAt: new Date(now).toISOString(),
    };
  }

  async audioTicket(rendererKey: string | undefined, programIdValue: unknown) {
    let programId: string;
    try {
      programId = await this.webrtc.authorizeFor(
        'return_audio_ticket',
        rendererKey,
        programIdValue,
      );
    } catch (error) {
      // A credential refusal is counted; an invalid program id is refused as before, uncounted.
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      )
        this.metrics.recordReturnAudioTicket('rejected');
      throw error;
    }
    try {
      const grant = await this.monitor.issue(programId, { skipBurst: true });
      this.metrics.recordReturnAudioTicket('issued');
      return grant;
    } catch (error) {
      // A program without a radio connection has no program audio to offer: the router keeps to the program feed.
      this.metrics.recordReturnAudioTicket('unavailable');
      throw error;
    }
  }

  private async currentPrograms(): Promise<string[]> {
    const now = this.now();
    if (this.cached && now - this.cached.at < WANTED_CACHE_MS)
      return this.cached.programs;
    this.pending ??= this.webrtc.programsWithAdmittedGuests().finally(() => {
      this.pending = null;
    });
    const present = await this.pending;
    const at = this.now();
    for (const programId of present) this.lastGuestSeen.set(programId, at);
    for (const [programId, seen] of this.lastGuestSeen) {
      if (at - seen > RETURN_ROUTER_LINGER_MS)
        this.lastGuestSeen.delete(programId);
    }
    const programs = [...this.lastGuestSeen.keys()].sort();
    this.cached = { at, programs };
    return programs;
  }

  /** How many routers the runner reports open (`?running=a,b`), capped so a bad query cannot inflate the gauge. */
  private runningCount(value: unknown): number {
    if (typeof value !== 'string') return 0;
    const running = new Set(value.split(',').filter(Boolean));
    return Math.min(running.size, MAX_RUNNING_REPORTED);
  }
}
