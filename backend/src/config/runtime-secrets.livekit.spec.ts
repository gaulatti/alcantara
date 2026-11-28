import { ConfigService } from '@nestjs/config';
import { loadRuntimeSecrets } from './runtime-secrets';
import { parseRuntimeSecretPayload } from './runtime-secret-contract';
import { WebrtcService } from '../webrtc/webrtc.service';

// gaulatti/alcantara#354: LiveKit and the WebRTC secrets come from the runtime
// secret, all four or none, and the secret is authoritative in production.

const ALANA_TOKEN = 'a'.repeat(64);
const SOURCE_KEYS = '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';
// Fictional values, built here; never real credentials.
const API_SECRET = 'fictional-api-secret-'.padEnd(40, 'x');
const SESSION_SECRET = 'fictional-session-secret-'.padEnd(40, 'y');
const RENDERER_KEY = 'fictional-renderer-key';

const REQUIRED = {
  palazzoAllowedUrls: 'http://palazzo:3100',
  alanaControlToken: ALANA_TOKEN,
  alanaControlUrl: 'http://alana:8080',
  externalSourceConfigCurrentVersion: '1',
  externalSourceConfigKeys: SOURCE_KEYS,
};
const LIVEKIT = {
  livekitWsUrl: 'wss://livekit.example.test',
  livekitApiKey: 'APIfictional',
  livekitApiSecret: API_SECRET,
  webrtcSessionSecret: SESSION_SECRET,
};

function production(extra: Record<string, string> = {}) {
  return {
    NODE_ENV: 'production',
    AWS_REGION: 'us-east-1',
    ALCANTARA_CONFIG_SECRET_ID: 'alcantara/production/config',
    ...extra,
  } as Record<string, string | undefined>;
}

function secret(payload: Record<string, unknown>) {
  return {
    send: jest
      .fn()
      .mockResolvedValue({ SecretString: JSON.stringify(payload) }),
  };
}

function webrtc(environment: Record<string, string | undefined>) {
  return new WebrtcService(
    new ConfigService(environment),
    {} as never,
    {} as never,
  );
}

