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
import { readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.webrtc;

const sourceIdArg = z.string().trim().min(1).max(64);

/**
 * gaulatti/alcantara#219: the external source capabilities (live feeds from
 * outside: RTMP, WHIP, HLS and SRT). A source answers with its state and
 * programs, never its transport address or credential; the route that rotates
 * a credential is not a capability (appendix A: it returns a credential).
 */
@Injectable()
@McpToolProvider()
export class ExternalSourcesMcpTools {
  constructor(
    private readonly sources: ExternalSourcesService,
    private readonly pompeii: PompeiiService,
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
    ];
  }
}
