import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExternalSource, ExternalSourceProgram } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  ExternalSourceSecurity,
  type SourceTransport,
} from './external-source.security';

export type SourceAuthorization = { teamId: number; permissions: string[] };
type SourceWithPrograms = ExternalSource & {
  programs: ExternalSourceProgram[];
};
const TRANSPORTS = new Set<SourceTransport>(['rtmp', 'whip', 'hls', 'srt']);
const LIFECYCLES = new Set([
  'unconfigured',
  'provisioning',
  'waiting',
  'connected',
  'degraded',
  'reconnecting',
  'offline',
  'revoked',
]);
const HEALTH = new Set(['unknown', 'healthy', 'degraded', 'unavailable']);

@Injectable()
export class ExternalSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: ExternalSourceSecurity,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async list(auth: SourceAuthorization) {
    const rows = await this.prisma.externalSource.findMany({
      where: { teamId: auth.teamId },
      include: { programs: true },
      orderBy: [{ revokedAt: 'asc' }, { name: 'asc' }],
    });
    this.metrics.recordExternalSource('read', 'success');
    return rows.map((row) => this.present(row));
  }

  async get(id: string, auth: SourceAuthorization) {
    const row = await this.requireSource(id, auth.teamId);
    this.metrics.recordExternalSource('read', 'success');
    return this.present(row);
  }

  async create(
    subject: string,
    body: Record<string, unknown>,
    auth: SourceAuthorization,
  ) {
    const active = await this.prisma.externalSource.count({
      where: { teamId: auth.teamId, revokedAt: null },
    });
    if (active >= this.quota()) {
      this.metrics.recordExternalSource('create', 'rejected');
      throw new ConflictException('EXTERNAL_SOURCE_QUOTA_EXCEEDED');
    }
    const id = randomUUID();
    const transport = parseTransport(body.transport);
    const transportConfig = await this.security.validateTransportConfig(
      transport,
      body.transportConfig,
    );
    const encrypted = this.security.encrypt(auth.teamId, id, transportConfig);
    const programIds = await this.programIds(body.programIds);
    const name = bounded(body.name, 'name', 120);
    const normalizationProfile = parseNormalization(body.normalizationProfile);
    const push = transport === 'rtmp' || transport === 'whip';
    const credential = push ? this.issueCredential() : null;
    const created = await this.prisma.externalSource.create({
      data: {
        id,
        teamId: auth.teamId,
        name,
        transport,
        lifecycle: push ? 'waiting' : 'unconfigured',
        health: 'unknown',
        normalizationProfile,
        transportConfigCiphertext: encrypted.ciphertext,
        transportConfigNonce: encrypted.nonce,
        configKeyVersion: encrypted.keyVersion,
        credentialVersion: credential ? 1 : 0,
        createdBySubject: subject,
        programs: { create: programIds.map((programId) => ({ programId })) },
        ...(credential
          ? {
              credentials: {
                create: {
                  version: 1,
                  secretHash: this.security.hashCredential(credential),
                },
              },
            }
          : {}),
      },
      include: { programs: true },
    });
    this.metrics.recordExternalSource('create', 'success');
    await this.refreshInventory();
    return {
      ...this.present(created),
      ...(credential ? { credential: { version: 1, secret: credential } } : {}),
    };
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    auth: SourceAuthorization,
  ) {
    const existing = await this.requireSource(id, auth.teamId);
    if (existing.revokedAt) throw new ConflictException('SOURCE_REVOKED');
    const transport =
      body.transport === undefined
        ? parseTransport(existing.transport)
        : parseTransport(body.transport);
    if (transport !== existing.transport)
      throw new ConflictException('SOURCE_TRANSPORT_IMMUTABLE');
    const config =
      body.transportConfig === undefined
        ? this.security.decrypt(
            existing.teamId,
            existing.id,
            existing.transportConfigCiphertext,
            existing.transportConfigNonce,
            existing.configKeyVersion,
          )
        : await this.security.validateTransportConfig(
            transport,
            body.transportConfig,
          );
    const encrypted = this.security.encrypt(
      existing.teamId,
      existing.id,
      config,
    );
    const programIds =
      body.programIds === undefined
        ? null
        : await this.programIds(body.programIds);
    const updated = await this.prisma.externalSource.update({
      where: { id },
      data: {
        ...(body.name === undefined
          ? {}
          : { name: bounded(body.name, 'name', 120) }),
        transport,
        ...(body.normalizationProfile === undefined
          ? {}
          : {
              normalizationProfile: parseNormalization(
                body.normalizationProfile,
              ),
            }),
        transportConfigCiphertext: encrypted.ciphertext,
        transportConfigNonce: encrypted.nonce,
        configKeyVersion: encrypted.keyVersion,
        ...(programIds === null
          ? {}
          : {
              programs: {
                deleteMany: {},
                create: programIds.map((programId) => ({ programId })),
              },
            }),
      },
      include: { programs: true },
    });
    this.metrics.recordExternalSource('update', 'success');
    return this.present(updated);
  }

  async rotateCredential(id: string, auth: SourceAuthorization) {
    const source = await this.requireSource(id, auth.teamId);
    if (source.revokedAt || !['rtmp', 'whip'].includes(source.transport))
      throw new ConflictException('SOURCE_CREDENTIAL_NOT_AVAILABLE');
    const secret = this.issueCredential();
    const version = source.credentialVersion + 1;
    await this.prisma.$transaction([
      this.prisma.externalSourceCredential.updateMany({
        where: { sourceId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.externalSourceCredential.create({
        data: {
          sourceId: id,
          version,
          secretHash: this.security.hashCredential(secret),
        },
      }),
      this.prisma.externalSource.update({
        where: { id },
        data: {
          credentialVersion: version,
          lifecycle: 'waiting',
          health: 'unknown',
          ingressId: null,
          participantIdentity: null,
        },
      }),
    ]);
    this.metrics.recordExternalSource('rotate', 'success');
    return { id, credential: { version, secret } };
  }

  async revoke(id: string, auth: SourceAuthorization) {
    await this.requireSource(id, auth.teamId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.externalSourceCredential.updateMany({
        where: { sourceId: id, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.externalSource.update({
        where: { id },
        data: {
          lifecycle: 'revoked',
          health: 'unavailable',
          revokedAt: now,
          ingressId: null,
          participantIdentity: null,
        },
      }),
    ]);
    this.metrics.recordExternalSource('revoke', 'success');
    await this.refreshInventory();
    return { id, lifecycle: 'revoked' };
  }

  async validateRedirect(
    id: string,
    value: unknown,
    auth: SourceAuthorization,
  ) {
    const source = await this.requireSource(id, auth.teamId);
    if (source.transport !== 'hls' && source.transport !== 'srt')
      throw new BadRequestException('Push source has no redirects');
    const url = await this.security.validatePullUrl(value, source.transport);
    this.metrics.recordExternalSource('redirect', 'success');
    return { allowed: true, urlFingerprint: this.security.fingerprint(url) };
  }

  async reconcile(
    id: string,
    body: Record<string, unknown>,
    auth: SourceAuthorization,
  ) {
    const source = await this.requireSource(id, auth.teamId);
    if (source.revokedAt) throw new ConflictException('SOURCE_REVOKED');
    if (source.transport === 'hls' || source.transport === 'srt') {
      const config = this.security.decrypt(
        source.teamId,
        source.id,
        source.transportConfigCiphertext,
        source.transportConfigNonce,
        source.configKeyVersion,
      );
      await this.security.validatePullUrl(config.url, source.transport);
    }
    const lifecycle = boundedEnum(body.lifecycle, 'lifecycle', LIFECYCLES);
    if (lifecycle === 'revoked')
      throw new ForbiddenException('Use the revoke operation');
    const health = boundedEnum(body.health, 'health', HEALTH);
    const ingressId = optionalBounded(body.ingressId, 255);
    const participantIdentity = optionalBounded(body.participantIdentity, 255);
    const updated = await this.prisma.externalSource.update({
      where: { id },
      data: {
        lifecycle,
        health,
        ingressId,
        participantIdentity,
        ...(lifecycle === 'connected' ? { lastConnectedAt: new Date() } : {}),
      },
      include: { programs: true },
    });
    this.metrics.recordExternalSource('reconcile', 'success');
    await this.refreshInventory();
    return this.present(updated);
  }

  private async requireSource(
    id: string,
    teamId: number,
  ): Promise<SourceWithPrograms> {
    const row = await this.prisma.externalSource.findFirst({
      where: { id, teamId },
      include: { programs: true },
    });
    if (!row) {
      this.metrics.recordExternalSource('read', 'not-found');
      throw new NotFoundException('External source not found');
    }
    return row;
  }

  private async programIds(value: unknown): Promise<string[]> {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16)
      throw new BadRequestException('programIds is invalid');
    const ids = [
      ...new Set(value.map((item) => bounded(item, 'programId', 128))),
    ];
    const count = await this.prisma.programState.count({
      where: { programId: { in: ids } },
    });
    if (count !== ids.length) throw new NotFoundException('Program not found');
    return ids;
  }

  private present(row: SourceWithPrograms) {
    return {
      id: row.id,
      teamId: row.teamId,
      name: row.name,
      transport: row.transport,
      lifecycle: row.lifecycle,
      health: row.health,
      normalizationProfile: row.normalizationProfile,
      credentialVersion: row.credentialVersion,
      ingressId: row.ingressId,
      participantIdentity: row.participantIdentity,
      lastConnectedAt: row.lastConnectedAt,
      revokedAt: row.revokedAt,
      programIds: (row.programs ?? []).map(
        (item: { programId: string }) => item.programId,
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private issueCredential() {
    return randomBytes(32).toString('base64url');
  }
  private quota() {
    const value = Number(this.config.get('EXTERNAL_SOURCE_TEAM_QUOTA') ?? 16);
    return Number.isSafeInteger(value) && value >= 1 && value <= 100
      ? value
      : 16;
  }
  private async refreshInventory() {
    const groups = await this.prisma.externalSource.groupBy({
      by: ['transport', 'lifecycle'],
      _count: { _all: true },
    });
    this.metrics.setExternalSourceInventory(
      groups.map((row) => ({
        transport: row.transport,
        lifecycle: row.lifecycle,
        count: row._count._all,
      })),
    );
  }
}

function parseTransport(value: unknown): SourceTransport {
  if (typeof value !== 'string' || !TRANSPORTS.has(value as SourceTransport))
    throw new BadRequestException('transport is invalid');
  return value as SourceTransport;
}
function parseNormalization(value: unknown): string {
  const result = value ?? '720p30';
  if (result !== '720p30' && result !== '1080p30' && result !== 'passthrough')
    throw new BadRequestException('normalizationProfile is invalid');
  return result;
}
function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BadRequestException(`${field} is invalid`);
  return value.trim();
}
function optionalBounded(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return bounded(value, 'identity', max);
}
function boundedEnum(
  value: unknown,
  field: string,
  allowed: Set<string>,
): string {
  if (typeof value !== 'string' || !allowed.has(value))
    throw new BadRequestException(`${field} is invalid`);
  return value;
}
