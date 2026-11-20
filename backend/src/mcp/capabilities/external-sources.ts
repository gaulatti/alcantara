import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import {
  ExternalSourcesService,
  type SourceAuthorization,
} from '../../external-sources/external-sources.service';
import {
  McpToolProvider,
  type McpContext,
  type McpToolSpec,
} from '../contract';
import { ProgramService } from '../../program/program.service';
import { actionSpec, present, readSpec } from './support';
import { whyNot } from './on-air';

const permissions = ALCANTARA_PERMISSIONS.webrtc;

const sourceIdArg = z.string().trim().min(1).max(64);
const nameArg = z.string().trim().min(1).max(120);
const programIdsArg = z.array(z.string().trim().min(1).max(128)).min(1).max(16);
const transportArg = z.enum(['rtmp', 'whip', 'hls', 'srt']);
const normalizationArg = z.enum(['720p30', '1080p30', 'passthrough']);
/** HLS and SRT sources carry their address; push sources carry nothing. */
const transportConfigArg = z.object({ url: z.string().max(2048) }).strict();
const LIFECYCLES = [
  'unconfigured',
  'provisioning',
  'waiting',
  'connected',
  'degraded',
  'reconnecting',
  'offline',
  'revoked',
] as const;
const HEALTH = ['unknown', 'healthy', 'degraded', 'unavailable'] as const;

interface Source {
  id: string;
  name: string;
  transport: string;
  lifecycle: string;
  health: string;
  revokedAt: Date | null;
  programIds: string[];
}

interface ProgramWithScenes {
  programId: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  scenes: Array<{
    sceneId: number;
    scene: { externalSourceId?: string | null };
  }>;
}

/** A source is shown by its state; the confirm changes when the state does. */
const stateOf = (source: Source): string =>
  `${source.name} (${source.lifecycle}/${source.health}${source.revokedAt ? ', revoked' : ''})`;

/**
 * The answer of a create without the credential: a push source (rtmp, whip)
 * is created with a credential the service returns once; it is never returned
 * here, only that it was issued.
 */
function withoutCredential(raw: unknown): unknown {
  const { credential, ...source } = raw as {
    credential?: { version: number };
  } & Record<string, unknown>;
  return credential
    ? {
        ...source,
        credentialIssued: true,
        credentialWithheld:
          'The credential of a push source is shown once, in the console; it is not returned here.',
      }
    : source;
}

/**
 * gaulatti/alcantara#219: the external source capabilities (live feeds from
 * outside: RTMP, WHIP, HLS and SRT). A source answers with its state and
 * programs, never its transport address or credential; the route that rotates
 * a credential is not a capability (appendix A: it returns a credential), and
 * creating a push source answers without the credential it issues.
 *
 * Step 0 of external_source_revoke: the console revokes every credential of
 * the source, marks it revoked and unavailable and clears its ingress and
 * participant, whatever is on air; a scene that points at the source (its
 * externalSourceId) keeps pointing at it and shows nothing. A revoked source
 * is never restored (there is no route for it): a new source must be created.
 * This capability refuses with on_air while a scene that points at the source
 * is on air or staged on any program.
 */
@Injectable()
@McpToolProvider()
export class ExternalSourcesMcpTools {
  constructor(
    private readonly sources: ExternalSourcesService,
    private readonly pompeii: PompeiiService,
    private readonly programs: ProgramService,
  ) {}

