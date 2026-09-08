import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable } from 'rxjs';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

@Injectable()
export class ExternalSourceMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: ManagedMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; url: string }>();
    const action = sourceAction(request.method, request.url);
    return next.handle().pipe(
      catchError((error: unknown) => {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number((error as { status: unknown }).status)
            : 500;
        this.metrics.recordExternalSource(
          action,
          status >= 400 && status < 500 ? 'rejected' : 'failure',
        );
        throw error;
      }),
    );
  }
}

function sourceAction(method: string, url: string): string {
  if (url.includes('/credentials/rotate')) return 'rotate';
  if (url.includes('/redirects/validate')) return 'redirect';
  if (url.includes('/reconcile')) return 'reconcile';
  if (method === 'POST') return 'create';
  if (method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'revoke';
  return 'read';
}
