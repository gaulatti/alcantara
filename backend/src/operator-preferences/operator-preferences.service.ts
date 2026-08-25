import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  defaultProfile,
  parseDeviceClass,
  parseProfile,
  type DeviceClass,
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

  async get(subject: string, rawDeviceClass: string) {
    const deviceClass = parseDeviceClass(rawDeviceClass);
    const stored = await this.prisma.operatorPreference.findUnique({
      where: { subject_deviceClass: { subject, deviceClass } },
    });
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
    subject: string,
    rawDeviceClass: string,
    body: { version?: unknown; profile?: unknown },
  ) {
    const deviceClass = parseDeviceClass(rawDeviceClass);
    const version = integerVersion(body.version);
    const profile = parseProfile(
      body.profile,
      deviceClass,
    ) as unknown as Prisma.InputJsonValue;
    try {
      const saved = await this.prisma.$transaction(async (transaction) => {
        if (version === 0) {
          return transaction.operatorPreference.create({
            data: { subject, deviceClass, profile },
          });
        }
        const updated = await transaction.operatorPreference.updateMany({
          where: { subject, deviceClass, version },
          data: { profile, version: { increment: 1 } },
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
          authoritative: await this.get(subject, deviceClass),
        });
      }
      this.metrics.recordPreference('write', 'failure');
      throw error;
    }
  }

  async reset(subject: string, rawDeviceClass?: string) {
    if (rawDeviceClass) {
      const deviceClass = parseDeviceClass(rawDeviceClass);
      await this.prisma.operatorPreference.deleteMany({
        where: { subject, deviceClass },
      });
      this.metrics.recordPreference('reset-class', 'success');
      return { deviceClass, version: 0, profile: defaultProfile(deviceClass) };
    }
    await this.prisma.operatorPreference.deleteMany({ where: { subject } });
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
    subject: string,
    body: Record<string, unknown>,
    authorization: OperatorAuthorization,
  ) {
    const scope = parseScope(body.scope);
    const scopeId = boundedText(body.scopeId, 'scopeId', 128);
    await this.assertScopeAccess(scope, scopeId, authorization, true);
    const sourceDeviceClass = parseDeviceClass(
      String(body.sourceDeviceClass ?? ''),
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
        ownerSubject: subject,
        name,
        description,
        scope,
        scopeId,
        sourceDeviceClass,
        profile,
      },
      update: {
        ownerSubject: subject,
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
    subject: string,
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
    const deviceClass = parseDeviceClass(String(body.deviceClass ?? ''));
    if (deviceClass !== layout.sourceDeviceClass) {
      throw new ConflictException({
        error: 'DEVICE_CLASS_MISMATCH',
        sourceDeviceClass: layout.sourceDeviceClass,
      });
    }
    const saved = await this.save(subject, deviceClass, {
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
