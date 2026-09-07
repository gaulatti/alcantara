import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import type { CanonicalIdentity } from '../identity/principals';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  defaultProfile,
  parseDeviceClass,
  parseProfile,
} from './operator-preferences.types';

export interface OperatorAuthorization {
  permissions: string[];
  teamId: number;
}

@Injectable()
export class OperatorPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  /**
   * Normalizes the identity attached by the authorization guard. A null
   * principal is the explicit rollout state for an identity Pompeii has not
   * linked yet; callers cannot silently discard a resolved principal.
   */
  private identity(value: CanonicalIdentity): CanonicalIdentity {
    return {
      subject: value.subject,
      principalId: value.principalId?.trim() || null,
    };
  }

  /**
   * Finds the row for this operator, preferring the canonical principal so a
   * migrated row is still theirs after they move pools, and falling back to the
   * pool subject so an unmigrated row stays reachable.
   */
  private async findPreference(
    identity: CanonicalIdentity,
    deviceClass: string,
  ) {
    if (identity.principalId) {
      const byPrincipal = await this.prisma.operatorPreference.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 2,
        where: { principalId: identity.principalId, deviceClass },
      });
      if (byPrincipal.length > 1) {
        this.metrics.recordPreference('read', 'conflict');
        throw new ConflictException('CANONICAL_IDENTITY_COLLISION');
      }
      if (byPrincipal[0]) return byPrincipal[0];
    }
    return this.prisma.operatorPreference.findUnique({
      where: {
        subject_deviceClass: { subject: identity.subject, deviceClass },
      },
    });
  }

  async get(caller: CanonicalIdentity, rawDeviceClass: string) {
    const identity = this.identity(caller);
    const subject = identity.subject;
    const deviceClass = parseDeviceClass(rawDeviceClass);
    const stored = await this.findPreference(identity, deviceClass);
    this.metrics.recordPreference('read', stored ? 'success' : 'default');
    return (
      stored ?? {
        subject,
        deviceClass,
        version: 0,
        profile: defaultProfile(deviceClass),
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async save(
    caller: CanonicalIdentity,
    rawDeviceClass: string,
    body: { version?: unknown; profile?: unknown },
  ) {
    const identity = this.identity(caller);
    const deviceClass = parseDeviceClass(rawDeviceClass);
    // Writes target whichever row this operator already owns, which may carry a
    // different pool subject after a migration.
    const existing = await this.findPreference(identity, deviceClass);
    const subject = existing?.subject ?? identity.subject;
    const version = integerVersion(body.version);
    const profile = parseProfile(
      body.profile,
      deviceClass,
    ) as unknown as Prisma.InputJsonValue;
    try {
      const saved = await this.prisma.$transaction(async (transaction) => {
        if (version === 0) {
          return transaction.operatorPreference.create({
            // The canonical principal is recorded only once Pompeii resolved
            // one; it is never guessed from the subject or an email.
            data: {
              subject,
              principalId: identity.principalId,
              deviceClass,
              profile,
            },
          });
        }
        const updated = await transaction.operatorPreference.updateMany({
          where: { subject, deviceClass, version },
          data: {
            profile,
            version: { increment: 1 },
            // Backfills the canonical principal on an existing row the first
            // time its owner signs in with one resolved.
            ...(identity.principalId && !existing?.principalId
              ? { principalId: identity.principalId }
              : {}),
          },
        });
        if (updated.count !== 1)
          throw new ConflictException('PROFILE_VERSION_CONFLICT');
        return transaction.operatorPreference.findUniqueOrThrow({
          where: { subject_deviceClass: { subject, deviceClass } },
        });
      });
      this.metrics.recordPreference('write', 'success');
      return saved;
    } catch (error) {
      if (
        error instanceof ConflictException ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002')
      ) {
        this.metrics.recordPreference('write', 'conflict');
        throw new ConflictException({
          error: 'PROFILE_VERSION_CONFLICT',
          authoritative: await this.get(identity, deviceClass),
        });
      }
      this.metrics.recordPreference('write', 'failure');
      throw error;
    }
  }

  async reset(caller: CanonicalIdentity, rawDeviceClass?: string) {
    const identity = this.identity(caller);
    // Both identities are cleared, so a reset after a pool move does not leave
    // the operator's migrated row behind.
    const owned = identity.principalId
      ? [{ subject: identity.subject }, { principalId: identity.principalId }]
      : [{ subject: identity.subject }];
    if (rawDeviceClass) {
      const deviceClass = parseDeviceClass(rawDeviceClass);
      await this.prisma.operatorPreference.deleteMany({
        where: { OR: owned, deviceClass },
      });
      this.metrics.recordPreference('reset-class', 'success');
      return { deviceClass, version: 0, profile: defaultProfile(deviceClass) };
    }
    await this.prisma.operatorPreference.deleteMany({ where: { OR: owned } });
    this.metrics.recordPreference('reset-all', 'success');
    return { ok: true };
  }

  async discover(
    scope: string,
    scopeId: string,
    authorization: OperatorAuthorization,
  ) {
    await this.assertScopeAccess(scope, scopeId, authorization, false);
    return this.prisma.sharedConsoleLayout.findMany({
      where: { scope, scopeId, retiredAt: null },
      orderBy: [{ name: 'asc' }],
    });
  }

  async publish(
    caller: CanonicalIdentity,
    body: Record<string, unknown>,
    authorization: OperatorAuthorization,
  ) {
    const identity = this.identity(caller);
    const scope = parseScope(body.scope);
    const scopeId = boundedText(body.scopeId, 'scopeId', 128);
    await this.assertScopeAccess(scope, scopeId, authorization, true);
    const sourceDeviceClass = parseDeviceClass(
      stringInput(body.sourceDeviceClass),
    );
    const name = boundedText(body.name, 'name', 120);
    const description = optionalText(body.description, 500);
    const profile = parseProfile(
      body.profile,
      sourceDeviceClass,
    ) as unknown as Prisma.InputJsonValue;
    const saved = await this.prisma.sharedConsoleLayout.upsert({
      where: { scope_scopeId_name: { scope, scopeId, name } },
      create: {
        ownerSubject: identity.subject,
        ownerPrincipalId: identity.principalId,
        name,
        description,
        scope,
        scopeId,
        sourceDeviceClass,
        profile,
      },
      update: {
        ownerSubject: identity.subject,
        ownerPrincipalId: identity.principalId,
        description,
        sourceDeviceClass,
        profile,
        version: { increment: 1 },
        retiredAt: null,
      },
    });
    this.metrics.recordPreference('publish', 'success');
    return saved;
  }

  async retire(id: string, authorization: OperatorAuthorization) {
    const layout = await this.prisma.sharedConsoleLayout.findUnique({
      where: { id },
    });
    if (!layout) throw new NotFoundException();
    await this.assertScopeAccess(
      layout.scope,
      layout.scopeId,
      authorization,
      true,
    );
    const retired = await this.prisma.sharedConsoleLayout.update({
      where: { id },
      data: { retiredAt: new Date(), version: { increment: 1 } },
    });
    this.metrics.recordPreference('retire', 'success');
    return retired;
  }

  async load(
    caller: CanonicalIdentity,
    id: string,
    body: { deviceClass?: unknown; version?: unknown },
    authorization: OperatorAuthorization,
  ) {
    const layout = await this.prisma.sharedConsoleLayout.findUnique({
      where: { id },
    });
    if (!layout || layout.retiredAt) throw new NotFoundException();
    await this.assertScopeAccess(
      layout.scope,
      layout.scopeId,
      authorization,
      false,
    );
    const deviceClass = parseDeviceClass(stringInput(body.deviceClass));
    if (deviceClass !== layout.sourceDeviceClass) {
      throw new ConflictException({
        error: 'DEVICE_CLASS_MISMATCH',
        sourceDeviceClass: layout.sourceDeviceClass,
      });
    }
    const saved = await this.save(caller, deviceClass, {
      version: body.version,
      profile: layout.profile,
    });
    this.metrics.recordPreference('load-shared', 'success');
    return { layout, preference: saved };
  }

  private async assertScopeAccess(
    scope: string,
    scopeId: string,
    authorization: OperatorAuthorization,
    manage: boolean,
  ) {
    const permission = manage
      ? ALCANTARA_PERMISSIONS.layout.manage
      : scope === 'program'
        ? ALCANTARA_PERMISSIONS.program.read
        : ALCANTARA_PERMISSIONS.access;
    if (!authorization.permissions.includes(permission))
      throw new ForbiddenException({ error: 'FORBIDDEN', permission });
    if (scope === 'team') {
      if (scopeId !== String(authorization.teamId))
        throw new ForbiddenException('TEAM_SCOPE_MISMATCH');
      return;
    }
    const program = await this.prisma.programState.findUnique({
      where: { programId: scopeId },
      select: { id: true },
    });
    if (!program) throw new NotFoundException('Program not found');
  }
}

function integerVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0)
    throw new ConflictException('PROFILE_VERSION_REQUIRED');
  return version;
}

function stringInput(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseScope(value: unknown): 'program' | 'team' {
  if (value !== 'program' && value !== 'team')
    throw new ForbiddenException('scope must be program or team');
  return value;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new ForbiddenException(`${field} is invalid`);
  return value.trim();
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, 'description', max);
}
