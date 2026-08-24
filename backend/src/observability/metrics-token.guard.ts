import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

type MetricsRequest = { headers: { authorization?: string } };

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const tokenPath =
      this.config.get<string>('METRICS_TOKEN_FILE') ??
      '/run/secrets/alcantara-metrics-token';
    let expected: string;
    try {
      expected = readFileSync(tokenPath, 'utf8').trim();
    } catch {
      throw new ServiceUnavailableException(
        'Metrics scrape credential unavailable',
      );
    }
    if (!expected) {
      throw new ServiceUnavailableException(
        'Metrics scrape credential unavailable',
      );
    }

    const request = context.switchToHttp().getRequest<MetricsRequest>();
    const supplied = request.headers.authorization ?? '';
    const expectedBuffer = Buffer.from(`Bearer ${expected}`);
    const suppliedBuffer = Buffer.from(supplied);
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Metrics bearer token required');
    }
    return true;
  }
}
