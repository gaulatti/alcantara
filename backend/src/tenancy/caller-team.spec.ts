import { ForbiddenException } from '@nestjs/common';
import { callerTeam } from './caller-team';

describe('callerTeam', () => {
  it('returns the team the guard resolved, 0 included', () => {
    expect(callerTeam({ user: { authorization: { teamId: 1 } } })).toBe(1);
    expect(callerTeam({ user: { authorization: { teamId: 0 } } })).toBe(0);
  });

  it.each([
    {},
    { user: {} },
    { user: { authorization: {} } },
    { user: { authorization: { teamId: undefined } } },
  ])('refuses a request without one with 403, %j', (request) => {
    expect(() => callerTeam(request)).toThrow(ForbiddenException);
  });
});
