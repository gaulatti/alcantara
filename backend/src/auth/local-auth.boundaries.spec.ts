import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { ALCANTARA_PERMISSIONS } from './permissions';
import { RealtimeTicketService } from './realtime-ticket.service';
import {
  TEST_AUTH_AUDIENCE,
  TEST_AUTH_ISSUER,
  TestAuthService,
} from './test-auth.service';

describe('local authentication public boundaries', () => {
  it('never authorizes or exposes session issuance when local test auth is disabled and has no signing key', () => {
    const values: Record<string, string> = {
      AUTH_MODE: 'cognito',
      NODE_ENV: 'test',
    };
    const auth = new TestAuthService({
      get: (name: string) => values[name],
    } as unknown as ConfigService);
    expect(auth.isEnabled()).toBe(false);
    expect(() => auth.issue()).toThrow(NotFoundException);
    expect(() =>
      auth.authorize('Bearer fixture', ALCANTARA_PERMISSIONS.access, 7),
    ).toThrow(UnauthorizedException);
  });

  it('normalizes unknown fixture identities but grants no authority to validly signed malformed claims', () => {
    const secret = 'fixture-local-only-signing-secret-over-32-characters';
    const auth = new TestAuthService(
      new ConfigService({
        AUTH_MODE: 'test',
        NODE_ENV: 'test',
        TEST_AUTH_SECRET: secret,
      }),
    );
    expect(auth.issue('unknown-identity').user).toMatchObject({
      id: 'test:alcantara:operator-a',
      name: 'operator-a',
    });
    const token = sign({ permissions: 'not-an-array', roles: null }, secret, {
      algorithm: 'HS256',
      audience: TEST_AUTH_AUDIENCE,
      issuer: TEST_AUTH_ISSUER,
    });
    expect(auth.authorize(token, ALCANTARA_PERMISSIONS.access, 7)).toEqual({
      authenticated: false,
      allowed: false,
      reason: 'DENY_PERMISSION',
      subject: '',
      principalId: null,
      effectivePermissions: [],
      roles: ['team:7'],
    });
  });

  it('normalizes an empty program selection to main without permitting ticket reuse across programs', () => {
    const tickets = new RealtimeTicketService();
    const fallback = tickets.issue(' \t ');
    expect(tickets.consume(fallback.ticket, 'main')).toBe(true);
    const bound = tickets.issue('news');
    expect(tickets.consume(bound.ticket, ' \t ')).toBe(false);
    expect(tickets.consume(bound.ticket, 'news')).toBe(false);
  });
});
