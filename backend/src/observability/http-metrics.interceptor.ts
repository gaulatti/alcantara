import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ManagedMetricsService } from './managed-metrics.service';

type HttpRequest = { method: string; url: string };
type HttpResponse = { statusCode: number };

function routeGroup(request: HttpRequest): string {
  const path = request.url.split('?', 1)[0] ?? '';
  if (path === '/') return 'root';
  const segment = path.split('/').filter(Boolean)[0] ?? 'unknown';
  return segment === 'metrics' ? 'metrics' : segment;
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: ManagedMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const started = process.hrtime.bigint();
    const record = (status: number) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.metrics.recordHttp(
        request.method,
        routeGroup(request),
        status,
        seconds,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (error: unknown) =>
          record(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}
