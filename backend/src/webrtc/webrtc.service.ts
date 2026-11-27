import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
  Optional,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GuestCommand, GuestInvitation, Prisma } from '@prisma/client';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
} from 'livekit-server-sdk';
import { Observable, Subject, filter } from 'rxjs';
import type { CanonicalIdentity } from '../identity/principals';
import { PrismaService } from '../prisma.service';
import {
  type GuestCue,
  ManagedMetricsService,
  WEBRTC_ICE_PATHS,
  WEBRTC_JOIN_RESULTS,
  type WebrtcIcePath,
  type WebrtcJoinResult,
  type RendererAuthEndpoint,
} from '../observability/managed-metrics.service';
import { validProgramId } from '../program/program-id';
import { RendererAuthService } from '../renderer-keys/renderer-auth.service';

type ReturnVideo = 'program' | 'preview' | 'none';
type ReturnAudioBus = 'master' | 'monitor' | `aux-${number}`;
type CommandStatus = 'accepted' | 'rejected' | 'read' | 'acknowledged';

const MAX_GUESTS = 6;
/**
 * The program room's participant cap, set when the room is created. Six guest slots (MAX_GUESTS, enforced by the
 * invitations), plus the return router and the contribution worker (each takes a slot), plus operators and the pre-fade
 * listeners. Eight was too few: six guests with the router and worker filled it before any operator joined.
 */
const PROGRAM_ROOM_MAX_PARTICIPANTS = 24;
const SESSION_LEASE_MS = 60_000;
/**
 * How long after its lease ran out an admitted session still comes back without being admitted again: a phone that
 * slept or sat in another app. Later than this, the same browser is screened like anyone else.
 */
export const REJOIN_WINDOW_MS = 5 * 60_000;
const LOST_CALL_SWEEP_MS = 30_000;
/** The call-chain health's LiveKit check (alcantara#877): its bound, and how long one result is reused. */
export const LIVEKIT_HEALTH_TIMEOUT_MS = 2_000;
export const LIVEKIT_HEALTH_CACHE_MS = 5_000;
/** The on-air stream sends the current list at least this often, so its reader can tell a live stream from a stuck one. */
export const ON_AIR_REFRESH_MS = 5_000;
// Only long enough to connect: the guest page asks /webrtc/join again for every join, and once connected LiveKit
// refreshes the token itself (exp is checked only at connect), so a token a guest holds stops opening a room soon.
const JOIN_TOKEN_TTL = '60s';
// How far back a closed invitation's guest is still looked for in its program room by the admission check.
const ADMISSION_LOOKBACK_MS = 15 * 60_000;
/** What a guest's browser may report; the API counts success and an expired invitation itself. */
const GUEST_FAILURES: readonly WebrtcJoinResult[] = [
  'permission_denied',
  'no_device',
  'ice_failed',
  'token_rejected',
  'other',
];

// The guest's own report of the studio's return (the telemetry field returnFeedHealth): healthy while playing,
// stalled when it has been missing for the stall time, missing otherwise.
function returnReachingFrom(
  value: unknown,
): 'healthy' | 'stalled' | 'missing' | null {
  return value === 'healthy' || value === 'stalled' || value === 'missing'
    ? value
    : null;
}

function icePathFrom(value: unknown): WebrtcIcePath | null {
  return WEBRTC_ICE_PATHS.find((path) => path === value) ?? null;
}

export interface StoredCue {
  cue: string;
  cueSessionId: string | null;
  admittedAt: Date | null;
  activeSessionId: string | null;
}

/**
 * The cue that holds for a guest's session, from the stored state. "live" only when it reaches air: cued live,
 * admitted, and the cue was given to the session the guest is on. A stored live that does not is "standby".
 */
export function guestCueState(
  invitation: StoredCue,
  sessionId: string | null = invitation.activeSessionId,
): 'live' | 'standby' | 'wrap' {
  if (invitation.cue === 'wrap') return 'wrap';
  return invitation.cue === 'live' &&
    invitation.admittedAt !== null &&
    sessionId !== null &&
    invitation.activeSessionId === sessionId &&
    invitation.cueSessionId === sessionId
    ? 'live'
    : 'standby';
}

/**
 * The stored cue for a guest who comes back off air. A live cue becomes "rejoined", which tells the desk it no longer
 * holds; nothing reads it as live. Standby and wrap are kept as given: neither reaches air.
 */
function offAirAgain(before: { cue?: string; cueSessionId?: string | null }) {
  if (before.cue === 'live' || before.cue === 'rejoined')
    return { cue: 'rejoined', cueSessionId: null };
  return {
    cue: before.cue === 'wrap' ? 'wrap' : 'standby',
    cueSessionId: before.cueSessionId ?? null,
  };
}

/**
 * The one identity the host's microphone has in a program's room (gaulatti/alcantara#879). It starts with `operator-`
 * as every operator connection does, so readers that predate it still treat it as the operator's.
 */
export function hostMicIdentity(programId: string): string {
  return `operator-host-mic-${programId}`;
}

