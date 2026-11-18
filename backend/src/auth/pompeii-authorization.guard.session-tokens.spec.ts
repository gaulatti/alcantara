import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import type { PompeiiService } from './pompeii.service';
import type { TestAuthService } from './test-auth.service';
import { ProgramController } from '../program/program.controller';

// The API accepts only interactive session tokens. Every credential below is a
// placeholder built in the test from repeated characters.

const accessTokenShaped = `pmp_pat_${'a'.repeat(43)}`;
const sessionToken = `${'e'.repeat(36)}.${'f'.repeat(120)}.${'g'.repeat(86)}`;

const allowed = {
  authenticated: true,
  allowed: true,
  reason: 'ALLOW',
  subject: 'subject-1',
  principalId: 'principal-1',
  effectivePermissions: ['alcantara:program:read'],
  roles: ['operator'],
};

function contextFor(
  handler: (...args: never[]) => unknown,
  controller: abstract new (...args: never[]) => unknown,
  authorization?: string,
): {
  context: ExecutionContext;
  request: { headers: { authorization?: string }; user?: unknown };
} {
  const request: { headers: { authorization?: string }; user?: unknown } = {
    headers: { authorization },
  };
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function build(testAuthEnabled = false) {
  const pompeii = {
    teamId: 7,
    authorize: jest.fn().mockResolvedValue(allowed),
    recordUnsupportedCredential: jest.fn(),
  };
  const testAuth = {
    isEnabled: jest.fn(() => testAuthEnabled),
    authorize: jest.fn().mockReturnValue(allowed),
  };
  const guard = new PompeiiAuthorizationGuard(
    new Reflector(),
    pompeii as unknown as PompeiiService,
    testAuth as unknown as TestAuthService,
  );
  return { guard, pompeii, testAuth };
}

const realtimeTicket = AuthController.prototype.issueRealtimeTicket;
const me = AuthController.prototype.getMe;

describe('PompeiiAuthorizationGuard session tokens', () => {
  it.each([
    ['Bearer', `Bearer ${accessTokenShaped}`],
    ['lowercase scheme', `bearer ${accessTokenShaped}`],
    ['extra whitespace', `  Bearer   ${accessTokenShaped}`],
    ['any length after the prefix', `Bearer pmp_pat_${'b'.repeat(7)}`],
    ['no scheme', accessTokenShaped],
  ])(
    'refuses an access token (%s) with 401 and makes no authorization call',
    async (_case, authorization) => {
      for (const testAuthEnabled of [false, true]) {
        const { guard, pompeii, testAuth } = build(testAuthEnabled);
        const { context, request } = contextFor(
          me,
          AuthController,
          authorization,
        );
        const failure = await guard
          .canActivate(context)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(UnauthorizedException);
        expect((failure as UnauthorizedException).getResponse()).toEqual({
          error: 'UNAUTHENTICATED',
          reason: 'DENY_UNSUPPORTED_CREDENTIAL',
        });
        expect(pompeii.authorize).not.toHaveBeenCalled();
        expect(testAuth.authorize).not.toHaveBeenCalled();
        expect(pompeii.recordUnsupportedCredential).toHaveBeenCalledTimes(1);
        expect(request.user).toBeUndefined();
      }
    },
  );

  it('does not issue a realtime ticket for an access token', async () => {
    const { guard, pompeii } = build();
    const { context } = contextFor(
      realtimeTicket,
      AuthController,
      `Bearer ${accessTokenShaped}`,
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(pompeii.authorize).not.toHaveBeenCalled();
  });

  it('still issues a realtime ticket for a session token, passing the header unchanged', async () => {
    const { guard, pompeii } = build();
    const header = `Bearer ${sessionToken}`;
    const { context, request } = contextFor(
      realtimeTicket,
      AuthController,
      header,
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(pompeii.authorize).toHaveBeenCalledTimes(1);
    expect(pompeii.authorize).toHaveBeenCalledWith(
      header,
      'alcantara:program:read',
    );
    expect(request.user).toMatchObject({ sub: 'subject-1' });
  });

  it.each([
    ['a session token', `Bearer ${sessionToken}`],
    ['a near-miss prefix', `Bearer pmp_pa_${'c'.repeat(43)}`],
    ['an uppercase prefix', `Bearer PMP_PAT_${'c'.repeat(43)}`],
    ['a different separator', `Bearer pmp-pat-${'c'.repeat(43)}`],
    ['the prefix later in the value', `Bearer x${accessTokenShaped}`],
  ])('passes %s to Pompeii byte for byte, as before', async (_case, header) => {
    const { guard, pompeii } = build();
    const { context } = contextFor(me, AuthController, header);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(pompeii.authorize).toHaveBeenCalledWith(header, 'alcantara:access');
  });

  it('passes a session token to test auth unchanged when test auth is on', async () => {
    const { guard, pompeii, testAuth } = build(true);
    const header = `Bearer ${sessionToken}`;
    const { context } = contextFor(me, AuthController, header);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(testAuth.authorize).toHaveBeenCalledWith(
      header,
      'alcantara:access',
      7,
    );
    expect(pompeii.authorize).not.toHaveBeenCalled();
  });

  it('keeps public routes public whatever the header carries', async () => {
    const { guard, pompeii } = build();
    const events = ProgramController.prototype.events;
    for (const authorization of [undefined, `Bearer ${accessTokenShaped}`]) {
      const { context } = contextFor(events, ProgramController, authorization);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
    expect(pompeii.authorize).not.toHaveBeenCalled();
  });

  it('still asks for a bearer when none is sent', async () => {
    const { guard } = build();
    const { context } = contextFor(me, AuthController);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Bearer token required',
    );
  });
});
