import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { PompeiiService } from '../auth/pompeii.service';
import type { AuthorizationDecision } from '../auth/pompeii.service';
import {
  ALCANTARA_PERMISSIONS,
  type AlcantaraPermission,
} from '../auth/permissions';
import { TestAuthService } from '../auth/test-auth.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { McpToolError } from './contract';
import type { McpAuthResult, McpPrincipal } from './contract';
import { MCP_LIMITS, MCP_RESOURCE_METADATA_URL } from './mcp.constants';

/** An HTTP answer the endpoint gives before any MCP processing. */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly result: Exclude<McpAuthResult, 'ok'>,
    readonly headers: Record<string, string> = {},
  ) {
    super(result);
    this.name = 'McpHttpError';
  }
}

type Decision =
  | {
      kind: 'granted';
      subject: string;
      principalId: string | null;
      permissions: ReadonlySet<AlcantaraPermission>;
    }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' };

function leaves(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(leaves);
}

/** Every key in Alcantara's permission catalogue; nothing else is granted. */
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(
  leaves(ALCANTARA_PERMISSIONS),
);

const PRIVATE_PEERS = new BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  PRIVATE_PEERS.addSubnet(network, prefix, 'ipv4');
PRIVATE_PEERS.addAddress('::1', 'ipv6');
PRIVATE_PEERS.addSubnet('fc00::', 7, 'ipv6');

