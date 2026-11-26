import { ForbiddenException } from '@nestjs/common';

/** A request as the authorization guard leaves it. */
export type TeamRequest = { user?: { authorization?: { teamId?: number } } };

/**
 * The team the guard resolved for the caller (gaulatti/alcantara#122). Every non-public request carries one; a request
 * without it is refused rather than read unscoped. `0` is "no team configured", which production refuses at startup.
 */
export function callerTeam(request: TeamRequest): number {
  const teamId = request.user?.authorization?.teamId;
  if (typeof teamId !== 'number') {
    throw new ForbiddenException({
      error: 'FORBIDDEN',
      reason: 'DENY_NO_TEAM',
    });
  }
  return teamId;
}
