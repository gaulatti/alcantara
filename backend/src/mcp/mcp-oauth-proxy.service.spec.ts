import {
  CODE_TTL_MS,
  CONSENT_COOKIE,
  CONSENT_FIELDS,
  MCP_CALLBACK_URL,
  McpOAuthProxyService,
  PROXY_CLIENT_PREFIX,
  SIGNIN_COOKIE_PREFIX,
  challengeOf,
  consentMac,
  htmlEscape,
  isAllowlistedCallback,
  isLoopbackCallback,
  isProxiedCallback,
  proxiedClientId,
  registeredClient,
  same,
  verifies,
  type Params,
  type ProxyAnswer,
} from './mcp-oauth-proxy.service';
import { COGNITO_HOSTED_DOMAIN, MCP_SHARED_CLIENT_ID } from './mcp.constants';

// gaulatti/bastille#34: MCP sign-in through the API's one Cognito callback,
// with consent for https callbacks. Credentials are placeholders built here.
const VERIFIER = `fictional-verifier-${'v'.repeat(40)}`;
const metrics = { recordMcpOAuth: jest.fn() };

function proxy(tokenStatus = 200) {
  const service = new McpOAuthProxyService(metrics as never);
  const calls: URLSearchParams[] = [];
  service.tokenCall = jest.fn((form: URLSearchParams) => {
    calls.push(form);
    return Promise.resolve({
      status: tokenStatus,
      body: JSON.stringify(
        form.get('grant_type') === 'refresh_token'
          ? { access_token: 'fictional-refreshed' }
          : {
              access_token: 'fictional-access',
              refresh_token: 'fictional-refresh',
            },
      ),
    });
  });
  return { service, calls };
}

function authorizeParams(
  clientId: string,
  redirectUri: string,
  extra: Params = {},
): Params {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'fictional-client-state',
    code_challenge: challengeOf(VERIFIER),
    code_challenge_method: 'S256',
    scope: 'openid email profile',
    ...extra,
  };
}

/** The consent page's hidden fields and the cookie it set. */
function consentForm(answer: ProxyAnswer): { form: Params; cookie: string } {
  expect(answer.status).toBe(200);
  expect(answer.result).toBe('consent');
  expect(answer.location).toBeUndefined();
  expect(answer.headers?.['cache-control']).toBe('no-store');
  expect(answer.headers?.['x-frame-options']).toBe('DENY');
  // form-action names every place the form leads (bastille#34).
  const callback = new URL(
    /name="redirect_uri" value="([^"]*)"/.exec(answer.html ?? '')?.[1] ?? '',
  );
  expect(answer.headers?.['content-security-policy']).toBe(
    `frame-ancestors 'none'; form-action 'self' ${new URL(COGNITO_HOSTED_DOMAIN).origin} ${callback.origin}`,
  );
  const setCookie = answer.headers?.['set-cookie'] ?? '';
  expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Secure');
  const form: Params = {};
  for (const match of (answer.html ?? '').matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  ))
    form[match[1]] = match[2]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  return { form, cookie: setCookie.split(';')[0] };
}

/** The sign-in cookie a redirect to Cognito sets, as a Cookie header pair. */
function signin(answer: ProxyAnswer): string {
  return (answer.headers?.['set-cookie'] ?? '').split(';')[0];
}

/** A started loopback sign-in: the API's state and this browser's cookie. */
function started(answer: ProxyAnswer) {
  return {
    state: new URL(answer.location!).searchParams.get('state')!,
    cookie: signin(answer),
  };
}

