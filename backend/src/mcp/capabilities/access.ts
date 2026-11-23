import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  AccessError,
  AccessService,
  type AccessGrant,
  type AccessRole,
  type AccessToken,
} from '../../access/access.service';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import {
  McpToolError,
  McpToolProvider,
  type McpContext,
  type McpErrorCode,
  type McpToolSpec,
} from '../contract';
import { actionSpec, readSpec } from './support';

/**
 * gaulatti/alcantara#224: the access capabilities. Each forwards the caller's
 * own credential to Pompeii through AccessService with via_client `mcp`;
 * Pompeii makes every decision, and the registry asks it again before every
 * A and D action. There is no token creation and no token value or display
 * prefix anywhere in an answer: tokens are listed by an explicit field list.
 * The text people entered (a token's or role's name, an email, a history
 * target) travels under `untrusted`.
 */

const permission = ALCANTARA_PERMISSIONS.access;
/** Keys of access answers that hold text people (or Pompeii's admins) entered. */
const UNTRUSTED = ['user_email', 'actor_email', 'target', 'role_name'] as const;

const tokenIdArg = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'token_id is the id from list_my_tokens');
const idArg = z.number().int().positive();

const CODES: Record<AccessError['code'], [McpErrorCode, string]> = {
  unauthenticated: [
    'forbidden',
    'Pompeii did not accept this credential for access management: sign in to manage access; a personal access token cannot.',
  ],
  forbidden: ['forbidden', 'Pompeii does not allow this for your account.'],
  invalid_request: ['invalid', 'Pompeii refused the request as invalid.'],
  tokens_off: ['conflict', 'The token switch is off.'],
  not_found: ['not_found', 'Pompeii has no such record.'],
  access_unavailable: [
    'unavailable',
    'Access management is not available yet; try again later.',
  ],
};

/** Runs an access call and reports Pompeii's refusals as MCP codes. */
async function viaAccess<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccessError)
      throw new McpToolError(...CODES[error.code]);
    throw error;
  }
}

/** A token as an MCP client may see it: never its value, never its prefix. */
const redact = (token: AccessToken) => ({
  id: token.id,
  name: token.name,
  permissions: token.permissions,
  created_at: token.created_at,
  expires_at: token.expires_at,
  last_used_at: token.last_used_at,
  created_via_application: token.created_via_application,
  last_used_application: token.last_used_application,
});

const SIGNED_IN = 'You must be signed in (not a personal access token).';

@Injectable()
@McpToolProvider()
export class AccessMcpTools {
  constructor(private readonly access: AccessService) {}

  /** The caller's own Authorization header, forwarded to Pompeii as received. */
  private bearer(ctx: McpContext): string {
    if (!ctx.bearer)
      throw new McpToolError('unavailable', 'No credential to forward.');
    return ctx.bearer;
  }

  private async roles(ctx: McpContext): Promise<AccessRole[]> {
    return (await this.access.listRoles(this.bearer(ctx), 'mcp')).roles;
  }

