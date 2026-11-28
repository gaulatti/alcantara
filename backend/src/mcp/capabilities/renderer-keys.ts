import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import {
  OperatorChangeRecorder,
  summarizeChange,
} from '../../operator-change/operator-change-recorder';
import { RendererKeyService } from '../../renderer-keys/renderer-key.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec } from './support';

/** What a rotation's operator change record may say: the key is named, never valued; its version is valued. */
const ROTATION_FIELDS = {
  named: ['rendererKey'],
  valued: ['version'],
} as const;

/**
 * A program's renderer key over MCP (gaulatti/alcantara#884): its metadata, and its rotation. The rotation never
 * returns the new key, so a key never lands in a client's transcript: it is shown only in the show's Renderer key panel
 * on Shows, once, at issue.
 */
@Injectable()
@McpToolProvider()
export class RendererKeysMcpTools {
  constructor(
    private readonly keys: RendererKeyService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'webrtc_renderer_key',
        title: "Read a program's renderer key",
        description:
          'Whether the program has a renderer key (the credential its return runner, contribution worker and program pages present), its version, and when it was issued, rotated and last used. Never the key or its hash.',
        permission: ALCANTARA_PERMISSIONS.program.read,
        shape: { program_id: programIdArg },
        run: (args) => this.keys.metadata(args.program_id),
      }),
      actionSpec({
        name: 'webrtc_rotate_renderer_key',
        title: "Rotate a program's renderer key",
        description:
          "Replaces the program's renderer key. The previous key stops working at once, so the machines that present it stop until they are given the new one. The new key is not returned here: it is shown only in the show's Renderer key panel on Shows in Alcántara, once. Use this to revoke a key; issue a key to hand out from that panel.",
        permission: ALCANTARA_PERMISSIONS.program.manage,
        tier: 'A',
        shape: { program_id: programIdArg },
        load: (args) => this.keys.metadata(args.program_id),
        id: (args) => args.program_id,
        label: () => 'Renderer key',
        plan: (args, metadata) => ({
          summary: metadata.exists
            ? `Replaces renderer key version ${metadata.version} of program ${args.program_id}: it stops working at once, and the new key is shown only in the show's Renderer key panel.`
            : `Issues the first renderer key of program ${args.program_id}; it is shown only in the show's Renderer key panel.`,
          affects: [
            { kind: 'program', id: args.program_id, name: 'Renderer key' },
          ],
          recoverable: false,
        }),
        run: async (args) => {
          const actor = this.recorder.actor();
          const { metadata, previousVersion } = await this.keys.rotate(
            args.program_id,
          );
          await this.recorder.record({
            actor,
            target: 'program',
            targetId: args.program_id,
            programId: args.program_id,
            capability: {
              mcp: 'webrtc_rotate_renderer_key',
              console: 'program.rotate-renderer-key',
            },
            summary: summarizeChange(
              ROTATION_FIELDS,
              { rendererKey: true, version: true },
              { version: previousVersion },
              { version: metadata.version },
            ),
          });
          return {
            programId: metadata.programId,
            version: metadata.version,
            rotatedAt: metadata.rotatedAt,
          };
        },
      }),
    ];
  }
}
