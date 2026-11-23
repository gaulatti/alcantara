import { Injectable, Logger, Optional } from '@nestjs/common';
import { status, type ServiceError } from '@grpc/grpc-js';
import { PompeiiService } from '../auth/pompeii.service';
import type { AccessMethod } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import type {
  ACCESS_METRIC_RESULTS,
  ACCESS_METRIC_ROUTES,
} from '../observability/managed-metrics.service';

/**
 * gaulatti/alcantara#224: forwards a person's access request to Pompeii's
 * ApplicationAccessService with Alcantara's own service credential. It stores
 * nothing and makes no permission decision (Pompeii does). The bearer is the
 * Authorization header exactly as received; neither it, the credential nor a
 * token value is ever logged.
 */

export type AccessVia = 'console' | 'mcp';
export type AccessRoute = (typeof ACCESS_METRIC_ROUTES)[number];
type AccessResult = (typeof ACCESS_METRIC_RESULTS)[number];

/** The closed error vocabulary of the screen contract (the body never carries Pompeii's message). */
export type AccessErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'tokens_off'
  | 'not_found'
  | 'access_unavailable';

const HTTP_STATUS: Record<AccessErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  tokens_off: 409,
  not_found: 404,
  access_unavailable: 503,
};

export class AccessError extends Error {
  readonly status: number;
  constructor(readonly code: AccessErrorCode) {
    super(code);
    this.name = 'AccessError';
    this.status = HTTP_STATUS[code];
  }
}

export interface AccessToken {
  id: string;
  name: string;
  display_prefix: string;
  permissions: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string;
  created_via_application: string;
  last_used_application: string;
}
export interface AccessRole {
  id: number;
  name: string;
  permissions: string[];
}
export interface AccessGrant {
  id: number;
  user_id: number;
  user_email: string;
  role_id: number;
  role_name: string;
  team_id: number;
  granted_at: string;
}
export interface AccessHistoryEntry {
  at: string;
  action: string;
  actor_email: string;
  target: string;
  via_application: string;
  via_client: string;
}
export interface CreateTokenInput {
  name: string;
  expires_in_days?: number;
  no_expiry?: boolean;
  permissions?: string[];
  all_held_in_application?: boolean;
}

type Wire<T> = { [K in keyof T]?: T[K] };

const CODE_ERRORS: Partial<
  Record<status, { code: AccessErrorCode; result: AccessResult }>
> = {
  [status.UNAUTHENTICATED]: {
    code: 'unauthenticated',
    result: 'unauthenticated',
  },
  [status.PERMISSION_DENIED]: { code: 'forbidden', result: 'forbidden' },
  [status.INVALID_ARGUMENT]: {
    code: 'invalid_request',
    result: 'invalid_request',
  },
  [status.FAILED_PRECONDITION]: { code: 'tokens_off', result: 'tokens_off' },
  [status.NOT_FOUND]: { code: 'not_found', result: 'not_found' },
};

const text = (value: string | undefined): string => value ?? '';
const list = (value: string[] | undefined): string[] => [...(value ?? [])];

const toToken = (wire: Wire<AccessToken> | undefined): AccessToken => ({
  id: text(wire?.id),
  name: text(wire?.name),
  display_prefix: text(wire?.display_prefix),
  permissions: list(wire?.permissions),
  created_at: text(wire?.created_at),
  expires_at: text(wire?.expires_at),
  last_used_at: text(wire?.last_used_at),
  created_via_application: text(wire?.created_via_application),
  last_used_application: text(wire?.last_used_application),
});
const toGrant = (wire: Wire<AccessGrant>): AccessGrant => ({
  id: wire.id ?? 0,
  user_id: wire.user_id ?? 0,
  user_email: text(wire.user_email),
  role_id: wire.role_id ?? 0,
  role_name: text(wire.role_name),
  team_id: wire.team_id ?? 0,
  granted_at: text(wire.granted_at),
});

@Injectable()
export class AccessService {
  private readonly logger = new Logger('AccessService');

  constructor(
    private readonly pompeii: PompeiiService,
    @Optional() private readonly metrics?: ManagedMetricsService,
  ) {}

  async listTokens(
    bearer: string,
    via: AccessVia,
  ): Promise<{ tokens: AccessToken[] }> {
    const response = await this.call<{ tokens?: Wire<AccessToken>[] }>(
      'tokens_list',
      'ListMyTokens',
      this.access(bearer, via),
    );
    return { tokens: (response.tokens ?? []).map(toToken) };
  }

  /** The only answer that carries a token value. */
  async createToken(
    bearer: string,
    via: AccessVia,
    input: CreateTokenInput,
  ): Promise<{ token: AccessToken; value: string }> {
    const response = await this.call<{
      token?: Wire<AccessToken>;
      value?: string;
    }>('token_create', 'CreateMyToken', {
      access: this.access(bearer, via),
      name: input.name,
      expires_in_days: input.expires_in_days ?? 0,
      no_expiry: input.no_expiry ?? false,
      permissions: input.permissions ?? [],
      all_held_in_application: input.all_held_in_application ?? false,
    });
    return { token: toToken(response.token), value: text(response.value) };
  }

