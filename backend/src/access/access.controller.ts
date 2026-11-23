import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  AccessError,
  AccessService,
  type CreateTokenInput,
} from './access.service';

/** The permission keys of this application, as the screen's picker offers them. */
export const ACCESS_APPLICATION_PREFIX = 'alcantara:';

type AuthorizedRequest = {
  headers: { authorization?: string };
  user?: { authorization?: { permissions?: string[] } };
};

const invalid = () => new AccessError('invalid_request');
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function optional<T>(
  body: Record<string, unknown>,
  key: string,
  type: 'number' | 'boolean',
): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== type) throw invalid();
  return value as T;
}

function parseCreate(body: unknown): CreateTokenInput {
  if (!isObject(body) || typeof body.name !== 'string' || !body.name.trim())
    throw invalid();
  const permissions = body.permissions;
  if (
    permissions !== undefined &&
    (!Array.isArray(permissions) ||
      permissions.some((key) => typeof key !== 'string'))
  )
    throw invalid();
  return {
    name: body.name,
    expires_in_days: optional<number>(body, 'expires_in_days', 'number'),
    no_expiry: optional<boolean>(body, 'no_expiry', 'boolean'),
    permissions: permissions as string[] | undefined,
    all_held_in_application: optional<boolean>(
      body,
      'all_held_in_application',
      'boolean',
    ),
  };
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid();
  return parsed;
}

/** A body id must be a number, not a numeric string. */
function bodyId(value: unknown): number {
  if (typeof value !== 'number') throw invalid();
  return positiveInteger(value);
}

/**
 * gaulatti/alcantara#224: the /access routes the Access page calls. Every one
 * needs only a signed-in person (alcantara:access); Pompeii makes every other
 * decision. Nothing here is stored. A request or an answer of /access/tokens
 * can carry a bearer or a token value, so no body is ever logged (the HTTP
 * layer logs none, and this controller writes no log line of its own).
 */
@Controller('access')
@RequirePermission(ALCANTARA_PERMISSIONS.access)
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('tokens')
  listTokens(@Req() req: AuthorizedRequest) {
    return this.forward(() =>
      this.access.listTokens(this.bearer(req), 'console'),
    );
  }

  @Post('tokens')
  createToken(@Req() req: AuthorizedRequest, @Body() body: unknown) {
    return this.forward(() =>
      this.access.createToken(this.bearer(req), 'console', parseCreate(body)),
    );
  }

  @Delete('tokens/:id')
  revokeToken(@Req() req: AuthorizedRequest, @Param('id') id: string) {
    return this.forward(() => {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw invalid();
      return this.access.revokeToken(this.bearer(req), 'console', id);
    });
  }

  @Get('token-switch')
  getTokenSwitch(@Req() req: AuthorizedRequest) {
    return this.forward(() =>
      this.access.getTokenSwitch(this.bearer(req), 'console'),
    );
  }

  @Put('token-switch')
  setTokenSwitch(@Req() req: AuthorizedRequest, @Body() body: unknown) {
    return this.forward(() => {
      if (!isObject(body) || typeof body.enabled !== 'boolean') throw invalid();
      return this.access.setTokenSwitch(
        this.bearer(req),
        'console',
        body.enabled,
      );
    });
  }

  @Get('roles')
  listRoles(@Req() req: AuthorizedRequest) {
    return this.forward(() =>
      this.access.listRoles(this.bearer(req), 'console'),
    );
  }

  @Get('grants')
  listGrants(@Req() req: AuthorizedRequest) {
    return this.forward(() =>
      this.access.listGrants(this.bearer(req), 'console'),
    );
  }

  @Post('grants')
  grant(@Req() req: AuthorizedRequest, @Body() body: unknown) {
    return this.forward(() => {
      if (!isObject(body)) throw invalid();
      return this.access.grant(this.bearer(req), 'console', {
        user_id: bodyId(body.user_id),
        role_id: bodyId(body.role_id),
      });
    });
  }

  @Delete('grants/:id')
  revokeGrant(@Req() req: AuthorizedRequest, @Param('id') id: string) {
    return this.forward(() =>
      this.access.revokeGrant(this.bearer(req), 'console', positiveInteger(id)),
    );
  }

  @Get('history')
  listHistory(
    @Req() req: AuthorizedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.forward(() => {
      const parsed = limit === undefined ? 50 : positiveInteger(limit);
      if (parsed > 200) throw invalid();
      if (before !== undefined && Number.isNaN(Date.parse(before)))
        throw invalid();
      return this.access.listHistory(this.bearer(req), 'console', {
        limit: parsed,
        before,
      });
    });
  }

  /**
   * The caller's own effective permissions in this application, read from the
   * decision the guard already made for this request: no Pompeii call and no
   * service credential. A wildcard is never expanded or returned.
   */
  @Get('my-permissions')
  myPermissions(@Req() req: AuthorizedRequest) {
    const held = req.user?.authorization?.permissions ?? [];
    return {
      permissions: [
        ...new Set(
          held.filter((key) => key.startsWith(ACCESS_APPLICATION_PREFIX)),
        ),
      ].sort(),
    };
  }

  private bearer(req: AuthorizedRequest): string {
    // The guard has accepted the request, so the header is present.
    return req.headers.authorization as string;
  }

  private async forward<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AccessError)
        throw new HttpException({ error: error.code }, error.status);
      throw error;
    }
  }
}