  private async grants(ctx: McpContext): Promise<AccessGrant[]> {
    return (await this.access.listGrants(this.bearer(ctx), 'mcp')).grants;
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'list_my_tokens',
        title: 'List my tokens',
        description: `Lists your own personal access tokens for this application: id, name, permissions, when created and last used, and in which application. Never a token value. ${SIGNED_IN}`,
        permission,
        shape: {},
        run: async (_args, ctx) =>
          viaAccess(async () => ({
            tokens: (
              await this.access.listTokens(this.bearer(ctx), 'mcp')
            ).tokens.map(redact),
          })),
      }),
      actionSpec({
        name: 'revoke_my_token',
        title: 'Revoke my token',
        description: `Revokes one of your own personal access tokens (id from list_my_tokens); it stops on its next use. ${SIGNED_IN}`,
        permission,
        tier: 'W',
        shape: { token_id: tokenIdArg },
        id: (args) => args.token_id,
        plan: (args) => ({
          summary: `Revoke your token ${args.token_id}; it stops on its next use.`,
          affects: [{ kind: 'token', id: args.token_id, name: args.token_id }],
          recoverable: false,
        }),
        run: (args, _loaded, ctx) =>
          viaAccess(() =>
            this.access.revokeToken(this.bearer(ctx), 'mcp', args.token_id),
          ),
      }),
      readSpec({
        name: 'get_token_switch',
        title: 'Get the token switch',
        description: `Reports whether this application accepts personal access tokens at all. ${SIGNED_IN}`,
        permission,
        shape: {},
        run: (_args, ctx) =>
          viaAccess(() => this.access.getTokenSwitch(this.bearer(ctx), 'mcp')),
      }),
      actionSpec({
        name: 'set_token_switch',
        title: 'Set the token switch',
        description: `Turns acceptance of personal access tokens on or off for this application; off refuses every token on its next call. Needs the manage permission in Pompeii. ${SIGNED_IN}`,
        permission,
        tier: 'A',
        shape: { enabled: z.boolean() },
        load: (_args, ctx) =>
          viaAccess(() => this.access.getTokenSwitch(this.bearer(ctx), 'mcp')),
        id: () => 'token-switch',
        label: (args, loaded) =>
          `token switch ${loaded.enabled ? 'on' : 'off'} to ${args.enabled ? 'on' : 'off'}`,
        plan: (args, loaded) => ({
          summary: `Turn the token switch ${args.enabled ? 'on' : 'off'} (now ${loaded.enabled ? 'on' : 'off'}).`,
          affects: [
            { kind: 'token-switch', id: 'token-switch', name: 'token switch' },
          ],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          viaAccess(() =>
            this.access.setTokenSwitch(this.bearer(ctx), 'mcp', args.enabled),
          ),
      }),
      readSpec({
        name: 'list_access_roles',
        title: 'List access roles',
        description: `Lists this application's roles and the permissions each carries. ${SIGNED_IN}`,
        permission,
        shape: {},
        untrusted: UNTRUSTED,
        run: (_args, ctx) =>
          viaAccess(() => this.access.listRoles(this.bearer(ctx), 'mcp')),
      }),
      readSpec({
        name: 'list_grants',
        title: 'List access grants',
        description: `Lists who holds which of this application's roles (grant id, user id, email, role). ${SIGNED_IN}`,
        permission,
        shape: {},
        untrusted: UNTRUSTED,
        run: (_args, ctx) =>
          viaAccess(() => this.access.listGrants(this.bearer(ctx), 'mcp')),
      }),
      actionSpec({
        name: 'grant_role',
        title: 'Grant a role',
        description: `Grants one of this application's roles to a person by Pompeii user id. You can only grant a role whose every permission you hold. Needs the manage permission in Pompeii. ${SIGNED_IN}`,
        permission,
        tier: 'D',
        shape: { user_id: idArg, role_id: idArg },
        untrusted: UNTRUSTED,
        load: async (args, ctx) =>
          viaAccess(async () => ({
            role: (await this.roles(ctx)).find(
              (candidate) => candidate.id === args.role_id,
            ),
          })),
        id: (args) => `${args.user_id}:${args.role_id}`,
        label: (args, loaded) =>
          `grant role ${args.role_id} (${loaded.role ? 'known' : 'unknown'}) to user ${args.user_id}`,
        plan: (args, loaded) => ({
          summary: `Grant role ${args.role_id}${loaded.role ? ` with ${loaded.role.permissions.length} permission(s)` : ' (not in this application)'} to user ${args.user_id}.`,
          affects: [
            {
              kind: 'grant',
              id: `${args.user_id}:${args.role_id}`,
              name: `role ${args.role_id}`,
            },
          ],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          viaAccess(() =>
            this.access.grant(this.bearer(ctx), 'mcp', {
              user_id: args.user_id,
              role_id: args.role_id,
            }),
          ),
      }),
      actionSpec({
        name: 'revoke_role',
        title: 'Revoke a role grant',
        description: `Revokes one grant (id from list_grants), taking that role from that person. You can only revoke a role whose every permission you hold. Needs the manage permission in Pompeii. ${SIGNED_IN}`,
        permission,
        tier: 'D',
        shape: { grant_id: idArg },
        load: async (args, ctx) => {
          const grant = (await viaAccess(() => this.grants(ctx))).find(
            (candidate) => candidate.id === args.grant_id,
          );
          if (!grant) throw new McpToolError('not_found', 'No such grant.');
          return grant;
        },
        id: (args) => String(args.grant_id),
        label: (args, grant) =>
          `revoke grant ${args.grant_id} (role ${grant.role_id}, user ${grant.user_id})`,
        plan: (args, grant) => ({
          summary: `Revoke grant ${args.grant_id}: role ${grant.role_id} from user ${grant.user_id}.`,
          affects: [
            {
              kind: 'grant',
              id: String(args.grant_id),
              name: `role ${grant.role_id} of user ${grant.user_id}`,
            },
          ],
          recoverable: true,
        }),
        run: (args, _grant, ctx) =>
          viaAccess(() =>
            this.access.revokeGrant(this.bearer(ctx), 'mcp', args.grant_id),
          ),
      }),
      readSpec({
        name: 'list_access_history',
        title: 'List access history',
        description: `Lists recent access changes for this application, newest first: when, what, who, and whether from the console or an MCP client. ${SIGNED_IN}`,
        permission,
        shape: {
          limit: z.number().int().min(1).max(200).optional(),
          before: z.string().max(40).optional(),
        },
        untrusted: UNTRUSTED,
        run: (args, ctx) =>
          viaAccess(() =>
            this.access.listHistory(this.bearer(ctx), 'mcp', {
              limit: args.limit,
              before: args.before,
            }),
          ),
      }),
    ];
  }
}
