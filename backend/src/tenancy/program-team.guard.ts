import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
/** Routes whose program id may be left out of the body, and then means `main`. */
const BODY_DEFAULTS_TO_MAIN = new Set(['/auth/realtime-ticket']);
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
    (BODY_DEFAULTS_TO_MAIN.has(route) && named.length === 0)
  ) {
    named.push('main');
  }
  return [...new Set(named)];
}

/**
 * Program routes act only on the caller's team's programs (gaulatti/alcantara#122). It runs after authentication:
 * a request with no authenticated team (a public or ticket route) is not checked here.
 */
@Injectable()
export class ProgramTeamGuard implements CanActivate {
  constructor(private readonly access: ProgramTeamAccess) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<ProgramRequest>();
    const teamId = request.user?.authorization?.teamId;
    if (typeof teamId !== 'number') return true;
    for (const programId of programIdsOf(request)) {
      if (!(await this.access.allows(programId, teamId))) {
        throw new NotFoundException('Program not found');
      }
    }
    return true;
  }
}
