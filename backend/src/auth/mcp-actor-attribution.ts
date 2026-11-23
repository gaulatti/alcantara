import { Injectable } from '@nestjs/common';
import type { McpAttribution } from '../mcp/contract';
import { ActorContext } from './actor-context';

/** Bound under MCP_ATTRIBUTION: runs an MCP action inside its ActorContext. */
@Injectable()
export class McpActorAttribution implements McpAttribution {
  run<T>(
    actor: { principalId: string | null; via: 'mcp'; client: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return ActorContext.run(
      {
        principalId: actor.principalId,
        via: 'mcp',
        client: actor.client.slice(0, 64),
      },
      work,
    );
  }
}
