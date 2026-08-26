import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PompeiiService } from './pompeii.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import type { AlcantaraPermission } from './permissions';
import { TestAuthService } from './test-auth.service';

type AuthorizedRequest = {
  headers: { authorization?: string };
  user?: Record<string, unknown>;
};

@Injectable()
export class PompeiiAuthorizationGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly pompeii: PompeiiService,
    @Optional() private readonly testAuth?: TestAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const permission = this.reflector.getAllAndOverride<AlcantaraPermission>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) {
      throw new InternalServerErrorException({
        error: 'AUTHORIZATION_POLICY_MISSING',
      });
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const bearerToken = request.headers.authorization;
    if (!bearerToken) throw new UnauthorizedException('Bearer token required');

    const decision = this.testAuth?.isEnabled()
      ? this.testAuth.authorize(bearerToken, permission, this.pompeii.teamId)
      : await this.pompeii.authorize(bearerToken, permission);
    if (!decision.authenticated) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        reason: decision.reason,
      });
    }
    if (!decision.allowed) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        permission,
        reason: decision.reason,
      });
    }
    if (!decision.subject.trim()) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        reason: 'DENY_MISSING_SUBJECT',
      });
    }

    request.user = {
      ...(request.user ?? {}),
      sub: decision.subject,
      authorization: {
        permission,
        permissions: decision.effectivePermissions,
        roles: decision.roles,
        teamId: this.pompeii.teamId,
      },
    };
    return true;
  }
}