describe('LiveKit configuration from the runtime secret', () => {
  it('sets the four LiveKit settings and the renderer key from the secret, and WebRTC reports enabled', async () => {
    const environment = production();
    await loadRuntimeSecrets(
      environment,
      secret({
        ...REQUIRED,
        ...LIVEKIT,
        livekitWsUrl: 'wss://livekit.example.test/',
        webrtcRendererKey: RENDERER_KEY,
      }),
    );
    expect(environment).toMatchObject({
      LIVEKIT_WS_URL: 'wss://livekit.example.test',
      LIVEKIT_API_KEY: 'APIfictional',
      LIVEKIT_API_SECRET: API_SECRET,
      WEBRTC_SESSION_SECRET: SESSION_SECRET,
      WEBRTC_RENDERER_KEY: RENDERER_KEY,
    });
    expect(webrtc(environment).getPublicConfig().enabled).toBe(true);
  });

  it('is authoritative: without the group, values left in the container are removed and WebRTC stays off', async () => {
    const environment = production({
      LIVEKIT_WS_URL: 'wss://leftover.example.test',
      LIVEKIT_API_KEY: 'leftover',
      LIVEKIT_API_SECRET: API_SECRET,
      WEBRTC_SESSION_SECRET: SESSION_SECRET,
      WEBRTC_RENDERER_KEY: RENDERER_KEY,
      LIVEKIT_API_URL: 'http://alcantara-livekit:7880',
    });
    await loadRuntimeSecrets(environment, secret(REQUIRED));
    for (const name of [
      'LIVEKIT_WS_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'WEBRTC_SESSION_SECRET',
      'WEBRTC_RENDERER_KEY',
    ]) {
      expect(environment).not.toHaveProperty(name);
    }
    // The internal API address is infrastructure, not a secret: it stays.
    expect(environment.LIVEKIT_API_URL).toBe('http://alcantara-livekit:7880');
    expect(webrtc(environment).getPublicConfig().enabled).toBe(false);
  });

  it('takes the renderer key alone without turning LiveKit on', async () => {
    const environment = production();
    await loadRuntimeSecrets(
      environment,
      secret({ ...REQUIRED, webrtcRendererKey: RENDERER_KEY }),
    );
    expect(environment.WEBRTC_RENDERER_KEY).toBe(RENDERER_KEY);
    expect(webrtc(environment).getPublicConfig().enabled).toBe(false);
  });

  it('takes the fleet key from the secret, and removes one left in the container when the secret has none', async () => {
    const fleet = 'f'.repeat(48);
    const environment = production({ WEBRTC_FLEET_KEY: 'leftover-'.padEnd(40, 'x') });
    await loadRuntimeSecrets(environment, secret({ ...REQUIRED, webrtcFleetKey: fleet }));
    expect(environment.WEBRTC_FLEET_KEY).toBe(fleet);
    const without = production({ WEBRTC_FLEET_KEY: 'leftover-'.padEnd(40, 'x') });
    await loadRuntimeSecrets(without, secret(REQUIRED));
    expect(without).not.toHaveProperty('WEBRTC_FLEET_KEY');
  });

  const INVALID: Array<[string, Record<string, unknown>, string]> = [
    [
      'a partial group',
      { webrtcSessionSecret: undefined },
      'LiveKit needs all of its keys, missing: webrtcSessionSecret',
    ],
    [
      'a ws:// address',
      { livekitWsUrl: 'ws://livekit.example.test' },
      'LIVEKIT_WS_URL must be a wss:// origin',
    ],
    [
      'a path',
      { livekitWsUrl: 'wss://livekit.example.test/rtc' },
      'LIVEKIT_WS_URL must be a wss:// origin',
    ],
    [
      'credentials',
      { livekitWsUrl: 'wss://user:pass@livekit.example.test' },
      'LIVEKIT_WS_URL must be a wss:// origin',
    ],
    [
      'a query',
      { livekitWsUrl: 'wss://livekit.example.test?x=1' },
      'LIVEKIT_WS_URL must be a wss:// origin',
    ],
    [
      'a fragment',
      { livekitWsUrl: 'wss://livekit.example.test#x' },
      'LIVEKIT_WS_URL must be a wss:// origin',
    ],
    [
      'not a URL',
      { livekitWsUrl: 'livekit' },
      'LIVEKIT_WS_URL contains an invalid URL',
    ],
    [
      'an API key with a space',
      { livekitApiKey: 'API fictional' },
      'LIVEKIT_API_KEY is invalid',
    ],
    [
      'a short API secret',
      { livekitApiSecret: 'short' },
      'LIVEKIT_API_SECRET must be at least 32 characters',
    ],
    [
      'an API secret with a space',
      { livekitApiSecret: `${API_SECRET} x` },
      'LIVEKIT_API_SECRET must be at least 32 characters',
    ],
    [
      'a short session secret',
      { webrtcSessionSecret: 'short' },
      'WEBRTC_SESSION_SECRET must be at least 32 characters',
    ],
    [
      'a blank field',
      { livekitApiKey: '   ' },
      'field livekitApiKey is malformed',
    ],
    [
      'a blank renderer key',
      { webrtcRendererKey: '' },
      'field webrtcRendererKey is malformed',
    ],
    [
      'a value that is not a string',
      { livekitApiSecret: 42 },
      'field livekitApiSecret is malformed',
    ],
  ];

  function payloadWith(change: Record<string, unknown>) {
    const payload: Record<string, unknown> = {
      ...REQUIRED,
      ...LIVEKIT,
      ...change,
    };
    for (const [key, value] of Object.entries(change))
      if (value === undefined) delete payload[key];
    return payload;
  }

  it.each(INVALID)(
    'starts with WebRTC off on %s, removing container values and warning by field name only',
    async (_name, change, message) => {
      const environment = production({
        LIVEKIT_WS_URL: 'wss://leftover.example.test',
        LIVEKIT_API_KEY: 'leftover',
        LIVEKIT_API_SECRET: API_SECRET,
        WEBRTC_SESSION_SECRET: SESSION_SECRET,
        WEBRTC_RENDERER_KEY: RENDERER_KEY,
      });
      const warn = jest.fn();
      await expect(
        loadRuntimeSecrets(environment, secret(payloadWith(change)), warn),
      ).resolves.toBeUndefined();
      // The rest of the configuration loaded as usual.
      expect(environment.PALAZZO_ALLOWED_URLS).toBe('http://palazzo:3100');
      for (const name of [
        'LIVEKIT_WS_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'WEBRTC_SESSION_SECRET',
        'WEBRTC_RENDERER_KEY',
      ]) {
        expect(environment).not.toHaveProperty(name);
      }
      expect(webrtc(environment).getPublicConfig().enabled).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = String((warn.mock.calls as string[][])[0][0]);
      expect(warning).toContain('Alcantara WebRTC is disabled');
      expect(warning).toContain(message);
      for (const value of [
        API_SECRET,
        SESSION_SECRET,
        RENDERER_KEY,
        'APIfictional',
      ])
        expect(warning).not.toContain(value);
    },
  );

  it.each(INVALID)(
    'fails the strict contract (the deploy gate and the renderer) on %s',
    (_name, change, message) => {
      expect(() =>
        parseRuntimeSecretPayload(JSON.stringify(payloadWith(change))),
      ).toThrow(message);
    },
  );

  it('warns through the console by default', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await loadRuntimeSecrets(
        production(),
        secret(payloadWith({ livekitApiKey: '   ' })),
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('field livekitApiKey is malformed'),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not warn for a valid group or for none', async () => {
    const warn = jest.fn();
    await loadRuntimeSecrets(
      production(),
      secret({ ...REQUIRED, ...LIVEKIT }),
      warn,
    );
    await loadRuntimeSecrets(production(), secret(REQUIRED), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
