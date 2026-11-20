import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import type { CanonicalIdentity } from '../../identity/principals';
import {
  OperatorPreferencesService,
  type OperatorAuthorization,
} from '../../operator-preferences/operator-preferences.service';
import {
  McpToolProvider,
  type McpContext,
  type McpToolSpec,
} from '../contract';
import { readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS;

const deviceClassArg = z.string().trim().min(1).max(32);

/** The identity the console's guard attaches to a request, from the caller. */
export const identityOf = (ctx: McpContext): CanonicalIdentity => ({
  subject: ctx.principal.subject,
  principalId: ctx.principal.principalId,
});

/**
 * gaulatti/alcantara#219: the operator preference capabilities. Preferences
 * belong to the caller (the subject or principal Pompeii resolved), exactly as
 * in the console: no capability reads or changes another operator's profile.
 * The authorization the service checks shared layouts against is the caller's
 * permissions and the application's team, as the console's guard builds it.
 */
@Injectable()
@McpToolProvider()
export class OperatorPreferencesMcpTools {
  constructor(
    private readonly preferences: OperatorPreferencesService,
    private readonly pompeii: PompeiiService,
  ) {}

  private authorization(ctx: McpContext): OperatorAuthorization {
    return {
      permissions: [...ctx.principal.permissions],
      teamId: this.pompeii.teamId,
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'preference_discover',
        title: 'List shared console layouts',
        description:
          'Lists the shared console layouts published for a program or for the team (name, description, source device class, version).',
        permission: permissions.access,
        shape: {
          scope: z.enum(['program', 'team']),
          scope_id: z.string().trim().min(1).max(128),
        },
        run: (args, ctx) =>
          this.preferences.discover(
            args.scope,
            args.scope_id,
            this.authorization(ctx),
          ),
      }),
      readSpec({
        name: 'preference_get',
        title: 'Read your console profile',
        description:
          'Reads your own console profile for a device class (desktop, tablet or phone); the default profile at version 0 when none is saved.',
        permission: permissions.access,
        shape: { device_class: deviceClassArg },
        run: (args, ctx) =>
          this.preferences.get(identityOf(ctx), args.device_class),
      }),
    ];
  }
}