  private authorization(ctx: McpContext): SourceAuthorization {
    return {
      teamId: this.pompeii.teamId,
      permissions: [...ctx.principal.permissions],
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'external_source_list',
        title: 'List external sources',
        description:
          'Lists the external sources of the team (name, transport, lifecycle, health, programs, credential version), active ones first.',
        permission: permissions.read,
        shape: {},
        run: (_args, ctx) => this.sources.list(this.authorization(ctx)),
      }),
      readSpec({
        name: 'external_source_get',
        title: 'Read an external source',
        description:
          'Reads one external source: transport, lifecycle, health, programs, credential version, ingress and participant identity.',
        permission: permissions.read,
        shape: { source_id: sourceIdArg },
        run: (args, ctx) =>
          this.sources.get(args.source_id, this.authorization(ctx)),
      }),
      actionSpec<
        {
          name: typeof nameArg;
          transport: typeof transportArg;
          transport_config: z.ZodOptional<typeof transportConfigArg>;
          program_ids: typeof programIdsArg;
          normalization_profile: z.ZodOptional<typeof normalizationArg>;
        },
        Source[]
      >({
        name: 'external_source_create',
        title: 'Create an external source',
        description:
          'Creates an external source of the team for one to 16 programs. HLS and SRT sources need transport_config {url}; push sources (RTMP, WHIP) take none and are issued a credential that is never returned here: the answer says credentialIssued and the credential is rotated and read in the console. The team has a quota of active sources.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          name: nameArg,
          transport: transportArg,
          transport_config: transportConfigArg.optional(),
          program_ids: programIdsArg,
          normalization_profile: normalizationArg.optional(),
        },
        load: async (_args, ctx) =>
          (await this.sources.list(this.authorization(ctx))) as Source[],
        id: () => 'new-external-source',
        label: (args, listed) =>
          `${args.transport} sources:${listed.filter((source) => !source.revokedAt).length}`,
        plan: (args, listed) => ({
          summary: `Creates a ${args.transport} external source for ${args.program_ids.length} program(s) (${listed.filter((source) => !source.revokedAt).length} active source(s) of the team now, against its quota).${args.transport === 'rtmp' || args.transport === 'whip' ? ' A push credential is issued and NOT returned: it cannot be read here, so the source cannot be connected until its credential is rotated in the console.' : ' The address is checked (HTTPS or SRT, no user name, public address) and stored encrypted.'}`,
          affects: args.program_ids.map((id) => ({
            kind: 'program',
            id,
            name: id,
          })),
          recoverable: true,
        }),
        run: (args, _listed, ctx) =>
          this.sources.create(
            ctx.principal.subject,
            present({
              name: args.name,
              transport: args.transport,
              transportConfig: args.transport_config,
              programIds: args.program_ids,
              normalizationProfile: args.normalization_profile,
            }),
            this.authorization(ctx),
          ),
        result: withoutCredential,
      }),
      actionSpec({
        name: 'external_source_update',
        title: 'Update an external source',
        description:
          'Changes the name, programs, normalization profile or transport address of an external source; only the fields given change. The transport cannot change, and a revoked source is refused with conflict.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          source_id: sourceIdArg,
          name: nameArg.optional(),
          transport: transportArg.optional(),
          transport_config: transportConfigArg.optional(),
          program_ids: programIdsArg.optional(),
          normalization_profile: normalizationArg.optional(),
        },
        load: (args, ctx) =>
          this.sources.get(
            args.source_id,
            this.authorization(ctx),
          ) as Promise<Source>,
        id: (args) => args.source_id,
        label: (_args, source) => stateOf(source),
        plan: (args, source) => {
          const fields = [
            'name',
            'transport',
            'transport_config',
            'program_ids',
            'normalization_profile',
          ].filter(
            (key) => (args as Record<string, unknown>)[key] !== undefined,
          );
          return {
            summary: `Changes ${fields.join(', ') || 'nothing'} of external source ${source.id} (${source.lifecycle}, ${source.health}). The previous values are not kept: read the source first to restore them.${source.lifecycle === 'connected' ? ' It is connected now: a changed address or program list applies to the live feed.' : ''}`,
            affects: [
              { kind: 'external_source', id: source.id, name: source.name },
            ],
            recoverable: true,
          };
        },
        run: (args, _source, ctx) =>
          this.sources.update(
            args.source_id,
            present({
              name: args.name,
              transport: args.transport,
              transportConfig: args.transport_config,
              programIds: args.program_ids,
              normalizationProfile: args.normalization_profile,
            }),
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'external_source_redirect',
        title: 'Check a redirect address of a pull source',
        description:
          'Checks whether an address is allowed as a redirect of an HLS or SRT source (scheme, no user name, a public address). It changes nothing and answers a fingerprint of the address.',
        permission: permissions.operate,
        tier: 'A',
        shape: { source_id: sourceIdArg, url: z.string().max(2048) },
        load: (args, ctx) =>
          this.sources.get(
            args.source_id,
            this.authorization(ctx),
          ) as Promise<Source>,
        id: (args) => args.source_id,
        label: (_args, source) => stateOf(source),
        plan: (_args, source) => ({
          summary: `Checks the address against the rules of ${source.transport} source ${source.id}; it resolves the host name and changes nothing.`,
          affects: [
            { kind: 'external_source', id: source.id, name: source.name },
          ],
          recoverable: true,
        }),
        run: (args, _source, ctx) =>
          this.sources.validateRedirect(
            args.source_id,
            args.url,
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'external_source_reconcile',
        title: 'Record the state of an external source',
        description:
          'Records the lifecycle and health an external source reports (and its ingress and participant identity). Lifecycle "revoked" is refused with forbidden: use external_source_revoke. A revoked source is refused with conflict.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          source_id: sourceIdArg,
          lifecycle: z.enum(LIFECYCLES),
          health: z.enum(HEALTH),
          ingress_id: z.string().max(255).nullable().optional(),
          participant_identity: z.string().max(255).nullable().optional(),
        },
        load: (args, ctx) =>
          this.sources.get(
            args.source_id,
            this.authorization(ctx),
          ) as Promise<Source>,
        id: (args) => args.source_id,
        label: (_args, source) => stateOf(source),
        plan: (args, source) => ({
          summary: `Records external source ${source.id} as ${args.lifecycle}/${args.health} (now ${source.lifecycle}/${source.health}). The recorded state is what the console shows and what scenes read; it does not touch the feed itself.`,
          affects: [
            { kind: 'external_source', id: source.id, name: source.name },
          ],
          recoverable: true,
        }),
        run: (args, _source, ctx) =>
          this.sources.reconcile(
            args.source_id,
            {
              lifecycle: args.lifecycle,
              health: args.health,
              ingressId: args.ingress_id,
              participantIdentity: args.participant_identity,
            },
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'external_source_revoke',
        title: 'Revoke an external source',
        description:
          'Revokes an external source: every credential is revoked and the source ends as revoked and unavailable. It is never restored; a new source must be created. Refused with on_air while a scene that points at the source is on air or staged on a program.',
        permission: permissions.operate,
        tier: 'D',
        shape: { source_id: sourceIdArg },
        load: async (args, ctx) => {
          const source = (await this.sources.get(
            args.source_id,
            this.authorization(ctx),
          )) as Source;
          const listed =
            (await this.programs.listPrograms()) as unknown as ProgramWithScenes[];
          const points = (program: ProgramWithScenes) =>
            program.scenes
              .filter((entry) => entry.scene.externalSourceId === source.id)
              .map((entry) => entry.sceneId);
          const live = (program: ProgramWithScenes) =>
            points(program).some(
              (sceneId) =>
                sceneId === program.activeSceneId ||
                sceneId === program.stagedSceneId,
            );
          return {
            source,
            usedBy: listed
              .filter((program) => points(program).length > 0)
              .map((program) => program.programId),
            onAirIn: listed.filter(live).map((program) => program.programId),
          };
        },
        id: (args) => args.source_id,
        label: (_args, { source }) => stateOf(source),
        plan: (_args, { source, usedBy, onAirIn }) => ({
          summary: `Revokes external source ${source.id} (${source.lifecycle}, ${source.health}${source.revokedAt ? ', already revoked' : ''}): its credentials stop working and it ends revoked and unavailable. ${usedBy.length} program(s) have a scene that points at it (${usedBy.join(', ') || 'none'}); those scenes keep pointing at it and show nothing. The console revokes it even when such a scene is on air; this capability refuses while one is on air or staged (${onAirIn.length} now). A revoked source cannot be restored: a new source must be created and its scenes pointed at it.`,
          affects: [
            { kind: 'external_source', id: source.id, name: source.name },
            ...usedBy.map((id) => ({ kind: 'program', id, name: id })),
          ],
          recoverable: false,
        }),
        refuse: (_args, { source, onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `a scene that points at external source ${source.id} is on air or staged on program(s) ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args, _loaded, ctx) =>
          this.sources.revoke(args.source_id, this.authorization(ctx)),
      }),
    ];
  }
}
