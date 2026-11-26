import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ProgramTeamAccess } from './program-team-access';

type ProgramRequest = {
  method?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  routeOptions?: { url?: string };
  user?: { authorization?: { teamId?: number } };
};

/** Routes that name no program and act on `main`. */
const MAIN_PROGRAM_ROUTES = new Set([
  '/program/activate',
  '/program/off-air',
  '/program/song/off-air',
  '/program/reload',
]);
/** Routes whose program id may be left out, and then means `main`. */
const DEFAULTS_TO_MAIN = new Set([
  '/auth/realtime-ticket',
  '/instants',
  '/instants/:instantId/play',
  '/instants/stop-all',
]);
/** Creating a program names one that does not exist yet. */
const NAMES_A_NEW_PROGRAM = new Set(['/program']);

/** The programs a request acts on: its path, query and body ids, and the implicit `main`. */
export function programIdsOf(request: ProgramRequest): string[] {
  const route = request.routeOptions?.url ?? '';
  const body =
    request.body && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};
  const named = [
    request.params?.programId,
    request.query?.programId,
    request.method === 'POST' && NAMES_A_NEW_PROGRAM.has(route)
      ? undefined
      : body.programId,
  ].filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  if (
    MAIN_PROGRAM_ROUTES.has(route) ||
    (DEFAULTS_TO_MAIN.has(route) && named.length === 0)
  ) {
    named.push('main');
  }
  return [...new Set(named)];
}

/**
 * Program routes act only on the caller's team's programs (gaulatti/alcantara#122). An interceptor, so it runs after
 * every guard, whatever the module order, and so after authentication has set the caller's team. A request with no
 * authenticated team (a public or ticket route) is not checked here.
 */
@Injectable()
export class ProgramTeamInterceptor implements NestInterceptor {
  constructor(private readonly access: ProgramTeamAccess) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<ProgramRequest>();
    const teamId = request.user?.authorization?.teamId;
    if (typeof teamId !== 'number') return next.handle();
    // Together, so that during a database blip a request waits at most one lookup timeout.
    const allowed = await Promise.all(
      programIdsOf(request).map((programId) =>
        this.access.allows(programId, teamId),
      ),
    );
    if (allowed.includes(false)) {
      throw new NotFoundException('Program not found');
    }
    return next.handle();
  }
}
