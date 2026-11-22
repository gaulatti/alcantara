import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  COGNITO_HOSTED_DOMAIN,
  MCP_LIMITS,
  MCP_PUBLIC_ORIGIN,
  MCP_SHARED_CLIENT_ID,
} from './mcp.constants';

/**
 * Sign-in for MCP clients whose callback no Cognito list can hold
 * (gaulatti/bastille#34, ported from Monitor's gaulatti/monitor#205 and #206).
 *
 * Cognito redirects only to callbacks listed exactly on the app client. Codex
 * and Claude Code register `http://127.0.0.1:<random port>/<path>`, and a
 * ChatGPT plugin registers `https://chatgpt.com/connector/oauth/<id>` with a new
 * id each time it is added. So the API stands between the client and Cognito
 * for every accepted callback: loopback (`127.0.0.1`, `localhost`, `[::1]`, any
 * port and path) and https on {@link ALLOWED_HTTPS_HOSTS} (exact host, default
 * port, any path). Any other callback is refused with a page, never sent on to
 * Cognito.
 *
 * 1. `GET /oauth/authorize` checks the request. For an https callback it first
 *    shows a consent page (below); otherwise it keeps a pending sign-in and
 *    sends the user to Cognito with the API's one callback, its own state and
 *    its own PKCE challenge.
 * 2. `GET /oauth/callback` takes the pending sign-in by state (once), redeems
 *    Cognito's code server-side with the API's verifier, keeps the tokens under
 *    a new single-use 60 s code bound to the client's PKCE challenge, and
 *    redirects to the client's callback.
 * 3. `POST /oauth/token` hands the tokens over once, to the client whose id,
 *    callback and verifier match. A refresh token is Cognito's and passes
 *    through.
 *
 * Threat model. Registration is open, so the accepted callbacks are what keep a
 * code from reaching someone else. Codes are delivered only to loopback (the
 * user's own machine) and the allowlisted MCP client hosts, and each is
 * single-use, expires in 60 s and needs the verifier of its challenge.
 *
 * Consent. Anyone can create their own ChatGPT or Claude connector, register its
 * path and send the owner an authorize link; Cognito signs an already-signed-in
 * user in silently. So an https callback first gets a no-store, unframeable page
 * naming the host and the full callback, with Continue and Cancel. The form posts
 * the request back with a nonce that must match a `SameSite=Strict` cookie set by
 * the page and an HMAC over the nonce and the request (keyed per process), so a
 * cross-site form cannot consent and a request cannot be swapped.
 *
 * Pending sign-ins and tokens live only in this process's memory, never in the
 * database, a log or a metric label.
 */
export const MCP_CALLBACK_URL = `${MCP_PUBLIC_ORIGIN}/oauth/callback`;
export const MCP_AUTHORIZE_URL = `${MCP_PUBLIC_ORIGIN}/oauth/authorize`;
export const MCP_TOKEN_URL = `${MCP_PUBLIC_ORIGIN}/oauth/token`;
/** The https hosts an MCP client callback may be on (bastille#34). */
export const ALLOWED_HTTPS_HOSTS = [
  'chatgpt.com',
  'claude.ai',
  'claude.com',
  'www.cursor.com',
] as const;
/** The prefix of a client id that carries its registered callbacks. */
export const PROXY_CLIENT_PREFIX = 'mcp-proxy.';
export const CONSENT_COOKIE = 'alcantara_mcp_consent';
/** The authorize parameters a consent form carries back, in MAC order. */
export const CONSENT_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
] as const;

const PENDING_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 1000;
const MAX_CLIENT_ID_CHARS = 1024;
const COGNITO_TIMEOUT_MS = 10_000;

export type Params = Record<string, string>;

/** What a handler answers; the controller writes it to Fastify's reply. */
export interface ProxyAnswer {
  result: string;
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  html?: string;
  location?: string;
}

interface Pending {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  verifier: string;
  created: number;
}

