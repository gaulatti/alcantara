import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import {
  ManagedMetricsService,
  type RendererAuthEndpoint,
  type RendererWriteEndpoint,
} from '../observability/managed-metrics.service';
import { RendererKeyService } from './renderer-key.service';

function sameSecret(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The calls endpoints' renderer credential (gaulatti/alcantara#884). A program endpoint takes that program's own key;
 * another program's key is refused. The one cross-program call takes the fleet key. The shared key is still accepted
 * everywhere until it is removed, and each acceptance is counted and logged with its program, so its last use shows.
 * No key's value is ever logged.
 */
@Injectable()
export class RendererAuthService {
  private readonly logger = new Logger(RendererAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly keys: RendererKeyService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async authorizeProgram(
    endpoint: RendererAuthEndpoint,
    presented: string | undefined,
    programId: string,
  ): Promise<void> {
    const match = await this.keys.match(presented, programId);
    if (match === 'program') {
      this.metrics.recordRendererAuth(endpoint, 'program', 'accepted');
      return;
    }
    if (match === 'other-program') {
      this.metrics.recordRendererAuth(endpoint, 'program', 'refused');
      throw new ForbiddenException('This renderer key is for another program.');
    }
    if (this.isShared(presented)) {
      this.metrics.recordRendererAuth(endpoint, 'shared', 'accepted');
      this.logger.warn(`Shared renderer key accepted for program ${programId} on ${endpoint}`);
      return;
    }
    this.metrics.recordRendererAuth(endpoint, 'none', 'refused');
    throw new UnauthorizedException('Renderer credential required.');
  }

  /** The cross-program router list: the fleet key, or the shared key until it is removed. A program key is refused. */
  authorizeFleet(presented: string | undefined): void {
    if (sameSecret(presented, this.config.get<string>('WEBRTC_FLEET_KEY'))) {
      this.metrics.recordRendererAuth('return_routers', 'fleet', 'accepted');
      return;
    }
    if (this.isShared(presented)) {
      this.metrics.recordRendererAuth('return_routers', 'shared', 'accepted');
      this.logger.warn('Shared renderer key accepted on return_routers');
      return;
    }
    this.metrics.recordRendererAuth('return_routers', 'none', 'refused');
    throw new UnauthorizedException('Renderer credential required.');
  }

  /** A program write's signed-in session check, counted by its result. */
  recordSession(endpoint: RendererWriteEndpoint, result: 'accepted' | 'refused'): void {
    this.metrics.recordRendererAuth(endpoint, 'session', result);
  }

  /** A program write with no credential, still accepted until that is refused: counted and logged with its program. */
  acceptUncredentialed(endpoint: RendererWriteEndpoint, programId: string): void {
    this.metrics.recordRendererAuth(endpoint, 'none', 'accepted');
    this.logger.warn(`Uncredentialed ${endpoint} accepted for program ${programId}`);
  }

  private isShared(presented: string | undefined): boolean {
    return sameSecret(presented, this.config.get<string>('WEBRTC_RENDERER_KEY'));
  }
}
