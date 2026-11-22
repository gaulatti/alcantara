import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { McpOAuthProxyController } from './mcp-oauth-proxy.controller';
import {
  McpOAuthProxyService,
  challengeOf,
  cognitoTokenCall,
  consentMac,
  CONSENT_COOKIE,
  type ProxyAnswer,
} from './mcp-oauth-proxy.service';
import { COGNITO_HOSTED_DOMAIN, MCP_SHARED_CLIENT_ID } from './mcp.constants';
import type { McpHttpReply, McpHttpRequest } from './mcp.controller';

// gaulatti/bastille#34: the sign-in proxy's edges (missing fields, a foreign
// body, a repeated cookie header, the entry cap and the real Cognito call).
// Credentials are placeholders built here.
const VERIFIER = `fictional-verifier-${'v'.repeat(40)}`;

function service() {
  const metrics = { recordMcpOAuth: jest.fn() };
  const proxy = new McpOAuthProxyService(metrics as never);
  proxy.tokenCall = jest.fn(() =>
    Promise.resolve({ status: 200, body: '{"access_token":"fictional"}' }),
  );
  return { proxy, metrics };
}

describe('McpOAuthProxyService edges', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses requests whose fields are all missing', async () => {
    const { proxy } = service();
    expect(proxy.authorize({})).toMatchObject({
      status: 400,
      json: { error: 'unsupported_response_type' },
    });
    expect(proxy.consent({}, undefined)).toMatchObject({ status: 400 });
    expect(proxy.consent({ consent_nonce: 'n' }, 'other=1')).toMatchObject({
      status: 400,
    });
    expect(await proxy.callback({})).toMatchObject({
      result: 'unknown_state',
      status: 400,
    });
    expect(
      await proxy.token({ grant_type: 'authorization_code' }),
    ).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
  });

  it('cancels a consent whose request carried no state', () => {
    const { proxy } = service();
    const page = proxy.authorize({
      response_type: 'code',
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      state: 's',
      code_challenge: challengeOf(VERIFIER),
      code_challenge_method: 'S256',
    });
    const fields: Record<string, string> = {};
    for (const match of (page.html ?? '').matchAll(
      /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
    ))
      fields[match[1]] = match[2];
    const cookie = (page.headers?.['set-cookie'] ?? '').split(';')[0];
    // Without the state field the MAC no longer matches: nothing is cancelled.
    const stateless = { ...fields };
    delete stateless.state;
    expect(
      proxy.consent({ ...stateless, decision: 'cancel' }, cookie),
    ).toMatchObject({ status: 400 });
    expect(
      proxy.consent({ ...fields, decision: 'cancel' }, cookie).location,
    ).toContain('error=access_denied');
  });

  it('redeems a code only with every field present', async () => {
    const { proxy } = service();
    const callback = 'http://127.0.0.1:5000/cb';
    const sent = new URL(
      proxy.authorize({
        response_type: 'code',
        client_id: MCP_SHARED_CLIENT_ID,
        redirect_uri: callback,
        state: 's',
        code_challenge: challengeOf(VERIFIER),
        code_challenge_method: 'S256',
      }).location ?? '',
    );
    const back = new URL(
      (
        await proxy.callback({
          code: 'cognito-code',
          state: sent.searchParams.get('state') ?? '',
        })
      ).location ?? '',
    );
    expect(
      await proxy.token({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
      }),
    ).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
  });

  it('refuses a consent with no MAC, and cancels one whose request had no state', () => {
    const { proxy } = service();
    const key = (proxy as unknown as { consentKey: Buffer }).consentKey;
    const params = {
      response_type: 'code',
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    };
    const cookie = `${CONSENT_COOKIE}=nonce`;
    expect(
      proxy.consent({ ...params, consent_nonce: 'nonce' }, cookie),
    ).toMatchObject({ status: 400 });
    const cancelled = proxy.consent(
      {
        ...params,
        consent_nonce: 'nonce',
        consent_mac: consentMac(key, 'nonce', params),
        decision: 'cancel',
      },
      cookie,
    );
    const back = new URL(cancelled.location ?? '');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('');
  });

  it('drops pending sign-ins older than ten minutes', () => {
    const { proxy } = service();
    const request = {
      response_type: 'code',
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:5000/cb',
      state: 's',
      code_challenge: challengeOf(VERIFIER),
      code_challenge_method: 'S256',
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    proxy.authorize(request);
    now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
    proxy.authorize(request);
    const pending = (proxy as unknown as { pending: Map<string, unknown> })
      .pending;
    expect(pending.size).toBe(1);
  });

  it('keeps at most 1000 pending sign-ins, dropping the oldest', () => {
    const { proxy } = service();
    const request = {
      response_type: 'code',
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:5000/cb',
      state: 's',
      code_challenge: challengeOf(VERIFIER),
      code_challenge_method: 'S256',
    };
    const first = new URL(proxy.authorize(request).location ?? '');
    for (let index = 0; index < 1000; index += 1) proxy.authorize(request);
    const pending = (proxy as unknown as { pending: Map<string, unknown> })
      .pending;
    expect(pending.size).toBe(1000);
    expect(pending.has(first.searchParams.get('state') ?? '')).toBe(false);
  });

  it('posts the token form to Cognito with a timeout', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
    const form = new URLSearchParams({ grant_type: 'refresh_token' });
    await expect(cognitoTokenCall(form)).resolves.toEqual({
      status: 201,
      body: '{"ok":true}',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${COGNITO_HOSTED_DOMAIN}/oauth2/token`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('counts only steps and results from its closed sets', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordMcpOAuth('authorize', 'proxied');
    metrics.recordMcpOAuth('anything', 'proxied');
    metrics.recordMcpOAuth('authorize', 'anything');
    const output = await metrics.render('');
    expect(output).toContain(
      'alcantara_mcp_oauth_total{step="authorize",result="proxied"} 1',
    );
    expect(output).not.toContain('anything');
  });
});

describe('McpOAuthProxyController edges', () => {
  function reply() {
    const calls: Array<[string, unknown]> = [];
    const target = {
      status: (code: number) => (calls.push(['status', code]), target),
      headers: (value: unknown) => (calls.push(['headers', value]), target),
      header: (name: string, value: unknown) => (
        calls.push([name, value]),
        target
      ),
      send: (body?: unknown) => (calls.push(['send', body]), target),
    };
    return { target: target as unknown as McpHttpReply, calls };
  }
  const answer: ProxyAnswer = { result: 'refused', status: 400, json: {} };

  it('writes a redirect, a page and a JSON answer to the reply', async () => {
    const answers: ProxyAnswer[] = [
      { result: 'proxied', status: 303, location: 'https://example.test/x' },
      {
        result: 'consent',
        status: 200,
        html: '<p>page</p>',
        headers: { a: 'b' },
      },
      answer,
    ];
    const proxy = { authorize: jest.fn(() => answers.shift()!) };
    const controller = new McpOAuthProxyController(proxy as never);
    const redirect = reply();
    await controller.authorize(
      { query: {} } as McpHttpRequest,
      redirect.target,
    );
    expect(redirect.calls).toEqual([
      ['status', 303],
      ['location', 'https://example.test/x'],
      ['send', undefined],
    ]);
    const page = reply();
    await controller.authorize({} as McpHttpRequest, page.target);
    expect(page.calls).toEqual([
      ['status', 200],
      ['headers', { a: 'b' }],
      ['content-type', 'text/html; charset=utf-8'],
      ['send', '<p>page</p>'],
    ]);
    const json = reply();
    await controller.authorize(
      { query: 'x' } as unknown as McpHttpRequest,
      json.target,
    );
    expect(json.calls).toEqual([
      ['status', 400],
      ['send', {}],
    ]);
  });

  it('reads only string fields, joins repeated cookies and tolerates a missing body or query', async () => {
    const proxy = {
      authorize: jest.fn(() => answer),
      consent: jest.fn(() => answer),
      callback: jest.fn(() => Promise.resolve(answer)),
      token: jest.fn(() => Promise.resolve(answer)),
    };
    const controller = new McpOAuthProxyController(proxy as never);
    await controller.authorize(
      {
        query: { state: 's', repeated: ['a', 'b'] },
      } as unknown as McpHttpRequest,
      reply().target,
    );
    expect(proxy.authorize).toHaveBeenCalledWith({ state: 's' });
    await controller.callback({} as McpHttpRequest, reply().target);
    expect(proxy.callback).toHaveBeenCalledWith({});
    await controller.consent(
      {
        body: 'not a form',
        headers: { cookie: ['a=1', 'b=2'] },
      } as unknown as McpHttpRequest,
      reply().target,
    );
    expect(proxy.consent).toHaveBeenCalledWith({}, 'a=1;b=2');
    await controller.token(
      { body: null, headers: {} } as unknown as McpHttpRequest,
      reply().target,
    );
    expect(proxy.token).toHaveBeenCalledWith({});
    await controller.token(
      {
        body: { code: 'c', repeated: ['a'], count: 2 },
        headers: {},
      } as unknown as McpHttpRequest,
      reply().target,
    );
    expect(proxy.token).toHaveBeenLastCalledWith({ code: 'c' });
    await controller.consent(
      { body: {}, headers: { cookie: 'a=1' } } as unknown as McpHttpRequest,
      reply().target,
    );
    expect(proxy.consent).toHaveBeenLastCalledWith({}, 'a=1');
  });
});