export interface Issued {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  tokens: Record<string, unknown>;
  created: number;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const randomToken = () => base64url(randomBytes(32));

export function challengeOf(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function parse(uri: string): URL | null {
  if (uri.length > MCP_LIMITS.maxRegistrationUriLength) return null;
  try {
    const url = new URL(uri);
    return url.hash || url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

/** http on 127.0.0.1, localhost or [::1]. */
export function isLoopbackCallback(uri: string): boolean {
  const url = parse(uri);
  return (
    url !== null &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}

/** https on an allowlisted host, default port. */
export function isAllowlistedCallback(uri: string): boolean {
  const url = parse(uri);
  return (
    url !== null &&
    url.protocol === 'https:' &&
    url.port === '' &&
    (ALLOWED_HTTPS_HOSTS as readonly string[]).includes(url.hostname)
  );
}

export function isProxiedCallback(uri: string): boolean {
  return isLoopbackCallback(uri) || isAllowlistedCallback(uri);
}

/** A client id naming its callbacks (and its name, for the consent page). */
export function proxiedClientId(uris: string[], name?: string): string | null {
  const payload = name ? { u: uris, n: name } : { u: uris };
  const id = `${PROXY_CLIENT_PREFIX}${base64url(Buffer.from(JSON.stringify(payload)))}`;
  return id.length <= MAX_CLIENT_ID_CHARS ? id : null;
}

export function registeredClient(
  clientId: string,
): { uris: string[]; name?: string } | null {
  if (
    !clientId.startsWith(PROXY_CLIENT_PREFIX) ||
    clientId.length > MAX_CLIENT_ID_CHARS
  )
    return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(
        clientId.slice(PROXY_CLIENT_PREFIX.length),
        'base64url',
      ).toString('utf8'),
    );
    if (!decoded || typeof decoded !== 'object') return null;
    const { u, n } = decoded as { u?: unknown; n?: unknown };
    if (
      !Array.isArray(u) ||
      !u.every((uri) => typeof uri === 'string' && isProxiedCallback(uri))
    )
      return null;
    return {
      uris: u as string[],
      ...(typeof n === 'string' && n ? { name: n } : {}),
    };
  } catch {
    return null;
  }
}

export function consentMac(key: Buffer, nonce: string, params: Params): string {
  const message = [
    nonce,
    ...CONSENT_FIELDS.map((field) => `${field}=${params[field] ?? ''}`),
  ].join('\n');
  return base64url(createHmac('sha256', key).update(message).digest());
}

export function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function htmlEscape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

/** Whether a taken code may be redeemed now. */
export function verifies(
  issued: Issued,
  clientId: string,
  redirectUri: string,
  verifier: string,
  now = Date.now(),
): boolean {
  return (
    now - issued.created < CODE_TTL_MS &&
    issued.clientId === clientId &&
    issued.redirectUri === redirectUri &&
    verifier !== '' &&
    challengeOf(verifier) === issued.codeChallenge
  );
}

function prune<T extends { created: number }>(
  entries: Map<string, T>,
  ttl: number,
  now: number,
) {
  for (const [key, entry] of entries)
    if (now - entry.created >= ttl) entries.delete(key);
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
}

function withQuery(uri: string, pairs: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(pairs))
    url.searchParams.append(key, value);
  return url.toString();
}

const json = (
  result: string,
  status: number,
  error: string,
  description: string,
): ProxyAnswer => ({
  result,
  status,
  headers: { 'cache-control': 'no-store' },
  json: { error, error_description: description },
});

const redirect = (result: string, location: string): ProxyAnswer => ({
  result,
  status: 303,
  location,
});

/** Requests to Cognito's token endpoint (replaced in tests). */
export type CognitoTokenCall = (
  form: URLSearchParams,
) => Promise<{ status: number; body: string }>;

export const cognitoTokenCall: CognitoTokenCall = async (form) => {
  const response = await fetch(`${COGNITO_HOSTED_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(COGNITO_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
};

@Injectable()
export class McpOAuthProxyService {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Issued>();
  /** Keys the consent MAC; random per process, never stored or logged. */
  private readonly consentKey = randomBytes(32);
  /** Replaced in tests. */
  tokenCall: CognitoTokenCall = cognitoTokenCall;

  constructor(private readonly metrics: ManagedMetricsService) {}

  private observe(step: string, answer: ProxyAnswer): ProxyAnswer {
    this.metrics.recordMcpOAuth(step, answer.result);
    return answer;
  }

  authorize(params: Params): ProxyAnswer {
    return this.observe('authorize', this.authorizeInner(params, false));
  }

  consent(form: Params, cookieHeader: string | undefined): ProxyAnswer {
    return this.observe('authorize', this.consentInner(form, cookieHeader));
  }

  private consentInner(
    form: Params,
    cookieHeader: string | undefined,
  ): ProxyAnswer {
    const cookie =
      (cookieHeader ?? '')
        .split(';')
        .map((pair) => pair.trim().split('='))
        .find(([name]) => name === CONSENT_COOKIE)?.[1] ?? '';
    const nonce = form.consent_nonce ?? '';
    const params: Params = {};
    for (const field of CONSENT_FIELDS)
      if (form[field] !== undefined) params[field] = form[field];
    if (
      !nonce ||
      !same(cookie, nonce) ||
      !same(form.consent_mac ?? '', consentMac(this.consentKey, nonce, params))
    )
      return json(
        'refused',
        400,
        'invalid_request',
        'This consent page expired or was opened elsewhere; start the sign-in again from the app',
      );
    if (form.decision === 'cancel')
      return redirect(
        'cancelled',
        withQuery(params.redirect_uri, {
          error: 'access_denied',
          state: params.state ?? '',
        }),
      );
    return this.authorizeInner(params, true);
  }

  private authorizeInner(params: Params, consented: boolean): ProxyAnswer {
    const clientId = params.client_id ?? '';
    const redirectUri = params.redirect_uri ?? '';
    const state = params.state ?? '';
    const challenge = params.code_challenge ?? '';
    if (params.response_type !== 'code')
      return json(
        'refused',
        400,
        'unsupported_response_type',
        'response_type must be code',
      );
    if (!state || state.length > 1024)
      return json('refused', 400, 'invalid_request', 'state is required');
    if (
      params.code_challenge_method !== 'S256' ||
      challenge.length < 43 ||
      challenge.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(challenge)
    )
      return json(
        'refused',
        400,
        'invalid_request',
        'a code_challenge with method S256 is required',
      );
    if (!isProxiedCallback(redirectUri))
      return {
        result: 'refused',
        status: 400,
        headers: { 'cache-control': 'no-store' },
        html: refusedPage(),
      };
    const registered = registeredClient(clientId);
    if (
      clientId.startsWith(PROXY_CLIENT_PREFIX) &&
      !registered?.uris.includes(redirectUri)
    )
      return json(
        'refused',
        400,
        'invalid_request',
        'redirect_uri was not registered by this client',
      );
    if (!consented && !isLoopbackCallback(redirectUri))
      return this.consentPage(params, registered?.name);
    const nonce = randomToken();
    const verifier = randomToken();
    const now = Date.now();
    prune(this.pending, PENDING_TTL_MS, now);
    this.pending.set(nonce, {
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      verifier,
      created: now,
    });
    const target = new URL(`${COGNITO_HOSTED_DOMAIN}/oauth2/authorize`);
    target.search = new URLSearchParams({
      response_type: 'code',
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uri: MCP_CALLBACK_URL,
      scope: params.scope || 'openid email profile',
      state: nonce,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return redirect('proxied', target.toString());
  }

  private consentPage(params: Params, name: string | undefined): ProxyAnswer {
    const nonce = randomToken();
    const mac = consentMac(this.consentKey, nonce, params);
    const callback = new URL(params.redirect_uri);
    const who = name
      ? `${htmlEscape(name)} (a name the app chose) at`
      : 'An app at';
    const fields = CONSENT_FIELDS.filter((field) => params[field] !== undefined)
      .map(
        (field) =>
          `<input type="hidden" name="${field}" value="${htmlEscape(params[field])}">`,
      )
      .join('');
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to Alcántara?</title></head>` +
      `<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.5">` +
      `<h1 style="font-size:1.4rem">${who} <b>${htmlEscape(callback.hostname)}</b> wants to use Alcántara as you</h1>` +
      `<p>If you continue, it receives access to Alcántara with your account at this address:</p>` +
      `<p style="font-family:ui-monospace,monospace;word-break:break-all;background:#f3f3f3;padding:.6rem">${htmlEscape(callback.toString())}</p>` +
      `<p>Continue only if you added Alcántara to this app yourself just now.</p>` +
      `<form method="post" action="/oauth/authorize">${fields}` +
      `<input type="hidden" name="consent_nonce" value="${nonce}"><input type="hidden" name="consent_mac" value="${mac}">` +
      `<button type="submit" name="decision" value="continue">Continue</button> ` +
      `<button type="submit" name="decision" value="cancel">Cancel</button></form></body></html>`;
    return {
      result: 'consent',
      status: 200,
      html,
      headers: {
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'; form-action 'self'",
        'set-cookie': `${CONSENT_COOKIE}=${nonce}; Path=/oauth/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Strict`,
      },
    };
  }

  async callback(params: Params): Promise<ProxyAnswer> {
    return this.observe('callback', await this.callbackInner(params));
  }

  private async callbackInner(params: Params): Promise<ProxyAnswer> {
    const pending = this.pending.get(params.state ?? '');
    this.pending.delete(params.state ?? '');
    if (!pending || Date.now() - pending.created >= PENDING_TTL_MS)
      return json(
        'unknown_state',
        400,
        'invalid_request',
        'This sign-in is unknown or expired; start again',
      );
    if (params.error) {
      const code = /^[a-z_]{1,64}$/.test(params.error)
        ? params.error
        : 'access_denied';
      return redirect(
        'provider_error',
        withQuery(pending.redirectUri, { error: code, state: pending.state }),
      );
    }
    if (!params.code)
      return json('refused', 400, 'invalid_request', 'code is required');
    let tokens: Record<string, unknown> | null = null;
    try {
      const answer = await this.tokenCall(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: MCP_SHARED_CLIENT_ID,
          code: params.code,
          redirect_uri: MCP_CALLBACK_URL,
          code_verifier: pending.verifier,
        }),
      );
      const parsed: unknown =
        answer.status >= 200 && answer.status < 300
          ? JSON.parse(answer.body)
          : null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).access_token === 'string'
      )
        tokens = parsed as Record<string, unknown>;
    } catch {
      tokens = null;
    }
    if (!tokens)
      return redirect(
        'exchange_failed',
        withQuery(pending.redirectUri, {
          error: 'server_error',
          state: pending.state,
        }),
      );
    const issued = randomToken();
    const now = Date.now();
    prune(this.codes, CODE_TTL_MS, now);
    this.codes.set(issued, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      tokens,
      created: now,
    });
    return redirect(
      'issued',
      withQuery(pending.redirectUri, { code: issued, state: pending.state }),
    );
  }

  async token(form: Params): Promise<ProxyAnswer> {
    const step = form.grant_type === 'refresh_token' ? 'refresh' : 'token';
    return this.observe(step, await this.tokenInner(form));
  }

  private async tokenInner(form: Params): Promise<ProxyAnswer> {
    if (form.grant_type === 'authorization_code') {
      const issued = this.codes.get(form.code ?? '');
      this.codes.delete(form.code ?? '');
      // Every sign-in goes through the API, so a code here is only ever ours.
      if (!issued)
        return json(
          'refused',
          400,
          'invalid_grant',
          'The code is unknown, expired or used',
        );
      if (
        !verifies(
          issued,
          form.client_id ?? '',
          form.redirect_uri ?? '',
          form.code_verifier ?? '',
        )
      )
        return json(
          'refused',
          400,
          'invalid_grant',
          'The code, client, callback or verifier does not match',
        );
      return {
        result: 'issued',
        status: 200,
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
        json: issued.tokens,
      };
    }
    // Cognito's own (a refresh): a proxy client id is the app client's.
    const forwarded = new URLSearchParams();
    for (const [key, value] of Object.entries(form))
      forwarded.append(
        key,
        key === 'client_id' && value.startsWith(PROXY_CLIENT_PREFIX)
          ? MCP_SHARED_CLIENT_ID
          : value,
      );
    try {
      const answer = await this.tokenCall(forwarded);
      let body: unknown;
      try {
        body = JSON.parse(answer.body);
      } catch {
        body = { error: 'server_error' };
      }
      return {
        result:
          answer.status >= 200 && answer.status < 300
            ? 'passed_through'
            : 'upstream_refused',
        status: answer.status,
        headers: { 'cache-control': 'no-store' },
        json: body,
      };
    } catch {
      return {
        result: 'upstream_unavailable',
        status: 502,
        json: { error: 'temporarily_unavailable' },
      };
    }
  }
}

function refusedPage(): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in refused</title></head>` +
    `<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.5">` +
    `<h1 style="font-size:1.4rem">This app's sign-in address is not accepted</h1>` +
    `<p>Alcántara signs MCP clients in only when they return to this computer (127.0.0.1, localhost or [::1]) ` +
    `or to one of these sites over https: ${ALLOWED_HTTPS_HOSTS.join(', ')}.</p>` +
    `<p>The app asked to return somewhere else, so nothing was sent to it. Add Alcántara again from a supported client.</p>` +
    `</body></html>`
  );
}
