import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { ALCANTARA_PERMISSIONS, type AlcantaraPermission } from './permissions';
import type { AuthorizationDecision } from './pompeii.service';

export const TEST_AUTH_ISSUER = 'alcantara-local-test-auth';
export const TEST_AUTH_AUDIENCE = 'alcantara-local-browser';
const TEST_IDENTITIES = ['operator-a', 'operator-b', 'viewer'] as const;

function allPermissions(): AlcantaraPermission[] {
  const result: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') result.push(value);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(visit);
  };
  visit(ALCANTARA_PERMISSIONS);
  return result as AlcantaraPermission[];
}

export function assertTestAuthSafety(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.AUTH_MODE === 'test' &&
    environment.NODE_ENV === 'production'
  ) {
    throw new Error('AUTH_MODE=test must never run with NODE_ENV=production');
  }
}

@Injectable()
export class TestAuthService {
  private readonly enabled: boolean;
  private readonly secret: string;

  constructor(config: ConfigService) {
    assertTestAuthSafety({
      AUTH_MODE: config.get<string>('AUTH_MODE'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    } as NodeJS.ProcessEnv);
    this.enabled = config.get<string>('AUTH_MODE') === 'test';
    this.secret = config.get<string>('TEST_AUTH_SECRET') ?? '';
    if (this.enabled && this.secret.length < 32) {
      throw new Error('TEST_AUTH_SECRET must contain at least 32 characters');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  issue(rawIdentity?: string) {
    if (!this.enabled) throw new NotFoundException();
    const identity = TEST_IDENTITIES.includes(
      rawIdentity as (typeof TEST_IDENTITIES)[number],
    )
      ? (rawIdentity as (typeof TEST_IDENTITIES)[number])
      : 'operator-a';
    const subject = `test:alcantara:${identity}`;
    const permissions =
      identity === 'viewer'
        ? [
            ALCANTARA_PERMISSIONS.access,
            ALCANTARA_PERMISSIONS.program.read,
            ALCANTARA_PERMISSIONS.layout.read,
          ]
        : allPermissions();
    const expiresIn = 60 * 60;
    const accessToken = sign(
      {
        sub: subject,
        name: identity,
        email: `${identity}@alcantara.local`,
        permissions,
        roles: identity === 'viewer' ? ['viewer'] : ['operator'],
      },
      this.secret,
      {
        algorithm: 'HS256',
        audience: TEST_AUTH_AUDIENCE,
        issuer: TEST_AUTH_ISSUER,
        expiresIn,
      },
    );
    return {
      accessToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      user: {
        sub: subject,
        id: subject,
        name: identity,
        email: `${identity}@alcantara.local`,
      },
    };
  }

  authorize(
    bearerToken: string,
    permission: AlcantaraPermission,
    teamId: number,
  ): AuthorizationDecision {
    if (!this.enabled) throw new UnauthorizedException();
    const token = bearerToken.replace(/^Bearer\s+/i, '');
    let payload: JwtPayload;
    try {
      payload = verify(token, this.secret, {
        algorithms: ['HS256'],
        audience: TEST_AUTH_AUDIENCE,
        issuer: TEST_AUTH_ISSUER,
      }) as JwtPayload;
    } catch {
      return {
        authenticated: false,
        allowed: false,
        reason: 'DENY_INVALID_TEST_TOKEN',
        subject: '',
        effectivePermissions: [],
        roles: [],
      };
    }
    const permissions = Array.isArray(payload.permissions)
      ? payload.permissions.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    return {
      authenticated: Boolean(subject),
      allowed: permissions.includes(permission),
      reason: permissions.includes(permission)
        ? 'ALLOW_TEST_AUTH'
        : 'DENY_PERMISSION',
      subject,
      effectivePermissions: permissions,
      roles: [...roles, `team:${teamId}`],
    };
  }
}