  async revokeToken(
    bearer: string,
    via: AccessVia,
    tokenId: string,
  ): Promise<Record<string, never>> {
    await this.call('token_revoke', 'RevokeMyToken', {
      access: this.access(bearer, via),
      token_id: tokenId,
    });
    return {};
  }

  async getTokenSwitch(
    bearer: string,
    via: AccessVia,
  ): Promise<{ enabled: boolean }> {
    const response = await this.call<{ enabled?: boolean }>(
      'token_switch_get',
      'GetTokenSwitch',
      this.access(bearer, via),
    );
    return { enabled: response.enabled === true };
  }

  async setTokenSwitch(
    bearer: string,
    via: AccessVia,
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    const response = await this.call<{ enabled?: boolean }>(
      'token_switch_set',
      'SetTokenSwitch',
      { access: this.access(bearer, via), enabled },
    );
    return { enabled: response.enabled === true };
  }

  async listRoles(
    bearer: string,
    via: AccessVia,
  ): Promise<{ roles: AccessRole[] }> {
    const response = await this.call<{ roles?: Wire<AccessRole>[] }>(
      'roles_list',
      'ListRoles',
      this.access(bearer, via),
    );
    return {
      roles: (response.roles ?? []).map((role) => ({
        id: role.id ?? 0,
        name: text(role.name),
        permissions: list(role.permissions),
      })),
    };
  }

  async listGrants(
    bearer: string,
    via: AccessVia,
  ): Promise<{ grants: AccessGrant[] }> {
    const response = await this.call<{ grants?: Wire<AccessGrant>[] }>(
      'grants_list',
      'ListGrants',
      this.access(bearer, via),
    );
    return { grants: (response.grants ?? []).map(toGrant) };
  }

  async grant(
    bearer: string,
    via: AccessVia,
    input: { user_id: number; role_id: number },
  ): Promise<AccessGrant> {
    return toGrant(
      await this.call<Wire<AccessGrant>>('grant_create', 'Grant', {
        access: this.access(bearer, via),
        user_id: input.user_id,
        role_id: input.role_id,
      }),
    );
  }

  async revokeGrant(
    bearer: string,
    via: AccessVia,
    grantId: number,
  ): Promise<Record<string, never>> {
    await this.call('grant_revoke', 'Revoke', {
      access: this.access(bearer, via),
      grant_id: grantId,
    });
    return {};
  }

  async listHistory(
    bearer: string,
    via: AccessVia,
    input: { limit?: number; before?: string } = {},
  ): Promise<{ entries: AccessHistoryEntry[] }> {
    const response = await this.call<{ entries?: Wire<AccessHistoryEntry>[] }>(
      'history_list',
      'ListAccessHistory',
      {
        access: this.access(bearer, via),
        limit: input.limit ?? 50,
        before: input.before ?? '',
      },
    );
    return {
      entries: (response.entries ?? []).map((entry) => ({
        at: text(entry.at),
        action: text(entry.action),
        actor_email: text(entry.actor_email),
        target: text(entry.target),
        via_application: text(entry.via_application),
        via_client: text(entry.via_client),
      })),
    };
  }

  private access(bearer: string, via: AccessVia) {
    return { bearer_token: bearer, team_id: 0, via_client: via };
  }

  private async call<T extends object>(
    route: AccessRoute,
    method: AccessMethod,
    request: object,
  ): Promise<T> {
    const started = process.hrtime.bigint();
    const done = (result: AccessResult) =>
      this.metrics?.recordAccessRequest(
        route,
        result,
        Number(process.hrtime.bigint() - started) / 1_000_000_000,
      );
    if (!this.pompeii.hasAccessCredential()) {
      done('not_configured');
      throw new AccessError('access_unavailable');
    }
    try {
      const response = await this.pompeii.accessCall<T>(method, request);
      done('ok');
      return response;
    } catch (error) {
      const known =
        CODE_ERRORS[(error as Partial<ServiceError>).code as status];
      if (known) {
        done(known.result);
        if (known.code === 'unauthenticated')
          // After the guard accepted the session this is almost always a
          // service credential Pompeii does not know; it looks like a bad
          // session otherwise. Never the value, never Pompeii's message.
          this.logger.warn(
            `Pompeii refused an access call on ${route} as unauthenticated: check POMPEII_ACCESS_CREDENTIAL and the sign-in client`,
          );
        throw new AccessError(known.code);
      }
      done('unavailable');
      this.logger.warn(
        `Pompeii access call ${route} unavailable (grpc code ${String((error as Partial<ServiceError>).code ?? 'unknown')})`,
      );
      throw new AccessError('access_unavailable');
    }
  }
}
