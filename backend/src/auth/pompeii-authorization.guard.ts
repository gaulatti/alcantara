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

// Alcantara accepts only interactive session tokens. A personal access token
// is refused before any authorization call.
const PERSONAL_ACCESS_TOKEN_PREFIX = 'pmp_pat_';

// Whitespace as Go's unicode.IsSpace counts it (JavaScript's \s plus U+0085),
// so this reads a header at least as widely as Pompeii's pat.StripBearer:
// trim, drop one case-insensitive "Bearer" scheme, trim again.
const LEADING_SPACE = /^[\s\u0085]+/;
const BEARER_SCHEME = /^bearer[\s\u0085]+/i;

function isPersonalAccessToken(authorization: string): boolean {
  const credential = authorization
    .replace(LEADING_SPACE, '')
    .replace(BEARER_SCHEME, '')
    .replace(LEADING_SPACE, '');
  return credential.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX);
}

export type AuthorizedRequest = {
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

    await authorizeBearer(
      context.switchToHttp().getRequest<AuthorizedRequest>(),
      permission,
      this.pompeii,
      this.testAuth,
    );
    return true;
  }
}

/**
 * The signed-in check every guarded route runs: a session token (never a personal access token) that Pompeii, or the
 * local test issuer when it is enabled, authorizes for the permission. On success the caller is set on the request.
 */
export async function authorizeBearer(
  request: AuthorizedRequest,
  permission: AlcantaraPermission,
  pompeii: PompeiiService,
  testAuth?: TestAuthService,
): Promise<void> {
  const bearerToken = request.headers.authorization;
  if (!bearerToken) throw new UnauthorizedException('Bearer token required');
  if (isPersonalAccessToken(bearerToken)) {
    pompeii.recordUnsupportedCredential();
    throw new UnauthorizedException({
      error: 'UNAUTHENTICATED',
      reason: 'DENY_UNSUPPORTED_CREDENTIAL',
    });
  }

  const decision = testAuth?.isEnabled()
    ? testAuth.authorize(bearerToken, permission, pompeii.teamId)
    : await pompeii.authorize(bearerToken, permission);
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
    // Recorded on new writes and used to read migrated rows. Absent until
    // Pompeii resolves one, which keeps legacy rows reachable meanwhile.
    principalId: decision.principalId,
    authorization: {
      permission,
      permissions: decision.effectivePermissions,
      roles: decision.roles,
      teamId: pompeii.teamId,
    },
  };
}