/** Authorize (through consent for https), Cognito's return and the redeemed code. */
async function roundTrip(
  service: McpOAuthProxyService,
  clientId: string,
  callback: string,
) {
  let toCognito = service.authorize(authorizeParams(clientId, callback));
  if (callback.startsWith('https://')) {
    const { form, cookie } = consentForm(toCognito);
    toCognito = service.consent({ ...form, decision: 'continue' }, cookie);
  }
  expect(toCognito.status).toBe(303);
  const sent = new URL(toCognito.location!);
  expect(sent.searchParams.get('redirect_uri')).toBe(MCP_CALLBACK_URL);
  expect(sent.searchParams.get('client_id')).toBe(MCP_SHARED_CLIENT_ID);
  expect(sent.searchParams.get('state')).not.toBe('fictional-client-state');
  const back = await service.callback(
    { code: 'cognito-code', state: sent.searchParams.get('state')! },
    signin(toCognito),
  );
  expect(back.result).toBe('issued');
  expect(back.headers?.['set-cookie']).toBe(
    `${signin(toCognito).split('=')[0]}=; Path=/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
  const returned = new URL(back.location!);
  expect(`${returned.origin}${returned.pathname}`).toBe(
    new URL(callback).origin + new URL(callback).pathname,
  );
  expect(returned.searchParams.get('state')).toBe('fictional-client-state');
  const code = returned.searchParams.get('code')!;
  const redeem = () =>
    service.token({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: callback,
      code_verifier: VERIFIER,
    });
  const tokens = await redeem();
  expect(tokens.status).toBe(200);
  expect(tokens.json).toEqual({
    access_token: 'fictional-access',
    refresh_token: 'fictional-refresh',
  });
  expect(tokens.headers?.['cache-control']).toBe('no-store');
  const replay = await redeem();
  expect(replay.status).toBe(400);
  expect(replay.json).toMatchObject({ error: 'invalid_grant' });
}

describe('MCP sign-in through the API (bastille#34)', () => {
  beforeEach(() => metrics.recordMcpOAuth.mockClear());

  it('accepts loopback and allowlisted https callbacks only', () => {
    for (const uri of [
      'http://127.0.0.1:53682/cb',
      'http://localhost:8765/callback',
      'http://[::1]:9/x',
    ])
      expect(isLoopbackCallback(uri)).toBe(true);
    for (const uri of [
      'https://chatgpt.com/connector/oauth/gmprobe0001',
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/x',
      'https://www.cursor.com/cb',
      'https://ChatGPT.com/connector/oauth/A',
    ])
      expect(isAllowlistedCallback(uri)).toBe(true);
    for (const uri of [
      'http://chatgpt.com/cb',
      'https://chatgpt.com:8443/cb',
      'https://evil.chatgpt.com/cb',
      'https://chatgpt.com.evil.example/cb',
      'https://cursor.com/cb',
      'https://user@chatgpt.com/cb',
      'https://chatgpt.com/cb#frag',
      'https://evil.example/cb',
      'not a url',
      `https://chatgpt.com/${'x'.repeat(3000)}`,
    ])
      expect(isProxiedCallback(uri)).toBe(false);
  });

  it('a client id names its callbacks and name; anything else reads as nothing', () => {
    const uris = ['https://chatgpt.com/connector/oauth/a1'];
    expect(registeredClient(proxiedClientId(uris, 'Notes')!)).toEqual({
      uris,
      name: 'Notes',
    });
    expect(registeredClient(proxiedClientId(uris)!)).toEqual({ uris });
    expect(
      proxiedClientId([`http://127.0.0.1/${'x'.repeat(2000)}`]),
    ).toBeNull();
    for (const payload of [
      { n: 'x' },
      42,
      { u: ['https://evil.example/cb'] },
      { u: 'no' },
    ])
      expect(
        registeredClient(
          `${PROXY_CLIENT_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
        ),
      ).toBeNull();
    expect(registeredClient(`${PROXY_CLIENT_PREFIX}@@@not-json`)).toBeNull();
    expect(registeredClient(MCP_SHARED_CLIENT_ID)).toBeNull();
  });

  it('a loopback callback on a random port signs in without consent, and the code is single-use', async () => {
    const { service, calls } = proxy();
    const callback = 'http://127.0.0.1:61234/callback/Zx9qR';
    await roundTrip(service, proxiedClientId([callback])!, callback);
    expect(calls[0].get('redirect_uri')).toBe(MCP_CALLBACK_URL);
    expect(calls[0].get('client_id')).toBe(MCP_SHARED_CLIENT_ID);
    expect(metrics.recordMcpOAuth).not.toHaveBeenCalledWith(
      'authorize',
      'consent',
    );
  });

  it('a chatgpt.com/connector/oauth/<random> callback signs in after consent, under its id or the shared one', async () => {
    for (const path of ['gmprobe0001', 'h4X9-kq2']) {
      const { service } = proxy();
      const callback = `https://chatgpt.com/connector/oauth/${path}`;
      await roundTrip(service, proxiedClientId([callback])!, callback);
      await roundTrip(service, MCP_SHARED_CLIENT_ID, callback);
    }
    expect(metrics.recordMcpOAuth).toHaveBeenCalledWith('authorize', 'consent');
  });

  it('refuses an unlisted host with a page and never builds a Cognito redirect', () => {
    const { service } = proxy();
    for (const callback of [
      'https://evil.example/oauth/cb',
      'https://chatgpt.com.evil.example/cb',
    ]) {
      const answer = service.authorize(
        authorizeParams(MCP_SHARED_CLIENT_ID, callback),
      );
      expect(answer.status).toBe(400);
      expect(answer.location).toBeUndefined();
      expect(answer.html).toContain('not accepted');
      expect(answer.html).toContain('chatgpt.com');
    }
  });

  it('consent cannot be given by a cross-site or altered form, and Cancel tells the client', () => {
    const { service } = proxy();
    const callback = 'https://chatgpt.com/connector/oauth/attacker42';
    const clientId = proxiedClientId([callback], 'Notes <b>Helper</b>')!;
    const page = service.authorize(authorizeParams(clientId, callback));
    expect(page.html).toContain('<b>chatgpt.com</b>');
    expect(page.html).toContain('connector/oauth/attacker42');
    expect(page.html).toContain(
      'Notes &lt;b&gt;Helper&lt;/b&gt; (a name the app chose)',
    );
    const { form, cookie } = consentForm(page);
    expect(
      service.consent({ ...form, decision: 'continue' }, undefined).status,
    ).toBe(400);
    expect(
      service.consent(
        { ...form, decision: 'continue' },
        `${CONSENT_COOKIE}=someone-else`,
      ).status,
    ).toBe(400);
    expect(
      service.consent(
        {
          ...form,
          redirect_uri: 'https://chatgpt.com/connector/oauth/other',
          decision: 'continue',
        },
        cookie,
      ).status,
    ).toBe(400);
    expect(
      service.consent(
        { ...form, consent_nonce: '', decision: 'continue' },
        `${CONSENT_COOKIE}=`,
      ).status,
    ).toBe(400);
    const cancelled = service.consent(
      { ...form, decision: 'cancel' },
      `other=1; ${cookie}`,
    );
    expect(cancelled.result).toBe('cancelled');
    const back = new URL(cancelled.location!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('fictional-client-state');
    // An anonymous registration names nobody.
    expect(
      service.authorize(authorizeParams(MCP_SHARED_CLIENT_ID, callback)).html,
    ).toContain('An app at');
  });

  it('refuses requests without code, state or S256, and callbacks the client did not register', () => {
    const { service } = proxy();
    const callback = 'http://127.0.0.1:5000/cb';
    const id = proxiedClientId([callback])!;
    expect(
      service.authorize(
        authorizeParams(id, callback, { response_type: 'token' }),
      ).json,
    ).toMatchObject({ error: 'unsupported_response_type' });
    expect(
      service.authorize(authorizeParams(id, callback, { state: '' })).status,
    ).toBe(400);
    expect(
      service.authorize(
        authorizeParams(id, callback, { state: 's'.repeat(1025) }),
      ).status,
    ).toBe(400);
    expect(
      service.authorize(
        authorizeParams(id, callback, { code_challenge_method: 'plain' }),
      ).status,
    ).toBe(400);
    expect(
      service.authorize(
        authorizeParams(id, callback, { code_challenge: 'short' }),
      ).status,
    ).toBe(400);
    expect(
      service.authorize(
        authorizeParams(id, callback, { code_challenge: `${'a'.repeat(42)}!` }),
      ).status,
    ).toBe(400);
    expect(
      service.authorize(authorizeParams(id, 'http://127.0.0.1:5001/other'))
        .json,
    ).toMatchObject({
      error_description: 'redirect_uri was not registered by this client',
    });
    expect(service.authorize({ client_id: id }).status).toBe(400);
  });

  it('a wrong verifier, client or callback redeems nothing, and codes expire in 60 s', async () => {
    const { service } = proxy();
    const callback = 'http://127.0.0.1:5002/cb';
    const id = proxiedClientId([callback])!;
    const sign = started(service.authorize(authorizeParams(id, callback)));
    const back = new URL(
      (await service.callback({ code: 'c', state: sign.state }, sign.cookie))
        .location!,
    );
    const wrong = await service.token({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      client_id: id,
      redirect_uri: callback,
      code_verifier: `wrong-${'w'.repeat(40)}`,
    });
    expect(wrong.json).toMatchObject({ error: 'invalid_grant' });
    expect(
      (
        await service.token({
          grant_type: 'authorization_code',
          code: 'unknown',
        })
      ).json,
    ).toMatchObject({ error: 'invalid_grant' });
    const issued = {
      clientId: 'c',
      redirectUri: 'u',
      codeChallenge: challengeOf(VERIFIER),
      tokens: {},
      created: 1_000,
    };
    expect(verifies(issued, 'c', 'u', VERIFIER, 1_000 + CODE_TTL_MS - 1)).toBe(
      true,
    );
    expect(verifies(issued, 'c', 'u', VERIFIER, 1_000 + CODE_TTL_MS)).toBe(
      false,
    );
    expect(verifies(issued, 'other', 'u', VERIFIER, 1_000)).toBe(false);
    expect(verifies(issued, 'c', 'other', VERIFIER, 1_000)).toBe(false);
    expect(verifies(issued, 'c', 'u', '', 1_000)).toBe(false);
  });

  it('an unknown state is refused; a Cognito error and a failed exchange reach the client', async () => {
    const callback = 'http://127.0.0.1:5003/cb';
    const id = proxiedClientId([callback])!;
    const { service } = proxy(400);
    expect(
      (await service.callback({ state: 'unknown' }, undefined)).result,
    ).toBe('unknown_state');
    const call = (extra: Params) => {
      const sign = started(service.authorize(authorizeParams(id, callback)));
      return service.callback({ state: sign.state, ...extra }, sign.cookie);
    };
    const denied = await call({ error: 'access_denied' });
    expect(new URL(denied.location!).searchParams.get('error')).toBe(
      'access_denied',
    );
    const odd = await call({ error: 'Not<Bounded>' });
    expect(new URL(odd.location!).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect((await call({})).json).toMatchObject({
      error_description: 'code is required',
    });
    const failed = await call({ code: 'c' });
    expect(failed.result).toBe('exchange_failed');
    expect(new URL(failed.location!).searchParams.get('error')).toBe(
      'server_error',
    );
    service.tokenCall = () => Promise.reject(new Error('down'));
    expect((await call({ code: 'c' })).result).toBe('exchange_failed');
  });

  it('completes a sign-in only in the browser that started it', async () => {
    const { service } = proxy();
    const callback = 'https://chatgpt.com/connector/oauth/fictional-binding';
    const id = proxiedClientId([callback])!;
    const loopback = 'http://127.0.0.1:5004/cb';
    const loopbackId = proxiedClientId([loopback])!;
    /** Consent and Continue in one browser: the redirect to Cognito. */
    const begin = () => {
      const { form, cookie } = consentForm(
        service.authorize(authorizeParams(id, callback)),
      );
      return service.consent({ ...form, decision: 'continue' }, cookie);
    };
    const toCognito = begin();
    expect(toCognito.headers?.['set-cookie']).toMatch(
      new RegExp(
        `^${SIGNIN_COOKIE_PREFIX}[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{43}; Path=/oauth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`,
      ),
    );
    expect(toCognito.headers?.['cache-control']).toBe('no-store');
    expect(
      service.authorize(authorizeParams(loopbackId, loopback)).headers?.[
        'set-cookie'
      ],
    ).toMatch(new RegExp(`^${SIGNIN_COOKIE_PREFIX}`));

    // The same Cognito link opened in another browser sends no cookie, another
    // sign-in's cookie or a wrong value: refused before anything reaches the
    // client's callback, and the sign-in still finishes where it started.
    const other = started(
      service.authorize(authorizeParams(loopbackId, loopback)),
    );
    const elsewhere = [
      () => undefined,
      () => other.cookie,
      (name: string) => `${name}=${'x'.repeat(43)}`,
      (name: string) => `${name}=`,
    ];
    for (const header of elsewhere) {
      const sign = started(begin());
      const [name] = sign.cookie.split('=');
      const refused = await service.callback(
        { state: sign.state, code: 'cognito-code' },
        header(name),
      );
      expect(refused).toMatchObject({
        result: 'unbound',
        status: 400,
        json: { error: 'invalid_request' },
      });
      expect(refused.location).toBeUndefined();
      expect(
        (
          await service.callback(
            { state: sign.state, code: 'cognito-code' },
            sign.cookie,
          )
        ).result,
      ).toBe('issued');
    }
    // A Cognito error in another browser is refused too, never relayed.
    const failed = started(begin());
    const relayed = await service.callback(
      { state: failed.state, error: 'access_denied' },
      undefined,
    );
    expect(relayed.result).toBe('unbound');
    expect(relayed.location).toBeUndefined();

    // Two sign-ins in one browser each finish with their own cookie.
    const first = started(begin());
    const second = started(begin());
    const both = `${first.cookie}; ${second.cookie}`;
    expect(
      (await service.callback({ state: second.state, code: 'c' }, both)).result,
    ).toBe('issued');
    expect(
      (await service.callback({ state: first.state, code: 'c' }, both)).result,
    ).toBe('issued');
  });

  it('a refresh passes through to Cognito as the app client, and its failures are reported', async () => {
    const { service, calls } = proxy();
    const refreshed = await service.token({
      grant_type: 'refresh_token',
      refresh_token: 'fictional-refresh',
      client_id: `${PROXY_CLIENT_PREFIX}x`,
    });
    expect(refreshed.result).toBe('passed_through');
    expect(calls[0].get('client_id')).toBe(MCP_SHARED_CLIENT_ID);
    expect(metrics.recordMcpOAuth).toHaveBeenCalledWith(
      'refresh',
      'passed_through',
    );
    service.tokenCall = () =>
      Promise.resolve({ status: 400, body: 'not json' });
    expect((await service.token({ grant_type: 'refresh_token' })).json).toEqual(
      { error: 'server_error' },
    );
    service.tokenCall = () => Promise.reject(new Error('down'));
    expect((await service.token({ grant_type: 'refresh_token' })).result).toBe(
      'upstream_unavailable',
    );
  });

  it('the consent MAC binds the nonce, key and every field', () => {
    const key = Buffer.alloc(32, 7);
    const params = Object.fromEntries(
      CONSENT_FIELDS.map((field) => [field, `v-${field}`]),
    );
    const mac = consentMac(key, 'nonce', params);
    expect(consentMac(key, 'other', params)).not.toBe(mac);
    expect(consentMac(Buffer.alloc(32, 8), 'nonce', params)).not.toBe(mac);
    for (const field of CONSENT_FIELDS)
      expect(
        consentMac(key, 'nonce', { ...params, [field]: 'changed' }),
      ).not.toBe(mac);
    expect(same('abc', 'abc')).toBe(true);
    expect(same('abc', 'abd')).toBe(false);
    expect(same('abc', 'ab')).toBe(false);
    expect(htmlEscape(`<a href='x'>&"`)).toBe(
      '&lt;a href=&#39;x&#39;&gt;&amp;&quot;',
    );
  });
});
