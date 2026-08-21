import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
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
import { PrismaService } from '../prisma.service';

type ReturnVideo = 'program' | 'preview' | 'none';
type ReturnAudioBus = 'master' | 'monitor' | `aux-${number}`;
type CommandStatus = 'accepted' | 'rejected' | 'read' | 'acknowledged';

const MAX_GUESTS = 6;
const SESSION_LEASE_MS = 60_000;
const JOIN_TOKEN_TTL = '5m';

@Injectable()
export class WebrtcService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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
    operatorIdentity: string,
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
        createdByIdentity: operatorIdentity,
        events: {
          create: { type: 'created', details: { expiresInHours, slotNumber } },
        },
      },
    });
    return {
      ...this.presentInvitation(invitation, new Date()),
      invitation: invitationToken,
      invitationPath: `/guest/${encodeURIComponent(invitationToken)}`,
    };
  }

  async replaceInvitation(operatorIdentity: string, id: string) {
    const existing = await this.requireInvitation(id);
    await this.revokeInvitation(operatorIdentity, id);
    return this.createInvitation(operatorIdentity, {
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

  async revokeInvitation(operatorIdentity: string, id: string) {
    const invitation = await this.requireInvitation(id);
    if (!invitation.revokedAt) {
      await this.prisma.guestInvitation.update({
        where: { id },
        data: {
          revokedAt: new Date(),
          slotNumber: null,
          activeSessionId: null,
          activeSessionUntil: null,
          events: {
            create: { type: 'revoked', details: { operatorIdentity } },
          },
        },
      });
    }
    await this.disconnectIfPresent(
      invitation.programId,
      this.guestIdentity(id),
    );
    return { id, status: 'revoked' };
  }

  async updateReturn(
    operatorIdentity: string,
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
              operatorIdentity,
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
    const invitation = await this.verifyInvitationToken(invitationToken);
    const now = new Date();
    if (invitation.revokedAt)
      throw new ForbiddenException('This invitation was revoked.');
    if (invitation.expiresAt <= now)
      throw new UnauthorizedException('This invitation expired.');

    let sessionId: string | null = null;
    if (typeof sessionTokenValue === 'string' && sessionTokenValue) {
      sessionId = this.verifySessionToken(sessionTokenValue, invitation.id);
    }
    if (!sessionId) sessionId = randomUUID();

    const claimed = await this.prisma.guestInvitation.updateMany({
      where: {
        id: invitation.id,
        revokedAt: null,
        expiresAt: { gt: now },
        OR: [
          { activeSessionId: null },
          { activeSessionUntil: { lt: now } },
          { activeSessionId: sessionId },
        ],
      },
      data: {
        activeSessionId: sessionId,
        activeSessionUntil: new Date(now.getTime() + SESSION_LEASE_MS),
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        'This invitation is already active in another session.',
      );
    }

    const identity = this.guestIdentity(invitation.id);
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
      room: this.roomName(invitation.programId),
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      canSubscribe:
        invitation.returnVideo !== 'none' || Boolean(invitation.returnAudioBus),
      canPublishData: true,
    });
    await this.prisma.guestEvent.create({
      data: { invitationId: invitation.id, type: 'token_issued' },
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      sessionToken: this.signSessionToken(invitation.id, sessionId),
      roomName: this.roomName(invitation.programId),
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
    };
  }

  async heartbeat(sessionTokenValue: unknown, telemetryValue: unknown) {
    const session = await this.requireActiveSession(sessionTokenValue);
    const telemetry = this.normalizeTelemetry(telemetryValue);
    const activeSessionUntil = new Date(Date.now() + SESSION_LEASE_MS);
    await this.prisma.guestInvitation.update({
      where: { id: session.invitation.id },
      data: {
        activeSessionUntil,
        ...(telemetry
          ? { events: { create: { type: 'telemetry', details: telemetry } } }
          : {}),
      },
    });
    return { activeSessionUntil: activeSessionUntil.toISOString() };
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
      include: { commands: { orderBy: { createdAt: 'desc' }, take: 10 } },
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
    return {
      roomName: this.roomName(programId),
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
    operatorIdentity: string,
    programIdValue: unknown,
    identityValue: unknown,
  ) {
    const programId = this.normalizeProgramId(programIdValue);
    const identity = this.normalizeGuestIdentity(identityValue);
    const invitation = await this.invitationForIdentity(programId, identity);
    await this.disconnectIfPresent(programId, identity);
    await this.prisma.guestInvitation.update({
      where: { id: invitation.id },
      data: {
        activeSessionId: null,
        activeSessionUntil: null,
        events: { create: { type: 'removed', details: { operatorIdentity } } },
      },
    });
    return { identity, status: 'removed' };
  }

  async createRendererToken(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    this.requireRendererKey(rendererKey);
    const programId = this.normalizeProgramId(programIdValue);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `renderer-${programId}-${randomUUID()}`,
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

  async getRendererState(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    this.requireRendererKey(rendererKey);
    const programId = this.normalizeProgramId(programIdValue);
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
      })),
    };
  }

  async createRendererSourceToken(
    rendererKey: string | undefined,
    programIdValue: unknown,
  ) {
    this.requireConfiguration();
    this.requireRendererKey(rendererKey);
    const programId = this.normalizeProgramId(programIdValue);
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

  async createOperatorToken(operatorIdentity: string, programIdValue: unknown) {
    this.requireConfiguration();
    const programId = this.normalizeProgramId(programIdValue);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `operator-${createHash('sha256').update(operatorIdentity).digest('hex').slice(0, 20)}-${randomUUID()}`,
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
      hidden: true,
    });
    return {
      serverUrl: this.wsUrl,
      token: await token.toJwt(),
      roomName: this.roomName(programId),
    };
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

  private normalizeProgramId(value: unknown) {
    const normalized = this.requireString(value, 'programId')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized))
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
          maxParticipants: 8,
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

  private async disconnectIfPresent(programId: string, identity: string) {
    try {
      await this.roomService.removeParticipant(
        this.roomName(programId),
        identity,
      );
    } catch (error) {
      if (
        !this.isRoomMissing(error) &&
        !/participant.*not found/i.test(this.errorMessage(error))
      )
        throw this.livekitUnavailable(error);
    }
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