/** First 64 bits of an IPv6 address, so one client's /64 shares one key. */
function ipv6Prefix64(address: string): string {
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [
        ...left,
        ...Array.from<string>({
          length: 8 - left.length - right.length,
        }).fill('0'),
        ...right,
      ]
    : left;
  return groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

const challenge = (parameters = ''): Record<string, string> => ({
  'WWW-Authenticate': `Bearer ${parameters}resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
});

/**
 * Authenticates every /mcp request itself. The Authorization header goes to
 * Pompeii exactly as received: this service classifies no token (an OAuth
 * session and a personal access token are both Pompeii's to judge) and acts
 * only on Pompeii's answer. One Authorize call on alcantara:access returns the
 * caller's effective permissions, which decide every tool. The credential is
 * never logged, labelled or sent anywhere but Pompeii.
 */
@Injectable()
export class McpAuthService {
  private readonly cache = new Map<
    string,
    { expires: number; decision: Decision }
  >();
  private readonly failures = new Map<string, number[]>();
  private inFlight = 0;
  now = () => Date.now();

  constructor(
    private readonly pompeii: PompeiiService,
    private readonly metrics: ManagedMetricsService,
    @Optional() private readonly testAuth?: TestAuthService,
  ) {}

  async authenticate(
    request: IncomingMessage,
    client: string,
  ): Promise<McpPrincipal> {
    try {
      const decision = await this.decide(request);
      this.metrics.recordMcpAuth('ok');
      return {
        subject: decision.subject,
        principalId: decision.principalId,
        permissions: decision.permissions,
        client,
      };
    } catch (error) {
      if (error instanceof McpHttpError)
        this.metrics.recordMcpAuth(error.result);
      throw error;
    }
  }

  /**
   * Asks Pompeii again with no cache read, for an action that matters. The
   * fresh answer also replaces the cached one. A refusal is a tool refusal;
   * Pompeii being unavailable is `unavailable`, never cached as a refusal.
   */
  async reauthorize(
    request: IncomingMessage,
    client: string,
  ): Promise<McpPrincipal> {
    const header = request.headers.authorization as string;
    const digest = createHash('sha256').update(header).digest('hex');
    let decision: Decision;
    try {
      decision = await this.ask(header, digest);
    } catch {
      throw new McpToolError(
        'unavailable',
        'Authorization could not be checked; try again shortly.',
        5,
      );
    }
    if (decision.kind !== 'granted')
      throw new McpToolError(
        'forbidden',
        'Your credential no longer allows this action.',
      );
    return {
      subject: decision.subject,
      principalId: decision.principalId,
      permissions: decision.permissions,
      client,
    };
  }

  private async decide(
    request: IncomingMessage,
  ): Promise<Extract<Decision, { kind: 'granted' }>> {
    const client = this.clientKey(request);
    if (this.limited(client)) {
      throw new McpHttpError(429, 'rate_limited', { 'Retry-After': '60' });
    }
    const header = request.headers.authorization;
    if (
      typeof header !== 'string' ||
      !header.trim() ||
      Buffer.byteLength(header) > MCP_LIMITS.maxAuthorizationBytes
    ) {
      this.recordFailure(client);
      throw new McpHttpError(
        401,
        'unauthenticated',
        challenge(typeof header === 'string' ? 'error="invalid_token", ' : ''),
      );
    }

    // The digest is only a cache key; the credential itself is not kept.
    const digest = createHash('sha256').update(header).digest('hex');
    const cached = this.cache.get(digest);
    const decision =
      cached && cached.expires > this.now()
        ? cached.decision
        : await this.ask(header, digest);

    if (decision.kind === 'unauthenticated') {
      this.recordFailure(client);
      throw new McpHttpError(
        401,
        'unauthenticated',
        challenge('error="invalid_token", '),
      );
    }
    if (decision.kind === 'forbidden') {
      throw new McpHttpError(
        403,
        'forbidden',
        challenge('error="insufficient_scope", '),
      );
    }
    return decision;
  }

  private async ask(header: string, digest: string): Promise<Decision> {
    if (this.inFlight >= MCP_LIMITS.maxConcurrentDecisions) {
      throw new McpHttpError(503, 'unavailable', { 'Retry-After': '5' });
    }
    this.inFlight += 1;
    let answer: AuthorizationDecision;
    try {
      answer = this.testAuth?.isEnabled()
        ? this.testAuth.authorize(
            header,
            ALCANTARA_PERMISSIONS.access,
            this.pompeii.teamId,
          )
        : await this.pompeii.authorize(header, ALCANTARA_PERMISSIONS.access);
    } catch {
      // PompeiiService already logged and counted the failure class.
      throw new McpHttpError(503, 'unavailable', { 'Retry-After': '5' });
    } finally {
      this.inFlight -= 1;
    }
    const decision = this.interpret(answer);
    this.remember(digest, decision);
    return decision;
  }

  private interpret(answer: AuthorizationDecision): Decision {
    if (!answer.authenticated) return { kind: 'unauthenticated' };
    if (!answer.allowed || !answer.subject) return { kind: 'forbidden' };
    const permissions = new Set<AlcantaraPermission>();
    for (const permission of answer.effectivePermissions) {
      if (KNOWN_PERMISSIONS.has(permission))
        permissions.add(permission as AlcantaraPermission);
    }
    // Pompeii allowed alcantara:access, so the caller holds it.
    permissions.add(ALCANTARA_PERMISSIONS.access);
    return {
      kind: 'granted',
      subject: answer.subject,
      principalId: answer.principalId,
      permissions,
    };
  }

  private remember(digest: string, decision: Decision): void {
    this.cache.delete(digest);
    this.cache.set(digest, {
      expires: this.now() + MCP_LIMITS.decisionCacheMs,
      decision,
    });
    while (this.cache.size > MCP_LIMITS.decisionCacheEntries) {
      // An over-capacity map is nonempty; its first key is the oldest entry.
      const [oldest] = this.cache.keys();
      this.cache.delete(oldest);
    }
  }

  /**
   * The client is the last X-Forwarded-For entry (the address the local
   * proxy saw) only when the immediate peer is loopback or private; otherwise
   * it is the peer. IPv6 clients are grouped by /64.
   */
  private clientKey(request: IncomingMessage): string {
    const peer = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const peerFamily = isIP(peer);
    let address = peer;
    const forwarded = request.headers['x-forwarded-for'];
    if (
      typeof forwarded === 'string' &&
      peerFamily &&
      PRIVATE_PEERS.check(peer, peerFamily === 6 ? 'ipv6' : 'ipv4')
    ) {
      const last = forwarded.split(',').pop()!.trim();
      if (isIP(last)) address = last.replace(/^::ffff:/, '');
    }
    return isIP(address) === 6 ? ipv6Prefix64(address) : address;
  }

  private limited(client: string): boolean {
    const since = this.now() - MCP_LIMITS.failureWindowMs;
    const recent = (this.failures.get(client) ?? []).filter((t) => t > since);
    if (recent.length) this.failures.set(client, recent);
    else this.failures.delete(client);
    return recent.length >= MCP_LIMITS.failuresPerWindow;
  }

  private recordFailure(client: string): void {
    const times = this.failures.get(client) ?? [];
    times.push(this.now());
    this.failures.delete(client);
    this.failures.set(client, times);
    while (this.failures.size > MCP_LIMITS.failureClients) {
      const [oldest] = this.failures.keys();
      this.failures.delete(oldest);
    }
  }
}