@Injectable()
export class WebrtcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebrtcService.name);
  private lostCallSweep: ReturnType<typeof setInterval> | null = null;
  /** A program whose on-air list may have changed: a cue, an admission, a new session, a removal or a revoke. */
  private readonly onAirChanges = new Subject<string>();
  private readonly onAirClosing = new Subject<void>();
  /** Open on-air streams per program, and the programs that have had one on this instance (alcantara#877). */
  private readonly onAirStreamsOpen = new Map<string, number>();
  private readonly onAirStreamsSeen = new Set<string>();
  private livekitCheck: { at: number; state: Promise<'ok' | 'down'> } | null =
    null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
    @Optional() private readonly lease?: PlayoutLease,
    /** The per-program renderer credential (gaulatti/alcantara#884). The app always provides it (webrtc.module.ts). */
    @Optional() private readonly rendererAuth?: RendererAuthService,
  ) {}

  onModuleInit() {
    // Only the instance holding the playout lease (alcantara#873) sweeps: the sweeps write and remove participants.
    startWhenActive(this.lease, () => {
      this.lostCallSweep = setInterval(() => {
        // A database that is away is retried at the next sweep.
        void this.countLostCalls().catch(() => undefined);
        void this.enforceProgramRoomAdmission().catch(() => undefined);
      }, LOST_CALL_SWEEP_MS);
      this.lostCallSweep.unref();
    });
  }

  onModuleDestroy() {
    if (this.lostCallSweep) clearInterval(this.lostCallSweep);
    this.lostCallSweep = null;
    // Shutting down (alcantara#873): end every on-air stream, so the server can close and the workers reconnect to
    // the instance that takes over (they poll meanwhile).
    this.onAirClosing.next();
    this.onAirClosing.complete();
  }

  /**
   * Counts live calls whose heartbeat stopped without a leave: a guest who dropped and never came back. Clearing
   * `liveSince` in the same statement counts each once, whoever else is sweeping.
   */
  async countLostCalls() {
    const { count } = await this.prisma.guestInvitation.updateMany({
      where: {
        liveSince: { not: null },
        activeSessionUntil: { lt: new Date() },
      },
      data: { liveSince: null },
    });
    this.metrics.recordWebrtcDrops(count);
  }

  /**
   * Keeps each program room to guests with an open, admitted session. Removing a guest disconnects them at once, but
   * LiveKit keeps honouring a token the guest already holds (it refreshes tokens for up to 10 minutes and has no
   * revocation on a self-hosted server), so a guest in a program room whose invitation is revoked, expired, not
   * admitted, or has no session is removed again. A lapsed lease is not a reason: during a backend restart heartbeats
   * stop while the call itself is fine.
   */
  async enforceProgramRoomAdmission() {
    if (!this.hasConfiguration()) return;
    const now = new Date();
    const since = new Date(now.getTime() - ADMISSION_LOOKBACK_MS);
    const programs = await this.prisma.guestInvitation.findMany({
      where: {
        OR: [{ expiresAt: { gt: since } }, { revokedAt: { gt: since } }],
      },
      select: { programId: true },
      distinct: ['programId'],
    });
    for (const { programId } of programs) {
      const roomName = this.roomName(programId);
      let present: Array<{ identity: string }> = [];
      try {
        present = await this.roomService.listParticipants(roomName);
      } catch {
        // A missing room has nobody in it; LiveKit away is retried at the next sweep.
        continue;
      }
      const guests = present
        .map((participant) => participant.identity)
        .filter((identity) => /^guest-[0-9a-f-]{36}$/.test(identity));
      if (!guests.length) continue;
      const rows = await this.prisma.guestInvitation.findMany({
        where: { id: { in: guests.map((identity) => identity.slice(6)) } },
        select: {
          id: true,
          programId: true,
          revokedAt: true,
          expiresAt: true,
          admittedAt: true,
          activeSessionId: true,
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const identity of guests) {
        const row = byId.get(identity.slice(6));
        const allowed =
          row &&
          row.programId === programId &&
          !row.revokedAt &&
          row.expiresAt > now &&
          row.admittedAt &&
          row.activeSessionId;
        if (allowed) continue;
        try {
          await this.disconnectIfPresent(roomName, identity);
          this.metrics.recordWebrtcRoomAdmissionRemoval();
        } catch {
          // LiveKit away: the next sweep tries again; the other guests are still checked.
        }
      }
    }
  }

  getPublicConfig() {
    return { enabled: this.hasConfiguration(), maxGuests: MAX_GUESTS };
  }

  async listInvitations() {
    const now = new Date();
    const invitations = await this.prisma.guestInvitation.findMany({
      orderBy: [
        { programId: 'asc' },
        { slotNumber: 'asc' },
        { createdAt: 'desc' },
      ],
      include: { commands: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    return invitations.map((invitation) =>
      this.presentInvitation(invitation, now),
    );
  }

  async createInvitation(
    operator: CanonicalIdentity,
    body: Record<string, unknown>,
  ) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(body.programId);
    const displayName = this.normalizeDisplayName(body.displayName);
    const expiresInHours = this.normalizeExpiration(body.expiresInHours);
    const slotNumber = await this.resolveSlot(programId, body.slotNumber);
    const returnVideo = this.normalizeReturnVideo(body.returnVideo);
    const returnAudioBus = this.normalizeReturnAudioBus(body.returnAudioBus);
    const sourceGain = this.normalizeSourceGain(body.sourceGain);
    const sourceMuted = this.normalizeSourceMuted(body.sourceMuted);
    const sourceDelayMs = this.normalizeSourceDelay(body.sourceDelayMs);
    const secret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const invitationToken = `${id}.${secret}`;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    await this.ensureRoom(programId);
    const invitation = await this.prisma.guestInvitation.create({
      data: {
        id,
        tokenHash: this.hash(invitationToken),
        programId,
        displayName,
        slotNumber,
        returnVideo,
        returnAudioBus,
        sourceGain,
        sourceMuted,
        sourceDelayMs,
        expiresAt,
        createdByIdentity: operator.subject,
        createdByPrincipalId: operator.principalId,
        events: {
          create: {
            type: 'created',
            details: {
              ...this.operatorAudit(operator),
              expiresInHours,
              slotNumber,
            },
          },
        },
      },
    });
    return {
      ...this.presentInvitation(invitation, new Date()),
      invitation: invitationToken,
      invitationPath: `/guest/${encodeURIComponent(invitationToken)}`,
    };
  }

  async replaceInvitation(operator: CanonicalIdentity, id: string) {
    const existing = await this.requireInvitation(id);
    await this.revokeInvitation(operator, id);
    return this.createInvitation(operator, {
      programId: existing.programId,
      displayName: existing.displayName,
      expiresInHours: Math.max(
        1,
        Math.ceil((existing.expiresAt.getTime() - Date.now()) / 3_600_000),
      ),
      slotNumber: existing.slotNumber,
      returnVideo: existing.returnVideo,
      returnAudioBus: existing.returnAudioBus,
      sourceGain: existing.sourceGain,
      sourceMuted: existing.sourceMuted,
      sourceDelayMs: existing.sourceDelayMs,
    });
  }

  async revokeInvitation(operator: CanonicalIdentity, id: string) {
    const invitation = await this.requireInvitation(id);
    if (!invitation.revokedAt) {
      await this.prisma.guestInvitation.update({
        where: { id },
        data: {
          revokedAt: new Date(),
          slotNumber: null,
          activeSessionId: null,
          activeSessionUntil: null,
          liveSince: null,
          events: {
            create: {
              type: 'revoked',
              details: this.operatorAudit(operator),
            },
          },
        },
      });
      this.onAirChanges.next(invitation.programId);
    }
    await this.disconnectIfPresent(
      this.roomName(invitation.programId),
      this.guestIdentity(id),
    );
    await this.disconnectIfPresent(
      this.screeningRoomName(id),
      this.guestIdentity(id),
    );
    return { id, status: 'revoked' };
  }

  /** Lets a waiting guest onto their strip: their page then joins the program's room. */
  async admitGuest(operator: CanonicalIdentity, id: string) {
    const invitation = await this.requireInvitation(id);
    if (invitation.revokedAt || invitation.expiresAt <= new Date())
      throw new ConflictException('This invitation is closed.');
    await this.prisma.guestInvitation.update({
      where: { id },
      data: {
        admittedAt: new Date(),
        events: {
          create: { type: 'admitted', details: this.operatorAudit(operator) },
        },
      },
    });
    this.onAirChanges.next(invitation.programId);
    // Ends the screening connection, which tells the page at once that something changed.
    await this.disconnectIfPresent(
      this.screeningRoomName(id),
      this.guestIdentity(id),
    );
    return { id, status: 'admitted' };
  }

  /** Turns a guest away: the invitation closes as a revoked one does, so its slot is free and the link opens nothing. */
  async declineGuest(operator: CanonicalIdentity, id: string) {
    const invitation = await this.requireInvitation(id);
    await this.prisma.guestInvitation.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        slotNumber: null,
        admittedAt: null,
        activeSessionId: null,
        activeSessionUntil: null,
        liveSince: null,
        events: {
          create: { type: 'declined', details: this.operatorAudit(operator) },
        },
      },
    });
    this.onAirChanges.next(invitation.programId);
    await this.disconnectIfPresent(
      this.screeningRoomName(id),
      this.guestIdentity(id),
    );
    await this.disconnectIfPresent(
      this.roomName(invitation.programId),
      this.guestIdentity(id),
    );
    return { id, status: 'declined' };
  }

  /** The operator's token for one waiting guest's screening room, to see, hear and talk to them off air. */
  async createScreeningToken(operator: CanonicalIdentity, id: string) {
    this.requireConfiguration();
    const invitation = await this.requireInvitation(id);
    const roomName = this.screeningRoomName(invitation.id);
    await this.ensureScreeningRoom(roomName);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `operator-${createHash('sha256')
        .update(operator.principalId ?? operator.subject)
        .digest('hex')
        .slice(0, 20)}-${randomUUID()}`,
      name: 'Alcantara producer',
      ttl: '5m',
      metadata: JSON.stringify({ role: 'operator' }),
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      // Visible: LiveKit does not hand a hidden participant's microphone to anyone, so the guest heard nothing.
      hidden: false,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName,
      participantIdentity: this.guestIdentity(invitation.id),
    };
  }

  async updateReturn(
    operator: CanonicalIdentity,
    id: string,
    body: Record<string, unknown>,
  ) {
    await this.requireInvitation(id);
    const returnVideo = this.normalizeReturnVideo(body.returnVideo);
    const returnAudioBus = this.normalizeReturnAudioBus(body.returnAudioBus);
    const sourceGain = this.normalizeSourceGain(body.sourceGain);
    const sourceMuted = this.normalizeSourceMuted(body.sourceMuted);
    const sourceDelayMs = this.normalizeSourceDelay(body.sourceDelayMs);
    const updated = await this.prisma.guestInvitation.update({
      where: { id },
      data: {
        returnVideo,
        returnAudioBus,
        sourceGain,
        sourceMuted,
        sourceDelayMs,
        events: {
          create: {
            type: 'return_changed',
            details: {
              ...this.operatorAudit(operator),
              returnVideo,
              returnAudioBus,
              sourceGain,
              sourceMuted,
              sourceDelayMs,
            },
          },
        },
      },
    });
    await this.sendGuestData(updated, {
      version: 1,
      id: randomUUID(),
      type: 'return',
      returnVideo,
      returnAudioBus,
      sourceGain,
      sourceMuted,
      sourceDelayMs,
    });
    return this.presentInvitation(updated, new Date());
  }

  async redeemInvitation(invitationValue: unknown, sessionTokenValue: unknown) {
    this.requireConfiguration();
    const invitationToken = this.requireString(invitationValue, 'Invitation');
    const invitation = await this.verifyInvitationToken(invitationToken).catch(
      (error: unknown) => {
        if (error instanceof UnauthorizedException)
          this.metrics.recordWebrtcJoin('guest', 'token_rejected');
        throw error;
      },
    );
    const now = new Date();
    this.requireOpenInvitation(invitation, now);

    let sessionId: string | null = null;
    if (typeof sessionTokenValue === 'string' && sessionTokenValue) {
      sessionId = this.verifySessionToken(sessionTokenValue, invitation.id);
    }
    if (!sessionId) sessionId = randomUUID();

    const open = { id: invitation.id, revokedAt: null, expiresAt: { gt: now } };
    const lease = {
      activeSessionId: sessionId,
      activeSessionUntil: new Date(now.getTime() + SESSION_LEASE_MS),
    };
    // Screening applies to each new session: the session that was admitted keeps its admission when it reconnects
    // while its lease is live, or within REJOIN_WINDOW_MS of it running out; any other session, and that one later
    // than that, starts waiting again, cleared in the same write that claims the invitation. The server decides this:
    // the page only presents its session token.
    const reconnected = await this.prisma.guestInvitation.updateMany({
      where: {
        ...open,
        activeSessionId: sessionId,
        activeSessionUntil: { gte: now },
      },
      data: lease,
    });
    // A session whose lease ran out was away: it keeps its admission but comes back off air until cued again.
    const returned =
      reconnected.count === 1
        ? null
        : await this.prisma.guestInvitation.updateMany({
            where: {
              ...open,
              activeSessionId: sessionId,
              activeSessionUntil: {
                gte: new Date(now.getTime() - REJOIN_WINDOW_MS),
              },
            },
            data: { ...lease, ...offAirAgain(invitation) },
          });
    const sameSession = reconnected.count === 1 || returned?.count === 1;
    const newSession = sameSession
      ? null
      : await this.prisma.guestInvitation.updateMany({
          where: {
            ...open,
            OR: [
              { activeSessionId: null },
              { activeSessionUntil: { lt: now } },
            ],
          },
          data: {
            ...lease,
            admittedAt: null,
            ...offAirAgain(invitation),
          },
        });
    if (!sameSession && newSession?.count !== 1) {
      this.metrics.recordWebrtcJoin('guest', 'other');
      throw new ConflictException(
        'This invitation is already active in another session.',
      );
    }
    // A new session, or one back from being away, is off air until cued again.
    if (newSession?.count === 1 || returned?.count === 1)
      this.onAirChanges.next(invitation.programId);

    const identity = this.guestIdentity(invitation.id);
    const admitted = sameSession && Boolean(invitation.admittedAt);
    // Until admitted, the guest's token opens only a room of their own: nothing of theirs can reach a strip, a return
    // or air, and the program's consumers need no change.
    const roomName = admitted
      ? this.roomName(invitation.programId)
      : this.screeningRoomName(invitation.id);
    if (!admitted) await this.ensureScreeningRoom(roomName);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name: invitation.displayName,
      ttl: JOIN_TOKEN_TTL,
      metadata: JSON.stringify({
        role: 'guest',
        invitationId: invitation.id,
        slotNumber: invitation.slotNumber,
      }),
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      // A waiting guest subscribes to hear the producer.
      canSubscribe:
        !admitted ||
        invitation.returnVideo !== 'none' ||
        Boolean(invitation.returnAudioBus),
      canPublishData: admitted,
    });
    await this.prisma.guestEvent.create({
      data: { invitationId: invitation.id, type: 'token_issued' },
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      sessionToken: this.signSessionToken(invitation.id, sessionId),
      roomName,
      admission: admitted ? 'admitted' : 'waiting',
      participantIdentity: identity,
      displayName: invitation.displayName,
      programId: invitation.programId,
      slotNumber: invitation.slotNumber,
      returnVideo: invitation.returnVideo,
      returnAudioBus: invitation.returnAudioBus,
      sourceGain: invitation.sourceGain,
      sourceMuted: invitation.sourceMuted,
      sourceDelayMs: invitation.sourceDelayMs,
      reconnectWindowSeconds: SESSION_LEASE_MS / 1000,
      // The guest's cue as the claim left it. A new session, or one back after a lapse, was cleared by the claim, so it
      // is standby; only a reconnect keeps its cue, judged against this session.
      cue:
        sameSession && reconnected.count === 1
          ? guestCueState(
              { ...invitation, activeSessionId: sessionId },
              sessionId,
            )
          : 'standby',
    };
  }

  /**
   * A join the guest's browser saw fail, often before it asked to join (camera refused, no microphone). It needs the
   * invitation's own token, so only an invited guest can add to the counts.
   */
  async reportJoinFailure(invitationValue: unknown, reasonValue: unknown) {
    this.requireConfiguration();
    const invitation = await this.verifyInvitationToken(
      this.requireString(invitationValue, 'Invitation'),
    );
    const reason = GUEST_FAILURES.find((known) => known === reasonValue);
    if (!reason) throw new BadRequestException('Unknown failure reason.');
    this.requireOpenInvitation(invitation, new Date());
    await this.prisma.guestEvent.create({
      data: {
        invitationId: invitation.id,
        type: 'join_failed',
        details: { reason },
      },
    });
    this.metrics.recordWebrtcJoin('guest', reason);
    return { recorded: true };
  }

  /** The operator's own talkback connection: counted, not stored. */
  reportOperatorCall(resultValue: unknown, icePathValue: unknown) {
    const result = WEBRTC_JOIN_RESULTS.find((known) => known === resultValue);
    if (!result) throw new BadRequestException('Unknown call result.');
    this.metrics.recordWebrtcJoin('operator', result);
    const path = icePathFrom(icePathValue);
    if (result === 'success' && path)
      this.metrics.recordWebrtcIcePath('operator', path);
    return { recorded: true };
  }

  async heartbeat(sessionTokenValue: unknown, telemetryValue: unknown) {
    const session = await this.requireActiveSession(sessionTokenValue);
    const telemetry = this.normalizeTelemetry(telemetryValue);
    // What the guest says about the call's life, apart from the telemetry stored for the desk.
    const reported = telemetryValue as {
      joined?: unknown;
      iceTransport?: unknown;
      dropped?: unknown;
      left?: unknown;
    } | null;
    // Sent until a heartbeat gets through, which may be after the guest's network returns. Counted only while the
    // call is still marked live, so a drop the sweep already counted is not counted again.
    if (reported?.dropped === true) {
      const { count } = await this.prisma.guestInvitation.updateMany({
        where: { id: session.invitation.id, liveSince: { not: null } },
        data: { liveSince: null },
      });
      this.metrics.recordWebrtcDrops(count);
    }
    const activeSessionUntil = new Date(Date.now() + SESSION_LEASE_MS);
    await this.prisma.guestInvitation.update({
      where: { id: session.invitation.id },
      data: {
        activeSessionUntil,
        ...(reported?.joined === true ? { liveSince: new Date() } : {}),
        ...(reported?.left === true ? { liveSince: null } : {}),
        ...(telemetry
          ? { events: { create: { type: 'telemetry', details: telemetry } } }
          : {}),
      },
    });
    // The guest marks the first heartbeat of a connection, so one join is counted once.
    if (reported?.joined === true) {
      this.metrics.recordWebrtcJoin('guest', 'success');
      const path = icePathFrom(reported.iceTransport);
      if (path) this.metrics.recordWebrtcIcePath('guest', path);
    }
    return {
      activeSessionUntil: activeSessionUntil.toISOString(),
      admission: session.invitation.admittedAt ? 'admitted' : 'waiting',
      // The guest's own cue for this session only, from the invitation the verified token resolved.
      cue: guestCueState(session.invitation, session.sessionId),
    };
  }

  async acknowledgeCommand(
    sessionTokenValue: unknown,
    commandId: string,
    statusValue: unknown,
  ) {
    const session = await this.requireActiveSession(sessionTokenValue);
    const status = this.normalizeCommandStatus(statusValue);
    const command = await this.prisma.guestCommand.findFirst({
      where: { id: commandId, invitationId: session.invitation.id },
    });
    if (!command) throw new NotFoundException('Command not found.');
    const acknowledgedAt = new Date();
    return this.prisma.guestCommand.update({
      where: { id: commandId },
      data: { status, acknowledgedAt },
    });
  }

  async listParticipants(programIdValue: unknown) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const invitations = await this.prisma.guestInvitation.findMany({
      where: { programId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: {
        commands: { orderBy: { createdAt: 'desc' }, take: 10 },
        // Whether the guest's call ever reported from the room: a guest whose lease ran out after a call dropped, not
        // one who never arrived (the lease alone cannot tell them apart).
        _count: { select: { events: { where: { type: 'telemetry' } } } },
        // The latest report on the call decides what the row shows.
        events: {
          where: { type: { in: ['telemetry', 'join_failed'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { slotNumber: 'asc' },
    });
    let participants: Awaited<
      ReturnType<RoomServiceClient['listParticipants']>
    > = [];
    try {
      participants = await this.roomService.listParticipants(
        this.roomName(programId),
      );
    } catch (error) {
      if (!this.isRoomMissing(error)) throw this.livekitUnavailable(error);
    }
    const liveByIdentity = new Map(
      participants.map((participant) => [participant.identity, participant]),
    );
    // The return to guests is sent by a return router: the runner's page, return-router-<programId>, or a page an
    // operator opened by hand, renderer-<programId>-<uuid>. Either sends it while it publishes mix-minus tracks
    // (named mixminus:<guest>:<bus>).
    const sendingRouter = participants.find(
      (participant) =>
        (participant.identity === `return-router-${programId}` ||
          participant.identity.startsWith(`renderer-${programId}-`)) &&
        participant.tracks.some((track) => track.name.startsWith('mixminus:')),
    );
    return {
      roomName: this.roomName(programId),
      room: {
        returnSending: Boolean(sendingRouter),
        returnParticipant: sendingRouter?.identity ?? null,
      },
      participants: invitations.map((invitation) => {
        const identity = this.guestIdentity(invitation.id);
        const participant = liveByIdentity.get(identity);
        return {
          invitationId: invitation.id,
          identity,
          name: invitation.displayName,
          slotNumber: invitation.slotNumber,
          connectionState: participant
            ? 'connected'
            : invitation.activeSessionUntil &&
                invitation.activeSessionUntil > new Date()
              ? 'reconnecting'
              : 'offline',
          reconnectUntil: invitation.activeSessionUntil?.toISOString() ?? null,
          returnVideo: invitation.returnVideo,
          returnAudioBus: invitation.returnAudioBus,
          sourceGain: invitation.sourceGain,
          sourceMuted: invitation.sourceMuted,
          sourceDelayMs: invitation.sourceDelayMs,
          tracks:
            participant?.tracks.map((track) => ({
              sid: track.sid,
              source: TrackSource[track.source].toLowerCase(),
              muted: track.muted,
              width: track.width,
              height: track.height,
              mimeType: track.mimeType,
            })) ?? [],
          commands: invitation.commands,
          // The cue that holds now, from the same stored state the on-air list reads. The command history above can
          // still end in "live" for a guest who rejoined and is off air.
          cueState: this.deskCueState(invitation),
          // Joined and not yet admitted: waiting in their screening room.
          screening: Boolean(
            !invitation.admittedAt &&
            invitation.activeSessionUntil &&
            invitation.activeSessionUntil > new Date(),
          ),
          everJoined: invitation._count.events > 0,
          ...this.reportedCall(invitation.events[0]),
        };
      }),
    };
  }

  async controlParticipant(
    programIdValue: unknown,
    identityValue: unknown,
    body: Record<string, unknown>,
  ) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const identity = this.normalizeGuestIdentity(identityValue);
    const invitation = await this.invitationForIdentity(programId, identity);
    const command = this.normalizeCommand(body);
    // Taking a guest off air never waits on the guest's page: standby and wrap are stored before delivery, so a
    // delivery that fails still leaves the guest off air. Live is stored only once the guest was told.
    if (command.type === 'cue' && command.cue !== 'live')
      await this.storeCue(invitation, command.cue);
    const persisted = await this.prisma.guestCommand.create({
      data: {
        invitationId: invitation.id,
        type: command.type,
        payload: command as unknown as Prisma.InputJsonValue,
      },
    });
    try {
      if (command.type === 'media' && command.enabled === false) {
        const participant = await this.roomService.getParticipant(
          this.roomName(programId),
          identity,
        );
        const source =
          command.device === 'camera'
            ? TrackSource.CAMERA
            : TrackSource.MICROPHONE;
        const track = participant.tracks.find(
          (candidate) => candidate.source === source,
        );
        if (!track)
          throw new BadRequestException(
            `${command.device} track is unavailable.`,
          );
        await this.roomService.mutePublishedTrack(
          this.roomName(programId),
          identity,
          track.sid,
          true,
        );
      } else {
        await this.sendGuestData(invitation, {
          ...command,
          id: persisted.id,
          sentAt: persisted.createdAt.toISOString(),
        });
      }
      if (command.type === 'cue' && command.cue === 'live')
        await this.storeCue(invitation, command.cue);
      return this.prisma.guestCommand.update({
        where: { id: persisted.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
    } catch (error) {
      const failureReason =
        error instanceof Error
          ? error.message.slice(0, 240)
          : 'LiveKit command failed';
      await this.prisma.guestCommand.update({
        where: { id: persisted.id },
        data: { status: 'failed', failureReason },
      });
      throw this.livekitUnavailable(error);
    }
  }

  async removeParticipant(
    operator: CanonicalIdentity,
    programIdValue: unknown,
    identityValue: unknown,
  ) {
    const programId = this.normalizeProgramId(programIdValue);
    const identity = this.normalizeGuestIdentity(identityValue);
    const invitation = await this.invitationForIdentity(programId, identity);
    await this.disconnectIfPresent(this.roomName(programId), identity);
    await this.prisma.guestInvitation.update({
      where: { id: invitation.id },
      data: {
        // A removed guest who comes back is screened again.
        admittedAt: null,
        activeSessionId: null,
        activeSessionUntil: null,
        liveSince: null,
        events: {
          create: {
            type: 'removed',
            details: this.operatorAudit(operator),
          },
        },
      },
    });
    this.onAirChanges.next(programId);
    return { identity, status: 'removed' };
  }

  async createRendererToken(
    rendererKey: string | undefined,
    programIdValue: unknown,
    roleValue?: unknown,
  ) {
    this.requireConfiguration();
    const programId = await this.authorizeFor(
      'renderer_token',
      rendererKey,
      programIdValue,
    );
    if (
      roleValue !== undefined &&
      roleValue !== 'return-router' &&
      roleValue !== 'contribution'
    )
      throw new BadRequestException('Invalid renderer role.');
    if (roleValue === 'contribution')
      return this.createContributionToken(programId);
    // The server-run return router has one fixed identity per program: a second instance replaces the first in
    // LiveKit, so a room never gets two sets of return mixes. Guests already accept a `return-router-` publisher.
    const identity =
      roleValue === 'return-router'
        ? `return-router-${programId}`
        : `renderer-${programId}-${randomUUID()}`;
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name: `Alcantara return publisher ${programId}`,
      ttl: '5m',
      metadata: JSON.stringify({ role: 'renderer', programId }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: true,
      canPublishSources: [
        TrackSource.CAMERA,
        TrackSource.MICROPHONE,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      canSubscribe: true,
      canPublishData: true,
      hidden: false,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
  }

  /**
   * The on-air contribution worker (one per radio station, beside Palazzo) listens to the room: hidden, and it
   * can neither publish nor send data. It mixes the guests cued live and the host's `onair:host` track.
   */
  private async createContributionToken(programId: string) {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `contribution-${programId}`,
      name: `Alcantara on-air contribution ${programId}`,
      ttl: '5m',
      metadata: JSON.stringify({ role: 'contribution', programId }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
  }

  /**
   * The guests of a program who are on air right now: cued live for the session they are in, admitted, with an
   * open invitation. Anyone else is off air, including a guest who rejoined in a new session after being cued.
   */
  async onAirGuests(rendererKey: string | undefined, programIdValue: unknown) {
    this.requireConfiguration();
    return this.onAirList(
      await this.authorizeFor('on_air', rendererKey, programIdValue),
    );
  }

  /**
   * The same list as a stream, for the on-air contribution worker: the current list at once, again within moments of
   * any change (a cue, an admission, a new session, a removal or a revoke), and at least every ON_AIR_REFRESH_MS. A
   * list identical to the last one sent is sent only on the refresh. A failed read sends nothing; the reader then
   * finds the stream stale and polls.
   */
  async onAirStream(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ): Promise<Observable<{ data: string }>> {
    this.requireConfiguration();
    const programId = await this.authorizeFor(
      'on_air',
      rendererKey,
      programIdValue,
    );
    return new Observable<{ data: string }>((subscriber) => {
      let closed = false;
      let last: string | null = null;
      let reading = false;
      let again = false;
      const send = async (refresh: boolean) => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        let force = refresh;
        try {
          do {
            again = false;
            const data = JSON.stringify(await this.onAirList(programId));
            if (closed) return;
            if (data !== last) this.metrics.recordOnAirStreamChange();
            if (data !== last || force) subscriber.next({ data });
            last = data;
            force = false;
          } while (again && !closed);
        } catch {
          // Nothing is sent: the reader's freshness check falls back to polling, and the next change reads again.
        } finally {
          reading = false;
        }
      };
      const changes = this.onAirChanges
        .pipe(filter((changed) => changed === programId))
        .subscribe(() => void send(false));
      const refresh = setInterval(() => void send(true), ON_AIR_REFRESH_MS);
      refresh.unref?.();
      const closing = this.onAirClosing.subscribe({
        complete: () => subscriber.complete(),
      });
      this.metrics.recordOnAirStream(1);
      this.onAirStreamsSeen.add(programId);
      this.onAirStreamsOpen.set(
        programId,
        (this.onAirStreamsOpen.get(programId) ?? 0) + 1,
      );
      void send(true);
      return () => {
        closed = true;
        changes.unsubscribe();
        clearInterval(refresh);
        closing.unsubscribe();
        this.metrics.recordOnAirStream(-1);
        // Set when this stream opened, so always present here.
        const open = (this.onAirStreamsOpen.get(programId) as number) - 1;
        if (open > 0) this.onAirStreamsOpen.set(programId, open);
        else this.onAirStreamsOpen.delete(programId);
      };
    });
  }

  /**
   * Who can be on air through calls now, for the dead-air watchdog: the guests cued live in their current session and
   * the tracks published by the program's host-mic identity, the only operator connection that reaches air. Both zero where calls are not configured. Throws when LiveKit cannot be read,
   * so the watchdog holds rather than act under a live voice.
   */
  async onAirPresence(
    programId: string,
  ): Promise<{ guestsLive: number; hostMics: number }> {
    if (!this.hasConfiguration()) return { guestsLive: 0, hostMics: 0 };
    const [{ guests }, mics] = await Promise.all([
      this.onAirList(programId),
      this.hostMicTracks(programId),
    ]);
    const identity = hostMicIdentity(programId);
    return {
      guestsLive: guests.length,
      hostMics: mics.filter((mic) => mic.identity === identity).length,
    };
  }

  private async onAirList(programId: string) {
    const rows = await this.prisma.guestInvitation.findMany({
      where: {
        programId,
        cue: 'live',
        revokedAt: null,
        expiresAt: { gt: new Date() },
        admittedAt: { not: null },
        activeSessionId: { not: null },
      },
      select: {
        id: true,
        cue: true,
        admittedAt: true,
        activeSessionId: true,
        cueSessionId: true,
      },
    });
    // The query only narrows; guestCueState alone says who is live, for this list and everything that reports it.
    const guests = rows
      .filter((row) => guestCueState(row) === 'live')
      .map((row) => this.guestIdentity(row.id))
      .sort();
    this.metrics.setOnAirGuests(guests.length);
    return { programId, guests };
  }

  /**
   * The contribution worker's link for a program (alcantara#877): ok while it holds an on-air stream here, down once
   * it had one on this instance and holds none, unknown when none was ever opened here.
   */
  contributionHealth(programId: string): 'ok' | 'down' | 'unknown' {
    if (this.onAirStreamsOpen.has(programId)) return 'ok';
    return this.onAirStreamsSeen.has(programId) ? 'down' : 'unknown';
  }

  /**
   * Whether the LiveKit room service answers, within LIVEKIT_HEALTH_TIMEOUT_MS. One check serves every caller for
   * LIVEKIT_HEALTH_CACHE_MS, so a desk that polls never loads LiveKit.
   */
  livekitHealth(now = Date.now()): Promise<'ok' | 'down'> {
    this.requireConfiguration();
    if (
      this.livekitCheck &&
      now - this.livekitCheck.at < LIVEKIT_HEALTH_CACHE_MS
    )
      return this.livekitCheck.state;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = Promise.race([
      this.roomService.listRooms().then(() => 'ok' as const),
      new Promise<'down'>((resolve) => {
        timer = setTimeout(() => resolve('down'), LIVEKIT_HEALTH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ])
      .catch(() => 'down' as const)
      .finally(() => clearTimeout(timer));
    this.livekitCheck = { at: now, state };
    return state;
  }

  /** The program id rule every call endpoint applies, for the return router's endpoints. */
  normalizeRendererProgramId(value: unknown): string {
    return this.normalizeProgramId(value);
  }

  /**
   * A program endpoint's renderer credential: that program's key, or the shared key until it is removed
   * (gaulatti/alcantara#884). Returns the program's id. A program id that is not valid is refused as before, after
   * the credential is checked against the shared key alone.
   */
  async authorizeFor(
    endpoint: RendererAuthEndpoint,
    rendererKey: string | undefined,
    programIdValue: unknown,
  ): Promise<string> {
    let programId: string;
    try {
      programId = this.normalizeProgramId(programIdValue);
    } catch (error) {
      this.requireRendererKey(rendererKey);
      throw error;
    }
    if (this.rendererAuth) {
      await this.rendererAuth.authorizeProgram(endpoint, rendererKey, programId);
    } else {
      this.requireRendererKey(rendererKey);
    }
    return programId;
  }

  /** The return runner's cross-program router list: the fleet key, or the shared key until it is removed. */
  authorizeFleet(rendererKey: string | undefined) {
    this.requireConfiguration();
    if (this.rendererAuth) this.rendererAuth.authorizeFleet(rendererKey);
    else this.requireRendererKey(rendererKey);
  }

  /**
   * The programs whose room holds at least one admitted guest with an open session right now. A program whose room
   * LiveKit cannot list is left out this time and asked again on the next call.
   */
  async programsWithAdmittedGuests(): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.guestInvitation.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: now },
        admittedAt: { not: null },
        activeSessionId: { not: null },
      },
      select: { id: true, programId: true },
    });
    const byProgram = new Map<string, Set<string>>();
    for (const row of rows) {
      const ids = byProgram.get(row.programId) ?? new Set<string>();
      ids.add(this.guestIdentity(row.id));
      byProgram.set(row.programId, ids);
    }
    const programs: string[] = [];
    for (const [programId, identities] of byProgram) {
      try {
        const present = await this.roomService.listParticipants(
          this.roomName(programId),
        );
        if (present.some((participant) => identities.has(participant.identity)))
          programs.push(programId);
      } catch {
        // A missing room has no guest in it; LiveKit away is asked again on the next call.
      }
    }
    return programs.sort();
  }

  async getRendererState(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    const programId = await this.authorizeFor(
      'renderer_state',
      rendererKey,
      programIdValue,
    );
    const invitations = await this.prisma.guestInvitation.findMany({
      where: { programId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { slotNumber: 'asc' },
    });
    return {
      programId,
      routes: invitations.map((invitation) => ({
        participantIdentity: this.guestIdentity(invitation.id),
        slotNumber: invitation.slotNumber,
        returnVideo: invitation.returnVideo,
        returnAudioBus: invitation.returnAudioBus,
        sourceGain: invitation.sourceGain,
        sourceMuted: invitation.sourceMuted,
        sourceDelayMs: invitation.sourceDelayMs,
        onAir: guestCueState(invitation) === 'live',
      })),
    };
  }

  async createRendererSourceToken(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    const programId = await this.authorizeFor(
      'renderer_source_token',
      rendererKey,
      programIdValue,
    );
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `renderer-source-${programId}-${randomUUID()}`,
      name: `Alcantara guest source ${programId}`,
      ttl: '5m',
      metadata: JSON.stringify({ role: 'renderer-source', programId }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
  }

  /**
   * The host's microphone on air in a program's room: the `onair:host` tracks that operators publish. Read from LiveKit,
   * so a track the page no longer holds is still seen, and nothing is trusted from the request.
   */
  async hostMicTracks(programIdValue: unknown) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    let participants: Awaited<
      ReturnType<RoomServiceClient['listParticipants']>
    > = [];
    try {
      participants = await this.roomService.listParticipants(
        this.roomName(programId),
      );
    } catch (error) {
      if (!this.isRoomMissing(error)) throw this.livekitUnavailable(error);
    }
    return participants.flatMap((participant) =>
      participant.identity.startsWith('operator-')
        ? participant.tracks
            .filter((track) => track.name === 'onair:host')
            .map((track) => ({
              identity: participant.identity,
              sid: track.sid,
              muted: track.muted,
            }))
        : [],
    );
  }

  /**
   * Takes the host's microphone off air: LiveKit mutes each `onair:host` track on the server, so it stops reaching air
   * whatever the page does. "muted" is reported only after LiveKit confirms each mute.
   */
  async muteHostMic(programIdValue: unknown) {
    const programId = this.normalizeProgramId(programIdValue);
    const tracks = await this.hostMicTracks(programId);
    if (tracks.length === 0)
      return { status: 'no-host-mic' as const, muted: 0 };
    for (const track of tracks) {
      try {
        await this.roomService.mutePublishedTrack(
          this.roomName(programId),
          track.identity,
          track.sid,
          true,
        );
      } catch (error) {
        throw this.livekitUnavailable(error);
      }
    }
    return { status: 'muted' as const, muted: tracks.length };
  }

  async createOperatorToken(
    operator: CanonicalIdentity,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `operator-${createHash('sha256')
        .update(operator.principalId ?? operator.subject)
        .digest('hex')
        .slice(0, 20)}-${randomUUID()}`,
      name: 'Alcantara operator',
      ttl: '5m',
      metadata: JSON.stringify({ role: 'operator' }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: true,
      // Visible, or the return router never receives the talkback. Guests subscribe only their own mix.
      hidden: false,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
  }

  /**
   * A token for the host's microphone on air (gaulatti/alcantara#879). Its identity is fixed per program
   * (hostMicIdentity), so LiveKit admits one at a time: a second tab or device that goes on air disconnects the first
   * (DUPLICATE_IDENTITY), whatever either page does, and air never carries two host microphones. The contribution
   * worker and the return router take `onair:host` only from this identity. It publishes a microphone only, sees
   * no one and sends no data.
   */
  async createHostMicToken(
    programIdValue: unknown,
    principalId: string | null = null,
  ) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: hostMicIdentity(programId),
      name: 'Alcantara host microphone',
      ttl: '5m',
      metadata: JSON.stringify({ role: 'host-mic' }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: false,
      canPublishData: false,
      hidden: false,
    });
    const answer = {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
    // Who may open air, on record: the program and the operator's principal, never the token.
    this.logger.log(
      `Host microphone token issued for ${programId} to principal ${principalId ?? 'unknown'}`,
    );
    return answer;
  }

  /**
   * A token for the desktop console to publish the program it renders to the
   * program's room (gaulatti/alexandria#9): the very frames and sound the
   * desktop's PROGRAM monitor and tape take, as one video and one audio track.
   * Its identity is fixed per program, `desktop-program-feed-<programId>`, so a
   * second desktop takes over from the first instead of adding a duplicate;
   * it is distinct from Alana's `program-feed-<programId>`, so the two never
   * replace each other. It publishes only, and sees no one.
   */
  async createDesktopProgramFeedToken(
    operator: CanonicalIdentity,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `desktop-program-feed-${programId}`,
      name: `Alcantara desktop program ${programId}`,
      ttl: '5m',
      metadata: JSON.stringify({
        role: 'desktop-program-feed',
        programId,
        operator: createHash('sha256')
          .update(operator.principalId ?? operator.subject)
          .digest('hex')
          .slice(0, 20),
      }),
    });
    token.addGrant({
      room: this.roomName(programId),
      roomJoin: true,
      canPublish: true,
      // The program's picture as screen share and its sound as microphone: LiveKit's Swift
      // SDK, which the desktop console uses, can publish app audio only as a microphone-source
      // track, so screen-share audio is not granted.
      canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.MICROPHONE],
      canSubscribe: false,
      canPublishData: false,
      hidden: false,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
      identity: `desktop-program-feed-${programId}`,
    };
  }

  private reportedCall(event?: {
    type: string;
    details: Prisma.JsonValue | null;
  }) {
    const details = (event?.details ?? {}) as {
      iceTransport?: unknown;
      reason?: unknown;
      returnFeedHealth?: unknown;
    };
    return {
      // Whether the guest's own page has the return track: from its latest report, null when it never reported.
      returnReaching:
        event?.type === 'telemetry'
          ? returnReachingFrom(details.returnFeedHealth)
          : null,
      icePath:
        event?.type === 'telemetry' ? icePathFrom(details.iceTransport) : null,
      joinFailure:
        event?.type === 'join_failed'
          ? (GUEST_FAILURES.find((known) => known === details.reason) ??
            'other')
          : null,
    };
  }

  private requireOpenInvitation(invitation: GuestInvitation, now: Date) {
    if (invitation.revokedAt) {
      this.metrics.recordWebrtcJoin('guest', 'token_rejected');
      throw new ForbiddenException('This invitation was revoked.');
    }
    if (invitation.expiresAt <= now) {
      this.metrics.recordWebrtcJoin('guest', 'invite_expired');
      throw new UnauthorizedException('This invitation expired.');
    }
  }

  private async requireActiveSession(sessionTokenValue: unknown) {
    const token = this.requireString(sessionTokenValue, 'Session token');
    const [invitationId] = token.split('.');
    if (!invitationId)
      throw new UnauthorizedException('Invalid guest session.');
    const sessionId = this.verifySessionToken(token, invitationId);
    const invitation = await this.prisma.guestInvitation.findFirst({
      where: {
        id: invitationId,
        activeSessionId: sessionId,
        activeSessionUntil: { gt: new Date() },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!invitation)
      throw new UnauthorizedException('Guest session is inactive.');
    return { invitation, sessionId };
  }

  private async verifyInvitationToken(token: string) {
    const [id, secret, extra] = token.split('.');
    if (!id || !secret || extra)
      throw new UnauthorizedException('Invalid guest invitation.');
    const invitation = await this.prisma.guestInvitation.findUnique({
      where: { id },
    });
    if (
      !invitation ||
      !this.safeEqual(this.hash(token), invitation.tokenHash)
    ) {
      throw new UnauthorizedException('Invalid guest invitation.');
    }
    return invitation;
  }

  private signSessionToken(invitationId: string, sessionId: string) {
    const payload = `${invitationId}.${sessionId}`;
    const signature = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifySessionToken(token: string, invitationId: string) {
    const [tokenInvitationId, sessionId, signature, extra] = token.split('.');
    if (
      !tokenInvitationId ||
      tokenInvitationId !== invitationId ||
      !sessionId ||
      !signature ||
      extra
    ) {
      throw new UnauthorizedException('Invalid guest session.');
    }
    const payload = `${tokenInvitationId}.${sessionId}`;
    const expected = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    if (!this.safeEqual(signature, expected))
      throw new UnauthorizedException('Invalid guest session.');
    return sessionId;
  }

  private normalizeCommand(body: Record<string, unknown>) {
    if (body.type === 'media') {
      if (
        !['camera', 'microphone'].includes(String(body.device)) ||
        typeof body.enabled !== 'boolean'
      ) {
        throw new BadRequestException(
          'A media command requires camera/microphone and enabled state.',
        );
      }
      return {
        version: 1 as const,
        type: 'media' as const,
        device: body.device as 'camera' | 'microphone',
        enabled: body.enabled,
      };
    }
    if (body.type === 'cue') {
      if (!['standby', 'live', 'wrap'].includes(String(body.cue)))
        throw new BadRequestException('Invalid cue.');
      return {
        version: 1 as const,
        type: 'cue' as const,
        cue: body.cue as string,
      };
    }
    if (body.type === 'message') {
      const text = this.requireString(body.text, 'Message').slice(0, 500);
      return { version: 1 as const, type: 'message' as const, text };
    }
    if (body.type === 'talkback') {
      if (typeof body.enabled !== 'boolean')
        throw new BadRequestException('Talkback requires enabled state.');
      return {
        version: 1 as const,
        type: 'talkback' as const,
        enabled: body.enabled,
      };
    }
    throw new BadRequestException('Unsupported participant command.');
  }

  private normalizeTelemetry(value: unknown): Prisma.InputJsonValue | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const source = value as Record<string, unknown>;
    const allowed: Record<string, string | number | boolean> = {};
    for (const key of [
      'connectionState',
      'iceTransport',
      'quality',
      'returnFeedHealth',
      'mixMinusHealth',
      'cameraEnabled',
      'microphoneEnabled',
    ]) {
      const candidate = source[key];
      if (typeof candidate === 'string') allowed[key] = candidate.slice(0, 40);
      if (typeof candidate === 'boolean') allowed[key] = candidate;
    }
    for (const key of [
      'packetLoss',
      'jitterMs',
      'roundTripMs',
      'bitrateKbps',
      'width',
      'height',
      'frameRate',
    ]) {
      const candidate = source[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate))
        allowed[key] = Math.max(0, Math.min(candidate, 1_000_000));
    }
    return allowed;
  }

  private normalizeCommandStatus(value: unknown): CommandStatus {
    if (
      value === 'accepted' ||
      value === 'rejected' ||
      value === 'read' ||
      value === 'acknowledged'
    )
      return value;
    throw new BadRequestException('Invalid acknowledgement status.');
  }

  // The program module's rule (program/program-id.ts), not one of this module's own: a program named with a dot
  // (a domain-style id such as station.fm) had every guest call refused, and ids keep their case as everywhere else.
  private normalizeProgramId(value: unknown) {
    const normalized = validProgramId(this.requireString(value, 'programId'));
    if (normalized === null)
      throw new BadRequestException('Invalid programId.');
    return normalized;
  }

  private normalizeDisplayName(value: unknown) {
    return this.requireString(value, 'displayName').trim().slice(0, 80);
  }

  private normalizeExpiration(value: unknown) {
    if (value === undefined) return 24;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 168
    ) {
      throw new BadRequestException(
        'expiresInHours must be an integer from 1 to 168.',
      );
    }
    return value;
  }

  private normalizeReturnVideo(value: unknown): ReturnVideo {
    if (value === undefined) return 'program';
    if (value === 'program' || value === 'preview' || value === 'none')
      return value;
    throw new BadRequestException(
      'returnVideo must be program, preview, or none.',
    );
  }

  private normalizeReturnAudioBus(value: unknown): ReturnAudioBus {
    if (value === undefined) return 'master';
    if (
      value === 'master' ||
      value === 'monitor' ||
      (typeof value === 'string' && /^aux-[1-8]$/.test(value))
    )
      return value as ReturnAudioBus;
    throw new BadRequestException(
      'returnAudioBus must be master, monitor, or aux-1 through aux-8.',
    );
  }

  private normalizeSourceGain(value: unknown) {
    if (value === undefined) return 1;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new BadRequestException('sourceGain must be between 0 and 1.');
    }
    return value;
  }

  private normalizeSourceMuted(value: unknown) {
    if (value === undefined) return false;
    if (typeof value !== 'boolean')
      throw new BadRequestException('sourceMuted must be boolean.');
    return value;
  }

  private normalizeSourceDelay(value: unknown) {
    if (value === undefined) return 0;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 2000
    ) {
      throw new BadRequestException(
        'sourceDelayMs must be an integer from 0 to 2000.',
      );
    }
    return value;
  }

  private async resolveSlot(programId: string, value: unknown) {
    const occupied = await this.prisma.guestInvitation.findMany({
      where: {
        programId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        slotNumber: { not: null },
      },
      select: { slotNumber: true },
    });
    const occupiedSlots = new Set(occupied.map((item) => item.slotNumber));
    if (value !== undefined) {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_GUESTS
      )
        throw new BadRequestException('slotNumber must be 1 through 6.');
      if (occupiedSlots.has(value))
        throw new ConflictException(`Guest slot ${value} is already assigned.`);
      return value;
    }
    for (let slot = 1; slot <= MAX_GUESTS; slot += 1)
      if (!occupiedSlots.has(slot)) return slot;
    throw new ConflictException('All six guest slots are assigned.');
  }

  private presentInvitation(
    invitation: GuestInvitation & { commands?: GuestCommand[] },
    now: Date,
  ) {
    const status = invitation.revokedAt
      ? 'revoked'
      : invitation.expiresAt <= now
        ? 'expired'
        : invitation.activeSessionUntil && invitation.activeSessionUntil > now
          ? 'active'
          : 'available';
    return {
      id: invitation.id,
      programId: invitation.programId,
      displayName: invitation.displayName,
      slotNumber: invitation.slotNumber,
      returnVideo: invitation.returnVideo,
      returnAudioBus: invitation.returnAudioBus,
      sourceGain: invitation.sourceGain,
      sourceMuted: invitation.sourceMuted,
      sourceDelayMs: invitation.sourceDelayMs,
      expiresAt: invitation.expiresAt.toISOString(),
      revokedAt: invitation.revokedAt?.toISOString() ?? null,
      createdAt: invitation.createdAt.toISOString(),
      status,
      commands: invitation.commands ?? [],
    };
  }

  private async ensureRoom(programId: string) {
    try {
      const roomName = this.roomName(programId);
      const rooms = await this.roomService.listRooms([roomName]);
      if (!rooms.length)
        await this.roomService.createRoom({
          name: roomName,
          maxParticipants: PROGRAM_ROOM_MAX_PARTICIPANTS,
          emptyTimeout: 300,
          departureTimeout: 60,
        });
    } catch (error) {
      throw this.livekitUnavailable(error);
    }
  }

  private async sendGuestData(
    invitation: { id: string; programId: string },
    payload: object,
  ) {
    await this.roomService.sendData(
      this.roomName(invitation.programId),
      Buffer.from(JSON.stringify(payload)),
      DataPacket_Kind.RELIABLE,
      {
        destinationIdentities: [this.guestIdentity(invitation.id)],
        topic: 'alcantara-director',
      },
    );
  }

  private async ensureScreeningRoom(roomName: string) {
    try {
      const rooms = await this.roomService.listRooms([roomName]);
      if (!rooms.length)
        await this.roomService.createRoom({
          name: roomName,
          maxParticipants: 4,
          emptyTimeout: 300,
          departureTimeout: 60,
        });
    } catch (error) {
      throw this.livekitUnavailable(error);
    }
  }

  private async disconnectIfPresent(roomName: string, identity: string) {
    try {
      await this.roomService.removeParticipant(roomName, identity);
    } catch (error) {
      if (
        !this.isRoomMissing(error) &&
        !/participant.*not found/i.test(this.errorMessage(error))
      )
        throw this.livekitUnavailable(error);
    }
  }

  /**
   * The desk's cue line. null: none holds and none was lost. "rejoined": cued live before, then came back off air, so
   * a new cue is needed.
   */
  private deskCueState(
    invitation: StoredCue,
  ): 'standby' | 'live' | 'wrap' | 'rejoined' | null {
    if (invitation.cue === 'rejoined') return 'rejoined';
    // "standby" is also the column's default: with no session on it, none was ever sent.
    if (invitation.cue === 'standby' && invitation.cueSessionId === null)
      return null;
    return guestCueState(invitation);
  }

  /** Stores the operator's cue for the guest's current session; live reaches air for that session only. */
  private async storeCue(
    invitation: {
      id: string;
      programId: string;
      activeSessionId: string | null;
    },
    cue: string,
  ) {
    await this.prisma.guestInvitation.update({
      where: { id: invitation.id },
      data: { cue, cueSessionId: invitation.activeSessionId },
    });
    this.metrics.recordGuestCue(cue as GuestCue);
    this.onAirChanges.next(invitation.programId);
  }

  private async invitationForIdentity(programId: string, identity: string) {
    const id = identity.replace(/^guest-/, '');
    const invitation = await this.prisma.guestInvitation.findFirst({
      where: { id, programId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!invitation)
      throw new NotFoundException('Active invitation not found.');
    return invitation;
  }

  private async requireInvitation(id: string) {
    const invitation = await this.prisma.guestInvitation.findUnique({
      where: { id },
    });
    if (!invitation) throw new NotFoundException('Invitation not found.');
    return invitation;
  }

  private normalizeGuestIdentity(value: unknown) {
    const identity = this.requireString(value, 'participant identity');
    if (!/^guest-[0-9a-f-]{36}$/.test(identity))
      throw new BadRequestException('Invalid guest identity.');
    return identity;
  }

  private requireString(value: unknown, name: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${name} is required.`);
    return value.trim();
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private operatorAudit(operator: CanonicalIdentity) {
    return {
      // Keep the historical pool subject for display and add the verified
      // canonical principal beside it. Neither value is derived from email.
      operatorIdentity: operator.subject,
      operatorPrincipalId: operator.principalId,
    };
  }

  private safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }

  private requireRendererKey(rendererKey: string | undefined) {
    const expected = this.config.get<string>('WEBRTC_RENDERER_KEY') ?? '';
    if (!expected || !rendererKey || !this.safeEqual(rendererKey, expected)) {
      throw new UnauthorizedException('Renderer credential required.');
    }
  }

  private screeningRoomName(invitationId: string) {
    return `alcantara-screening-${invitationId}`;
  }
  private guestIdentity(invitationId: string) {
    return `guest-${invitationId}`;
  }
  private roomName(programId: string) {
    return `alcantara-${programId}`;
  }
  private isRoomMissing(error: unknown) {
    return /room.*not found|does not exist/i.test(this.errorMessage(error));
  }
  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown LiveKit error';
  }
  private livekitUnavailable(error: unknown) {
    return new ServiceUnavailableException(
      `WebRTC control plane unavailable: ${this.errorMessage(error)}`,
    );
  }

  private get roomService() {
    return new RoomServiceClient(this.apiUrl, this.apiKey, this.apiSecret);
  }
  private get wsUrl() {
    return this.config.get<string>('LIVEKIT_WS_URL') ?? '';
  }
  private get apiUrl() {
    return (
      this.config.get<string>('LIVEKIT_API_URL') ??
      this.wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    );
  }
  private get apiKey() {
    return this.config.get<string>('LIVEKIT_API_KEY') ?? '';
  }
  private get apiSecret() {
    return this.config.get<string>('LIVEKIT_API_SECRET') ?? '';
  }
  private get sessionSecret() {
    return this.config.get<string>('WEBRTC_SESSION_SECRET') ?? '';
  }
  private hasConfiguration() {
    return Boolean(
      this.wsUrl && this.apiKey && this.apiSecret && this.sessionSecret,
    );
  }
  private requireConfiguration() {
    if (!this.hasConfiguration())
      throw new ServiceUnavailableException('WebRTC is not configured.');
  }
}
