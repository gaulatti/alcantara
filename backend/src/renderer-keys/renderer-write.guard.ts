import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import {
  authorizeBearer,
  type AuthorizedRequest,
} from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { Public } from '../auth/public.decorator';
import { TestAuthService } from '../auth/test-auth.service';
import type { RendererWriteEndpoint } from '../observability/managed-metrics.service';
import { RendererAuthService } from './renderer-auth.service';

const RENDERER_WRITE_KEY = 'rendererWriteEndpoint';

type WriteRequest = AuthorizedRequest & {
  headers: { authorization?: string; 'x-renderer-key'?: string | string[] };
  params: { programId: string };
};

/**
 * A program write the on-air renderer page makes (gaulatti/alcantara#884): a signed-in session with program.operate,
 * or this program's renderer key (or the shared key until it is removed). A presented credential that fails is refused.
 * A request with no credential is still accepted, counted and logged with its program until that is refused too.
 */
@Injectable()
export class RendererWriteGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly pompeii: PompeiiService,
    private readonly renderer: RendererAuthService,
    @Optional() private readonly testAuth?: TestAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const endpoint = this.reflector.get<RendererWriteEndpoint>(
      RENDERER_WRITE_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<WriteRequest>();
    const { programId } = request.params;
    if (request.headers.authorization) {
      try {
        await authorizeBearer(
          request,
          ALCANTARA_PERMISSIONS.program.operate,
          this.pompeii,
          this.testAuth,
        );
      } catch (error) {
        this.renderer.recordSession(endpoint, 'refused');
        throw error;
      }
      this.renderer.recordSession(endpoint, 'accepted');
      return true;
    }
    const key = request.headers['x-renderer-key'];
    if (key !== undefined) {
      await this.renderer.authorizeProgram(
        endpoint,
        // A repeated header arrives as a list, which matches no key.
        String(key),
        programId,
      );
      return true;
    }
    this.renderer.acceptUncredentialed(endpoint, programId);
    return true;
  }
}

/** Marks a program write the renderer page makes, checked by {@link RendererWriteGuard} instead of the sign-in guard. */
export const RendererWrite = (endpoint: RendererWriteEndpoint) =>
  applyDecorators(
    Public(),
    SetMetadata(RENDERER_WRITE_KEY, endpoint),
    UseGuards(RendererWriteGuard),
  );
