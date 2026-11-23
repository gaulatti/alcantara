import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ActorContext } from './actor-context';

type ActorRequest = { user?: { sub?: unknown; principalId?: unknown } };

/**
 * Runs an authenticated console request's handler inside its ActorContext
 * (gaulatti/alcantara#213). It is an interceptor, not part of the guard,
 * because a guard returns before the handler runs and cannot wrap it; it runs
 * after every guard, so it adds attribution and cannot change an
 * authorization decision. Requests the guard did not authenticate (public
 * routes) carry no actor.
 */
@Injectable()
export class ActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest<ActorRequest>().user;
    if (!user || typeof user.sub !== 'string' || !user.sub) {
      return next.handle();
    }
    const principalId =
      typeof user.principalId === 'string' && user.principalId
        ? user.principalId
        : null;
    return new Observable((subscriber) => {
      const scope = ActorContext.open({
        principalId,
        via: 'console',
        client: null,
      });
      const inner = ActorContext.within(scope, () =>
        next.handle().subscribe(subscriber),
      );
      return () => {
        ActorContext.close(scope);
        inner.unsubscribe();
      };
    });
  }
}
