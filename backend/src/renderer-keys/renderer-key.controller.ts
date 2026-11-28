import { Controller, Get, Header, Param, Post } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { RendererKeyService } from './renderer-key.service';

/** What a rotation's operator change record may say: the key is named, never valued; its version is valued. */
const ROTATION_FIELDS = { named: ['rendererKey'], valued: ['version'] } as const;

/** A program's renderer key (gaulatti/alcantara#884), issued and rotated by its operators. */
@Controller('program/:programId/renderer-key')
export class RendererKeyController {
  constructor(
    private readonly keys: RendererKeyService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

  /** Whether the program has a key, its version and when it was issued, rotated and last used. Never the key. */
  @Get()
  @RequirePermission(ALCANTARA_PERMISSIONS.program.read)
  @Header('Cache-Control', 'no-store')
  metadata(@Param('programId') programId: string) {
    return this.keys.metadata(programId);
  }

  /** Issues or replaces the program's key. The answer carries the key this once; it is never shown again. */
  @Post('rotate')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  @Header('Cache-Control', 'no-store')
  async rotate(@Param('programId') programId: string) {
    const actor = this.recorder.actor();
    const { key, metadata, previousVersion } = await this.keys.rotate(programId);
    await this.recorder.record({
      actor,
      target: 'program',
      targetId: programId,
      programId,
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
    return { ...metadata, key };
  }
}
