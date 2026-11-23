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
  McpToolError,
  McpToolProvider,
  type McpContext,
  type McpToolSpec,
} from '../contract';
import { PrismaService } from '../../prisma.service';
import { actionSpec, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS;

const deviceClassArg = z.string().trim().min(1).max(32);
const DEVICE_CLASSES = ['desktop', 'tablet', 'phone'] as const;

/** The console profile, as the service reads it (it ignores what it does not know). */
const profileArg = z.object({
  workspace: z.enum(['director', 'audio', 'graphics', 'compact']).optional(),
  dockWidth: z.number().optional(),
  touchMode: z.boolean().optional(),
  shortcutsEnabled: z.boolean().optional(),
  selectedProgramId: z.string().trim().min(1).max(128),
  transitions: z.record(z.string().max(128), z.string().max(128)).optional(),
});

interface Saved {
  version: number;
}

interface Shared {
  id: string;
  name: string;
  version: number;
  scope: string;
  scopeId: string;
  retiredAt: Date | null;
}

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
    private readonly prisma: PrismaService,
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
      actionSpec({
        name: 'preference_publish',
        title: 'Publish a shared console layout',
        description:
          'Publishes your console profile as a shared layout for a program or the team, under a name. Publishing a name that exists replaces that layout (its version goes up and it is no longer retired). Needs layout.manage.',
        permission: permissions.layout.manage,
        tier: 'W',
        shape: {
          scope: z.enum(['program', 'team']),
          scope_id: z.string().trim().min(1).max(128),
          source_device_class: deviceClassArg,
          name: z.string().trim().min(1).max(120),
          description: z.string().max(500).nullable().optional(),
          profile: profileArg,
        },
        load: async (args, ctx) =>
          (await this.preferences.discover(
            args.scope,
            args.scope_id,
            this.authorization(ctx),
          )) as Shared[],
        id: (args) => `${args.scope}:${args.scope_id}`,
        plan: (args, listed) => {
          const same = listed.find((layout) => layout.name === args.name);
          return {
            summary: same
              ? `Replaces the shared layout "${args.name}" of ${args.scope} ${args.scope_id} (now version ${same.version}). Operators who load it from now on get the new profile; copies already loaded are not changed. The previous profile is not kept.`
              : `Publishes a new shared layout "${args.name}" for ${args.scope} ${args.scope_id}. Operators can discover and load it; nothing on air changes.`,
            affects: [
              {
                kind: 'shared_layout',
                id: same?.id ?? 'new-shared-layout',
                name: args.name,
              },
            ],
            recoverable: !same,
          };
        },
        run: (args, _listed, ctx) =>
          this.preferences.publish(
            identityOf(ctx),
            {
              scope: args.scope,
              scopeId: args.scope_id,
              sourceDeviceClass: args.source_device_class,
              name: args.name,
              description: args.description,
              profile: args.profile,
            },
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'preference_load',
        title: 'Load a shared layout into your console profile',
        description:
          'Copies a shared layout into your own console profile for its device class. version is the version of your saved profile (0 when none), so a profile saved meanwhile is refused with conflict.',
        permission: permissions.access,
        tier: 'W',
        shape: {
          layout_id: z.string().trim().min(1).max(128),
          device_class: deviceClassArg,
          version: z.number().int().min(0),
        },
        load: (args, ctx) =>
          this.preferences.get(
            identityOf(ctx),
            args.device_class,
          ) as Promise<Saved>,
        id: (args) => args.layout_id,
        plan: (args, saved) => ({
          summary: `Replaces your ${args.device_class} console profile (saved version ${saved.version}) with the shared layout ${args.layout_id}; you asked from version ${args.version}${args.version === saved.version ? '' : ', which is not the saved version, so it will be refused with conflict'}. Your previous profile is not kept.`,
          affects: [
            {
              kind: 'console_profile',
              id: args.device_class,
              name: args.device_class,
            },
          ],
          recoverable: false,
        }),
        run: (args, _saved, ctx) =>
          this.preferences.load(
            identityOf(ctx),
            args.layout_id,
            { deviceClass: args.device_class, version: args.version },
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'preference_save',
        title: 'Save your console profile',
        description:
          'Saves your own console profile for a device class. version is the version you last read (0 for the first save); a stale version is refused with conflict and the answer carries the saved profile.',
        permission: permissions.access,
        tier: 'W',
        shape: {
          device_class: deviceClassArg,
          version: z.number().int().min(0),
          profile: profileArg,
        },
        load: (args, ctx) =>
          this.preferences.get(
            identityOf(ctx),
            args.device_class,
          ) as Promise<Saved>,
        id: (args) => args.device_class,
        plan: (args, saved) => ({
          summary: `Saves your ${args.device_class} console profile over saved version ${saved.version}; you asked from version ${args.version}${args.version === saved.version ? '' : ', which is not the saved version, so it will be refused with conflict'}. The previous profile is not kept.`,
          affects: [
            {
              kind: 'console_profile',
              id: args.device_class,
              name: args.device_class,
            },
          ],
          recoverable: false,
        }),
        run: (args, _saved, ctx) =>
          this.preferences.save(identityOf(ctx), args.device_class, {
            version: args.version,
            profile: args.profile,
          }),
      }),
      actionSpec({
        name: 'preference_retire',
        title: 'Retire a shared console layout',
        description:
          'Retires a shared layout: it is no longer listed or loadable. Copies operators already loaded stay as they are, and publishing the same name again brings the layout back. A layout is not an on-air object, so this is never refused as on_air. Needs layout.manage.',
        permission: permissions.layout.manage,
        tier: 'D',
        shape: { layout_id: z.string().trim().min(1).max(128) },
        load: async (args) => {
          const layout = (await this.prisma.sharedConsoleLayout.findUnique({
            where: { id: args.layout_id },
          })) as Shared | null;
          if (!layout)
            throw new McpToolError('not_found', 'Shared layout not found');
          return layout;
        },
        id: (args) => args.layout_id,
        label: (_args, layout) => `${layout.name} v${layout.version}`,
        plan: (_args, layout) => ({
          summary: `Retires shared layout "${layout.name}" (version ${layout.version}) of ${layout.scope} ${layout.scopeId}${layout.retiredAt ? ', which is already retired' : ''}. It stops being listed and cannot be loaded; copies already loaded stay. Recoverable: publishing the same name again restores it with the profile you publish.`,
          affects: [
            {
              kind: 'shared_layout',
              id: layout.id,
              name: layout.name,
            },
          ],
          recoverable: true,
        }),
        run: (args, _layout, ctx) =>
          this.preferences.retire(args.layout_id, this.authorization(ctx)),
      }),
      actionSpec({
        name: 'preference_reset_class',
        title: 'Reset your console profile for a device class',
        description:
          'Deletes your saved console profile for a device class, so the default profile applies again. It affects only you.',
        permission: permissions.access,
        tier: 'D',
        shape: { device_class: deviceClassArg },
        load: (args, ctx) =>
          this.preferences.get(
            identityOf(ctx),
            args.device_class,
          ) as Promise<Saved>,
        id: (args) => args.device_class,
        label: (_args, saved) => `version ${saved.version}`,
        plan: (args, saved) => ({
          summary:
            saved.version === 0
              ? `Nothing is saved for your ${args.device_class} profile; the default stays.`
              : `Deletes your saved ${args.device_class} console profile (version ${saved.version}); the default profile applies again. A profile is not kept anywhere else: it cannot be recovered.`,
          affects: [
            {
              kind: 'console_profile',
              id: args.device_class,
              name: args.device_class,
            },
          ],
          recoverable: saved.version === 0,
        }),
        run: (args, _saved, ctx) =>
          this.preferences.reset(identityOf(ctx), args.device_class),
      }),
      actionSpec({
        name: 'preference_reset_all',
        title: 'Reset all your console profiles',
        description:
          'Deletes every console profile you saved (desktop, tablet and phone), so the defaults apply again. It affects only you.',
        permission: permissions.access,
        tier: 'D',
        shape: {},
        load: async (_args, ctx) => {
          const saved: Record<string, number> = {};
          for (const deviceClass of DEVICE_CLASSES)
            saved[deviceClass] = (
              (await this.preferences.get(
                identityOf(ctx),
                deviceClass,
              )) as Saved
            ).version;
          return saved;
        },
        id: () => 'all',
        label: (_args, saved) =>
          DEVICE_CLASSES.map((c) => `${c} v${saved[c]}`).join(' '),
        plan: (_args, saved) => ({
          summary: `Deletes every saved console profile of yours (${DEVICE_CLASSES.map((c) => `${c} version ${saved[c]}`).join(', ')}); the defaults apply again. They are not kept anywhere else: they cannot be recovered.`,
          affects: DEVICE_CLASSES.filter((c) => saved[c] > 0).map((c) => ({
            kind: 'console_profile',
            id: c,
            name: c,
          })),
          recoverable: DEVICE_CLASSES.every((c) => saved[c] === 0),
        }),
        run: (_args, _saved, ctx) => this.preferences.reset(identityOf(ctx)),
      }),
    ];
  }
}
