import type { IncomingMessage } from 'node:http';
import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import type { PompeiiService } from '../auth/pompeii.service';
import { PompeiiService as PompeiiServiceToken } from '../auth/pompeii.service';
import { TestAuthService } from '../auth/test-auth.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import { McpAuthService, McpHttpError } from './mcp-auth.service';
import { clientName } from './mcp.controller';
import { McpModule } from './mcp.module';
import { MCP_LIMITS } from './mcp.constants';

// The client key behind the failure limiter, and the module's own wiring.

const granted = {
  authenticated: true,
  allowed: true,
  reason: 'ALLOW',
  subject: 's',
  principalId: null,
  effectivePermissions: [ALCANTARA_PERMISSIONS.access],
  roles: [],
};

function fixture() {
  const pompeii = {
    teamId: 7,
    authorize: jest
      .fn()
      .mockResolvedValue({ ...granted, authenticated: false }),
  };
  const metrics = new ManagedMetricsService();
  const auth = new McpAuthService(
    pompeii as unknown as PompeiiService,
    metrics,
  );
  const message = (
    remoteAddress: string | undefined,
    headers: Record<string, string> = {},
  ) =>
    ({
      socket: { remoteAddress },
      headers: { authorization: `Bearer ${'k'.repeat(40)}`, ...headers },
    }) as unknown as IncomingMessage;
  const key = (request: IncomingMessage) =>
    (auth as unknown as { clientKey(r: IncomingMessage): string }).clientKey(
      request,
    );
  return { auth, pompeii, message, key };
}

describe('MCP auth client key', () => {
  it('uses the last forwarded address only behind a loopback or private proxy', () => {
    const { message, key } = fixture();
    expect(
      key(message('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' })),
    ).toBe('9.9.9.9');
    expect(
      key(message('::ffff:10.0.0.2', { 'x-forwarded-for': '8.8.8.8' })),
    ).toBe('8.8.8.8');
    expect(
      key(message('::1', { 'x-forwarded-for': '2001:db8:aaaa:bbbb:1::1' })),
    ).toBe('2001:db8:aaaa:bbbb');
    // A public peer is the client, whatever it forwards.
    expect(key(message('203.0.114.7', { 'x-forwarded-for': '9.9.9.9' }))).toBe(
      '203.0.114.7',
    );
    // A forwarded value that is not an address is ignored.
    expect(
      key(message('192.168.1.1', { 'x-forwarded-for': 'not-an-ip' })),
    ).toBe('192.168.1.1');
    expect(key(message(undefined))).toBe('');
  });

  it('groups an IPv6 client by its /64, compressed or not', () => {
    const { message, key } = fixture();
    expect(key(message('2600:1f18:aa::5'))).toBe('2600:1f18:aa:0');
    expect(key(message('2600:1f18:00aa:0000:1:2:3:4'))).toBe('2600:1f18:aa:0');
    expect(key(message('2600:1f18:aa:0:ffff::'))).toBe('2600:1f18:aa:0');
    expect(key(message('::'))).toBe('0:0:0:0');
  });

  it('forgets failures outside the window and keeps the client map bounded', async () => {
    const { auth, message } = fixture();
    let now = 0;
    auth.now = () => now;
    for (let i = 0; i < MCP_LIMITS.failuresPerWindow; i += 1) {
      await expect(
        auth.authenticate(
          message('8.8.4.4', { authorization: `Bearer ${i}` }),
          'c',
        ),
      ).rejects.toBeInstanceOf(McpHttpError);
    }
    await expect(
      auth.authenticate(message('8.8.4.4'), 'c'),
    ).rejects.toMatchObject({ status: 429 });
    now += MCP_LIMITS.failureWindowMs + 1;
    await expect(
      auth.authenticate(message('8.8.4.4'), 'c'),
    ).rejects.toMatchObject({ status: 401 });
    const failures = (auth as unknown as { failures: Map<string, number[]> })
      .failures;
    for (let i = 0; i <= MCP_LIMITS.failureClients; i += 1)
      failures.set(`client-${i}`, [now]);
    await expect(
      auth.authenticate(message('8.8.8.8'), 'c'),
    ).rejects.toMatchObject({ status: 401 });
    expect(failures.size).toBe(MCP_LIMITS.failureClients);
  });

  it('names the client by its user agent, or unknown', () => {
    expect(clientName('Claude-User/1.0 (+https://example.test)')).toBe(
      'Claude-User/1.0',
    );
    expect(clientName('a<b>c')).toBe('abc');
    expect(clientName('x'.repeat(100))).toHaveLength(64);
    expect(clientName('<>')).toBe('unknown');
    expect(clientName('   ')).toBe('unknown');
    expect(clientName(undefined)).toBe('unknown');
  });

  it('carries no extra headers on a refusal by default', () => {
    expect(new McpHttpError(401, 'unauthenticated').headers).toEqual({});
  });
});

describe('MCP module', () => {
  it('compiles with its global dependencies', async () => {
    const module = await Test.createTestingModule({ imports: [McpModule] })
      .useMocker((token) => {
        if (token === PompeiiServiceToken)
          return { teamId: 1, authorize: jest.fn() };
        if (token === ManagedMetricsService) return new ManagedMetricsService();
        if (token === TestAuthService) return { isEnabled: () => false };
        if (token === ProgramService) return { listPrograms: jest.fn() };
        return undefined;
      })
      .compile();
    expect(module.get(McpAuthService)).toBeInstanceOf(McpAuthService);
    await module.close();
  });
});
